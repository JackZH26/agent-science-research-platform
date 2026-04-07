// ============================================================
// OpenClaw Manager — Multi-instance Gateway lifecycle
// Manages 5 independent OpenClaw gateway processes, one per agent.
// Each agent gets its own profile, port, config, and SOUL.
// ============================================================

import { ChildProcess, spawn, execSync, SpawnOptionsWithoutStdio } from 'child_process';
import * as path from 'path';
import * as http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import { app } from 'electron';
import { EventEmitter } from 'events';

const BASE_PORT = 18801;
const MAX_RESTART_ATTEMPTS = 3;
const HEALTH_POLL_INTERVAL_MS = 15000;

export interface AgentInstance {
  name: string;
  role: string;
  port: number;
  profileName: string;
  profileDir: string;
  process: ChildProcess | null;
  running: boolean;
  startTime: number;
  restartCount: number;
  lastError: string | null;
  pid: number | null;
}

export interface OpenClawStatus {
  installed: boolean;
  version: string | null;
  agents: Array<{
    name: string;
    role: string;
    port: number;
    running: boolean;
    pid: number | null;
    uptime: number;
    error: string | null;
  }>;
  error: string | null;
}

class OpenClawManager extends EventEmitter {
  private instances: Map<string, AgentInstance> = new Map();
  private healthTimer: ReturnType<typeof setInterval> | null = null;
  private version: string | null = null;
  private stopping = false;

  // ---- Binary detection ----

  findBinary(): string | null {
    // 1. Bundled in app resources (extraResources)
    const resourceBin = app.isPackaged
      ? path.join(process.resourcesPath, 'openclaw', 'openclaw.mjs')
      : path.join(app.getAppPath(), 'resources', 'openclaw', 'openclaw.mjs');
    if (fs.existsSync(resourceBin)) return resourceBin;

    // 2. Auto-installed in userData
    const localInstall = path.join(this.getLocalInstallDir(), 'package', 'openclaw.mjs');
    if (fs.existsSync(localInstall)) return localInstall;

    // 3. Local node_modules
    const localBin = path.join(app.getAppPath(), 'node_modules', '.bin', 'openclaw');
    if (fs.existsSync(localBin)) return localBin;

    // 4. System PATH (with extended PATH for macOS GUI apps)
    try {
      const envPath = '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:' + (process.env.PATH || '');
      const cmd = process.platform === 'win32' ? 'where openclaw' : 'which openclaw';
      const result = execSync(cmd, { timeout: 5000, stdio: 'pipe', env: { ...process.env, PATH: envPath } }).toString().trim();
      if (result) return result.split('\n')[0];
    } catch { /* not found */ }

    return null;
  }

  isInstalled(): boolean {
    return this.findBinary() !== null;
  }

  detectVersion(): string | null {
    const bin = this.findBinary();
    if (!bin) return null;
    try {
      const result = execSync(`"${bin}" --version`, { timeout: 5000, stdio: 'pipe' }).toString().trim();
      this.version = result;
      return result;
    } catch { return null; }
  }

  // ---- Profile management ----

  getProfileDir(agentName: string): string {
    const safeName = agentName.toLowerCase().replace(/[^a-z0-9]/g, '');
    return path.join(os.homedir(), `.openclaw-asrp-${safeName}`);
  }

  getConfigPath(agentName: string): string {
    return path.join(this.getProfileDir(agentName), 'openclaw.json');
  }

  getPortForAgent(index: number): number {
    return BASE_PORT + index;
  }

  // ---- Instance lifecycle ----

