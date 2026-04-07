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

  /**
   * Build a comprehensive PATH that includes common Node.js install locations.
   * macOS GUI apps have minimal PATH, so we must add brew, nvm, etc.
   */
  private getExtendedPath(): string {
    const extra: string[] = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/usr/bin',
      '/bin',
    ];
    // Add nvm current version bin dir
    const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
    try {
      const nodeVersions = path.join(nvmDir, 'versions', 'node');
      if (fs.existsSync(nodeVersions)) {
        // Find the latest installed node version
        const versions = fs.readdirSync(nodeVersions)
          .filter(v => v.startsWith('v'))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        if (versions.length > 0) {
          extra.push(path.join(nodeVersions, versions[0], 'bin'));
        }
      }
    } catch { /* ignore */ }
    return extra.join(':') + ':' + (process.env.PATH || '');
  }

  /**
   * Find a working `node` executable. Needed to run openclaw.mjs reliably
   * (shebang resolution is unreliable in packaged GUI apps on macOS).
   */
  private findNode(): string | null {
    // 1. nvm-installed node (most common for developers)
    const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
    try {
      const nodeVersions = path.join(nvmDir, 'versions', 'node');
      if (fs.existsSync(nodeVersions)) {
        const versions = fs.readdirSync(nodeVersions)
          .filter(v => v.startsWith('v'))
          .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        for (const ver of versions) {
          const nodeBin = path.join(nodeVersions, ver, 'bin', 'node');
          if (fs.existsSync(nodeBin)) return nodeBin;
        }
      }
    } catch { /* ignore */ }

    // 2. Common system paths
    for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
      if (fs.existsSync(p)) return p;
    }

    // 3. which node (with extended PATH)
    try {
      const result = execSync('which node', {
        timeout: 3000, stdio: 'pipe',
        env: { ...process.env, PATH: this.getExtendedPath() },
      }).toString().trim();
      if (result) return result;
    } catch { /* not found */ }

    return null;
  }

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
      const cmd = process.platform === 'win32' ? 'where openclaw' : 'which openclaw';
      const result = execSync(cmd, {
        timeout: 5000, stdio: 'pipe',
        env: { ...process.env, PATH: this.getExtendedPath() },
      }).toString().trim();
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

  /**
   * Kill any stale process listening on the given port.
   * This prevents port conflicts when restarting after a crash or unclean exit.
   */
  private killProcessOnPort(port: number): void {
    try {
      // lsof finds the PID of whatever is listening on this port
      const cmd = process.platform === 'win32'
        ? `netstat -ano | findstr :${port}`
        : `lsof -ti TCP:${port} -sTCP:LISTEN`;
      const output = execSync(cmd, { timeout: 3000, stdio: 'pipe' }).toString().trim();
      if (output) {
        const pids = output.split('\n').map(s => parseInt(s.trim(), 10)).filter(n => n > 0);
        for (const pid of pids) {
          // Don't kill ourselves
          if (pid === process.pid) continue;
          console.log(`[OpenClaw] Killing stale process ${pid} on port ${port}`);
          try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
        }
        // Brief wait for process to die
        if (pids.length > 0) {
          try { execSync('sleep 1', { timeout: 2000, stdio: 'ignore' }); } catch { /* ignore */ }
        }
      }
    } catch { /* no process on this port — good */ }
  }

  // ---- Instance lifecycle ----

  /**
   * Load and register agents from settings.json (for app restart)
   */
  loadAgentsFromSettings(): void {
    try {
      const settingsPath = path.join(app.getPath('userData'), 'settings.json');
      if (!fs.existsSync(settingsPath)) return;
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const configs = settings.agentConfigs as Array<{ agentId?: string; role?: string }> | undefined;
      if (!Array.isArray(configs)) return;
      configs.forEach((cfg, idx) => {
        if (cfg && cfg.agentId) {
          this.registerAgent(cfg.agentId, cfg.role || 'Assistant', idx);
        }
      });
    } catch { /* ignore */ }
  }

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
   * Start a single agent's gateway.
   *
   * Uses explicit `node` to run openclaw.mjs instead of relying on shebang,
   * because macOS GUI apps have minimal PATH and shebang resolution is unreliable.
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

    // For .mjs files, we need an explicit node binary (shebang is unreliable in GUI apps)
    let nodeBin: string | null = null;
    const isMjs = bin.endsWith('.mjs') || bin.endsWith('.js');
    if (isMjs) {
      nodeBin = this.findNode();
      if (!nodeBin) {
        const errMsg = 'Cannot find Node.js to run OpenClaw. Install Node.js >= 20 or add it to PATH.';
        console.error(`[OpenClaw] ${errMsg}`);
        inst.lastError = errMsg;
        return { success: false, error: errMsg };
      }
      console.log(`[OpenClaw] Using node: ${nodeBin}`);
    }

    console.log(`[OpenClaw] Starting ${name}: bin=${bin}, port=${inst.port}`);
    inst.lastError = null;

    // Kill any stale process on this port from a previous unclean exit
    this.killProcessOnPort(inst.port);

    // Collect early stderr output for error diagnosis
    let earlyStderr = '';

    try {
      // Load .env file from profile dir to inject Discord token + API keys
      const envFromFile: Record<string, string> = {};
      const envFilePath = path.join(inst.profileDir, '.env');
      try {
        if (fs.existsSync(envFilePath)) {
          const lines = fs.readFileSync(envFilePath, 'utf-8').split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx > 0) {
              envFromFile[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
            }
          }
        }
      } catch { /* ignore .env read errors */ }

      const env = {
        ...process.env,
        ...envFromFile,
        OPENCLAW_STATE_DIR: inst.profileDir,
        OPENCLAW_CONFIG_PATH: configPath,
        PATH: this.getExtendedPath(),
      };

      // Build spawn command: use explicit node for .mjs files
      const spawnCmd = isMjs && nodeBin ? nodeBin : bin;
      const spawnArgs = isMjs && nodeBin
        ? [bin, '--profile', inst.profileName, 'gateway', '--port', String(inst.port)]
        : ['--profile', inst.profileName, 'gateway', '--port', String(inst.port)];

      inst.process = spawn(spawnCmd, spawnArgs, {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env,
      } as SpawnOptionsWithoutStdio);

      inst.startTime = Date.now();
      inst.pid = inst.process.pid ?? null;
      console.log(`[OpenClaw] ${name} spawned with PID ${inst.pid}`);

      if (inst.process.stdout) {
        inst.process.stdout.on('data', (data: Buffer) => {
          const msg = data.toString().trim();
          console.log(`[OpenClaw:${name}:stdout] ${msg}`);
          this.emit('log', { agent: name, level: 'info', message: msg });
        });
      }
      if (inst.process.stderr) {
        inst.process.stderr.on('data', (data: Buffer) => {
          const msg = data.toString().trim();
          console.error(`[OpenClaw:${name}:stderr] ${msg}`);
          // Capture early stderr for error diagnosis
          if (earlyStderr.length < 2000) earlyStderr += msg + '\n';
          this.emit('log', { agent: name, level: 'error', message: msg });
        });
      }

      inst.process.on('close', (code) => {
        console.log(`[OpenClaw] ${name} exited with code ${code}`);
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
        console.error(`[OpenClaw] ${name} spawn error:`, err.message);
        inst.running = false;
        inst.lastError = err.message;
      });

      // Wait for health (increased to 20s — first start can be slow)
      const healthy = await this.waitForHealth(inst.port, 20000);
      if (healthy) {
        inst.running = true;
        inst.restartCount = 0;
        console.log(`[OpenClaw] ${name} is healthy on port ${inst.port}`);
        this.emit('agent-started', { name, port: inst.port });
        return { success: true };
      } else {
        // Include early stderr in error message for diagnosis
        const detail = earlyStderr.trim()
          ? `\nProcess output:\n${earlyStderr.trim().slice(0, 500)}`
          : '';
        inst.lastError = `Gateway did not become healthy within 20s` + detail;
        console.error(`[OpenClaw] ${name} failed health check. stderr: ${earlyStderr.trim().slice(0, 500)}`);
        this.stopAgent(name);
        return { success: false, error: inst.lastError };
      }
    } catch (err) {
      inst.lastError = err instanceof Error ? err.message : String(err);
      console.error(`[OpenClaw] ${name} start exception:`, inst.lastError);
      return { success: false, error: inst.lastError };
    }
  }

  /**
   * Start all registered agents
   */
  async startAll(): Promise<{ results: Array<{ name: string; success: boolean; error?: string }> }> {
    this.stopping = false;
    if (!this.version) this.detectVersion();

    // Auto-load agents from settings if none registered
    if (this.instances.size === 0) {
      this.loadAgentsFromSettings();
    }

    if (this.instances.size === 0) {
      return { results: [{ name: 'all', success: false, error: 'No agents configured. Complete setup first.' }] };
    }

    const results: Array<{ name: string; success: boolean; error?: string }> = [];
    for (const [name] of this.instances) {
      const res = await this.startAgent(name);
      results.push({ name, ...res });
    }

    this.startHealthPolling();
    return { results };
  }

  /**
   * Stop a single agent. Properly cleans up the child process so it doesn't
   * hold event loop references that prevent app.quit() from completing.
   */
  stopAgent(name: string): void {
    const inst = this.instances.get(name);
    if (!inst) return;
    if (inst.process) {
      const proc = inst.process;

      // Remove all listeners to prevent restart-on-close logic
      proc.removeAllListeners('close');
      proc.removeAllListeners('error');

      // Destroy stdio streams to release event loop references
      try { proc.stdout?.destroy(); } catch { /* ignore */ }
      try { proc.stderr?.destroy(); } catch { /* ignore */ }
      try { proc.stdin?.destroy(); } catch { /* ignore */ }

      // Send SIGTERM, then SIGKILL after 2s if still alive
      try { proc.kill('SIGTERM'); } catch { /* already dead */ }
      setTimeout(() => {
        try {
          if (!proc.killed) proc.kill('SIGKILL');
        } catch { /* already dead */ }
      }, 2000).unref();

      // Unref so this child process doesn't prevent app.quit()
      try { proc.unref(); } catch { /* ignore */ }

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

      // Find npm binary — scan nvm versions, brew, system
      let npmBin = '';
      const npmCandidates: string[] = [
        '/usr/local/bin/npm',
        '/opt/homebrew/bin/npm',
      ];

      // Add nvm npm paths (scan all installed node versions, newest first)
      const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), '.nvm');
      try {
        const nodeVersionsDir = path.join(nvmDir, 'versions', 'node');
        if (fs.existsSync(nodeVersionsDir)) {
          const versions = fs.readdirSync(nodeVersionsDir)
            .filter(v => v.startsWith('v'))
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
          for (const ver of versions) {
            npmCandidates.push(path.join(nodeVersionsDir, ver, 'bin', 'npm'));
          }
        }
      } catch { /* ignore */ }

      npmCandidates.push('npm'); // PATH fallback (last resort)

      for (const p of npmCandidates) {
        try {
          execSync(`"${p}" --version`, { timeout: 5000, stdio: 'pipe' });
          npmBin = p;
          console.log(`[OpenClaw] Found npm: ${p}`);
          break;
        } catch { /* try next */ }
      }

      if (npmBin) {
        const extendedPath = this.getExtendedPath();
        let npmStderr = '';
        const npmExitCode = await new Promise<number>((resolve) => {
          const npmInstall = spawn(npmBin, ['install', '--omit=dev'], {
            cwd: pkgDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: true,
            env: { ...process.env, PATH: extendedPath },
          });
          npmInstall.stderr?.on('data', (d: Buffer) => { npmStderr += d.toString(); });
          npmInstall.on('close', (code) => resolve(code ?? 1));
          npmInstall.on('error', (err) => {
            console.error('[OpenClaw] npm install error:', err.message);
            resolve(1);
          });
          // Timeout after 3 minutes
          setTimeout(() => { try { npmInstall.kill(); } catch {} resolve(1); }, 180000);
        });

        if (npmExitCode !== 0) {
          console.warn(`[OpenClaw] npm install exited with code ${npmExitCode}`);
          if (npmStderr) console.warn(`[OpenClaw] npm stderr: ${npmStderr.slice(0, 500)}`);
        } else {
          console.log('[OpenClaw] npm install completed successfully');
        }
      } else {
        console.warn('[OpenClaw] npm not found — dependencies not installed');
      }

      // 5. Verify by actually running it with a real node (not Electron's node)
      if (fs.existsSync(binPath)) {
        const nodeExe = this.findNode() || process.execPath;
        try {
          const versionOut = execSync(`"${nodeExe}" "${binPath}" --version`, {
            timeout: 10000,
            stdio: 'pipe',
            env: { ...process.env, PATH: this.getExtendedPath() },
          }).toString().trim();
          if (onProgress) onProgress('OpenClaw ' + versionOut + ' installed!');
          this.version = versionOut;
          console.log(`[OpenClaw] Verified: ${versionOut}`);
          return { success: true };
        } catch (verifyErr) {
          // Binary exists but can't run — likely missing dependencies
          const errMsg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
          console.error('[OpenClaw] Verification failed:', errMsg);
          if (onProgress) onProgress('Downloaded but verification failed — retrying npm install...');

          // Retry: try npm install again with --force
          if (npmBin) {
            try {
              execSync(`"${npmBin}" install --omit=dev --force`, {
                cwd: pkgDir, timeout: 180000, stdio: 'pipe',
                env: { ...process.env, PATH: this.getExtendedPath() },
              });
              // Re-verify
              const retryOut = execSync(`"${nodeExe}" "${binPath}" --version`, {
                timeout: 10000, stdio: 'pipe',
                env: { ...process.env, PATH: this.getExtendedPath() },
              }).toString().trim();
              this.version = retryOut;
              if (onProgress) onProgress('OpenClaw ' + retryOut + ' installed!');
              return { success: true };
            } catch { /* fall through to error */ }
          }

          return {
            success: false,
            error: 'OpenClaw downloaded but cannot run (missing dependencies). '
              + 'Please install manually: npm install -g openclaw\n'
              + 'Detail: ' + errMsg.slice(0, 200),
          };
        }
      } else {
        return { success: false, error: 'Installation completed but binary not found' };
      }

    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}

export const openclawManager = new OpenClawManager();