  /**
   * Register an agent (call before start). Does not start the gateway.
   */
  registerAgent(name: string, role: string, index: number): void {
    if (this.instances.has(name)) return;
    const port = this.getPortForAgent(index);
    const profileName = `asrp-${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    this.instances.set(name, {
      name,
      role,
      port,
      profileName,
      profileDir: this.getProfileDir(name),
      process: null,
      running: false,
      startTime: 0,
      restartCount: 0,
      lastError: null,
      pid: null,
    });
  }

  /**
   * Start a single agent's gateway
   */
  async startAgent(name: string): Promise<{ success: boolean; error?: string }> {
    const inst = this.instances.get(name);
    if (!inst) return { success: false, error: `Agent ${name} not registered` };
    if (inst.running) return { success: true };

    const bin = this.findBinary();
    if (!bin) return { success: false, error: 'OpenClaw not installed' };

    const configPath = this.getConfigPath(name);
    if (!fs.existsSync(configPath)) {
      return { success: false, error: `Config not found for ${name}` };
    }

    inst.lastError = null;

    try {
      const env = {
        ...process.env,
        OPENCLAW_STATE_DIR: inst.profileDir,
        OPENCLAW_CONFIG_PATH: configPath,
      };

      inst.process = spawn(bin, [
        '--profile', inst.profileName,
        'gateway',
        '--port', String(inst.port),
      ], {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      } as SpawnOptionsWithoutStdio);

      inst.startTime = Date.now();
      inst.pid = inst.process.pid ?? null;

      if (inst.process.stdout) {
        inst.process.stdout.on('data', (data: Buffer) => {
          this.emit('log', { agent: name, level: 'info', message: data.toString().trim() });
        });
      }
      if (inst.process.stderr) {
        inst.process.stderr.on('data', (data: Buffer) => {
          this.emit('log', { agent: name, level: 'error', message: data.toString().trim() });
        });
      }

      inst.process.on('close', (code) => {
        inst.running = false;
        inst.process = null;
        inst.pid = null;
        this.emit('agent-stopped', { name, code });

        if (!this.stopping && code !== 0 && inst.restartCount < MAX_RESTART_ATTEMPTS) {
          inst.restartCount++;
          inst.lastError = `Exited with code ${code}, restarting (${inst.restartCount}/${MAX_RESTART_ATTEMPTS})`;
          setTimeout(() => this.startAgent(name), 2000);
        } else if (code !== 0) {
          inst.lastError = `Exited with code ${code}`;
        }
      });

      inst.process.on('error', (err) => {
        inst.running = false;
        inst.lastError = err.message;
      });

      // Wait for health
      const healthy = await this.waitForHealth(inst.port, 15000);
      if (healthy) {
        inst.running = true;
        inst.restartCount = 0;
        this.emit('agent-started', { name, port: inst.port });
        return { success: true };
      } else {
        inst.lastError = `Gateway did not become healthy within 15s`;
        this.stopAgent(name);
        return { success: false, error: inst.lastError };
      }
    } catch (err) {
      inst.lastError = err instanceof Error ? err.message : String(err);
      return { success: false, error: inst.lastError };
    }
  }

  /**
   * Start all registered agents
   */
  async startAll(): Promise<{ results: Array<{ name: string; success: boolean; error?: string }> }> {
    this.stopping = false;
    if (!this.version) this.detectVersion();

    const results: Array<{ name: string; success: boolean; error?: string }> = [];
    for (const [name] of this.instances) {
      const res = await this.startAgent(name);
      results.push({ name, ...res });
    }

    this.startHealthPolling();
    return { results };
  }

  /**
   * Stop a single agent
   */
  stopAgent(name: string): void {
    const inst = this.instances.get(name);
    if (!inst) return;
    if (inst.process) {
      try { inst.process.kill('SIGTERM'); } catch { /* already dead */ }
      inst.process = null;
    }
    inst.running = false;
    inst.pid = null;
  }

  /**
   * Stop all agents
   */
  stopAll(): void {
    this.stopping = true;
    this.stopHealthPolling();
    for (const [name] of this.instances) {
      this.stopAgent(name);
    }
  }

  /**
   * Restart a single agent
   */
  async restartAgent(name: string): Promise<{ success: boolean; error?: string }> {
    this.stopAgent(name);
    await new Promise(resolve => setTimeout(resolve, 1000));
    const inst = this.instances.get(name);
    if (inst) inst.restartCount = 0;
    return this.startAgent(name);
  }

  // ---- Status ----

  getStatus(): OpenClawStatus {
    const agents = Array.from(this.instances.values()).map(inst => ({
      name: inst.name,
      role: inst.role,
      port: inst.port,
      running: inst.running,
      pid: inst.pid,
      uptime: inst.running ? Math.round((Date.now() - inst.startTime) / 1000) : 0,
      error: inst.lastError,
    }));

    return {
      installed: this.isInstalled(),
      version: this.version,
      agents,
      error: null,
    };
  }

  getAgentInstance(name: string): AgentInstance | undefined {
    return this.instances.get(name);
  }

  // ---- HTTP helpers ----

  async apiGet(port: number, apiPath: string, timeoutMs = 5000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = http.get({
        hostname: '127.0.0.1',
        port,
        path: apiPath,
        timeout: timeoutMs,
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
  }

  private async waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await this.apiGet(port, '/health', 2000) as Record<string, unknown>;
        if (res && (res.status === 'ok' || res.ok === true)) return true;
      } catch { /* not ready */ }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
  }

  private startHealthPolling(): void {
    this.stopHealthPolling();
    this.healthTimer = setInterval(async () => {
      for (const [, inst] of this.instances) {
        if (!inst.running) continue;
        try {
          await this.apiGet(inst.port, '/health', 3000);
        } catch {
          inst.running = false;
          inst.pid = null;
          this.emit('agent-unhealthy', { name: inst.name });
        }
      }
    }, HEALTH_POLL_INTERVAL_MS);
  }

  private stopHealthPolling(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }

  // ---- Install ----

  /**
   * Get the local install directory for OpenClaw
   */
  getLocalInstallDir(): string {
    return path.join(app.getPath('userData'), 'openclaw');
  }

  /**
   * Install OpenClaw by downloading npm tarball directly.
   * No npm CLI required. Works in sandboxed Electron apps.
   */
  async install(onProgress?: (msg: string) => void): Promise<{ success: boolean; error?: string }> {
    const installDir = this.getLocalInstallDir();
    const binPath = path.join(installDir, 'package', 'openclaw.mjs');

    try {
      if (onProgress) onProgress('Fetching package info...');

      // 1. Get tarball URL from npm registry
      const https = require('https') as typeof import('https');
      const tarballUrl = await new Promise<string>((resolve, reject) => {
        https.get('https://registry.npmjs.org/openclaw/latest', (res: import('http').IncomingMessage) => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c.toString(); });
          res.on('end', () => {
            try {
              const pkg = JSON.parse(data);
              resolve(pkg.dist?.tarball || '');
            } catch { reject(new Error('Failed to parse npm registry response')); }
          });
        }).on('error', reject);
      });

      if (!tarballUrl) return { success: false, error: 'Could not find openclaw tarball URL' };

      if (onProgress) onProgress('Downloading OpenClaw...');

      // 2. Download tarball to temp file
      const tmpDir = path.join(app.getPath('temp'), 'asrp-openclaw-install');
      fs.mkdirSync(tmpDir, { recursive: true });
      const tarPath = path.join(tmpDir, 'openclaw.tgz');

      await new Promise<void>((resolve, reject) => {
        const follow = (url: string) => {
          https.get(url, (res: import('http').IncomingMessage) => {
            // Follow redirects
            if (res.statusCode === 301 || res.statusCode === 302) {
              const loc = res.headers.location;
              if (loc) { follow(loc); return; }
            }
            const file = fs.createWriteStream(tarPath);
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(); });
          }).on('error', reject);
        };
        follow(tarballUrl);
      });

      if (onProgress) onProgress('Extracting...');

      // 3. Extract tarball using tar (available on macOS/Linux)
      //    On Windows, use built-in tar (available since Win10 1803)
      fs.mkdirSync(installDir, { recursive: true });

      await new Promise<void>((resolve, reject) => {
        const tar = spawn('tar', ['xzf', tarPath, '-C', installDir], {
          stdio: 'pipe',
        });
        tar.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error('tar extract failed with code ' + code));
        });
        tar.on('error', reject);
      });

      // 4. Install dependencies (openclaw needs them)
      if (onProgress) onProgress('Installing dependencies...');
      const pkgDir = path.join(installDir, 'package');

      // Find npm binary - check common locations
      let npmBin = '';
      const npmPaths = [
        '/usr/local/bin/npm',
        '/opt/homebrew/bin/npm',
        path.join(os.homedir(), '.nvm/versions/node', 'npm'), // nvm
        'npm', // PATH fallback
      ];
      for (const p of npmPaths) {
        try {
          execSync(`"${p}" --version`, { timeout: 3000, stdio: 'pipe' });
          npmBin = p;
          break;
        } catch { /* try next */ }
      }

      if (npmBin) {
        await new Promise<void>((resolve) => {
          const npmInstall = spawn(npmBin, ['install', '--production', '--no-optional'], {
            cwd: pkgDir,
            stdio: 'pipe',
            shell: true,
            env: { ...process.env, PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:' + (process.env.PATH || '') },
          });
          npmInstall.on('close', () => resolve());
          npmInstall.on('error', () => resolve()); // non-fatal
          setTimeout(() => { try { npmInstall.kill(); } catch {} resolve(); }, 120000);
        });
      }

      // 5. Verify
      if (fs.existsSync(binPath)) {
        if (onProgress) onProgress('OpenClaw installed successfully!');
        // Clear cached binary path
        this.detectVersion();
        return { success: true };
      } else {
        return { success: false, error: 'Installation completed but binary not found' };
      }

    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export const openclawManager = new OpenClawManager();
