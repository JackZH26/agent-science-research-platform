// ============================================================
// TOOL INSTALLER — cross-platform tool detection & installation
//
// Supports: pip, system (brew/apt/winget/choco), cargo, clawhub,
// manual (returns instructions only).
//
// Design: global install for pip/system tools (shared by all
// agents), per-profile install for clawhub skills.
//
// Progress events are emitted to the renderer via mainWindow
// webContents.send('tools:install-progress', { toolId, ... }).
// ============================================================

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { BrowserWindow } from 'electron';
import { RESOURCES_PATH, getWorkspaceBase } from './ipc-handlers';
import { appendAudit } from './audit-store';

// ---- Types ----

export interface ToolEntry {
  id: string;
  name: string;
  category: string;
  priority: 'required' | 'highly-recommended' | 'recommended' | 'optional';
  version: string;
  description: string;
  descriptionZh?: string;
  agents: string[];
  installType: 'pip' | 'system' | 'cargo' | 'clawhub' | 'manual';
  installPackage?: string;
  installCommands?: Record<string, string[]>;
  manualInstructions?: Record<string, string>;
  checkCommand: string;
  homepage: string;
  tags: string[];
}

export interface ToolStatus {
  id: string;
  installed: boolean;
  version?: string;
  error?: string;
}

export interface InstallResult {
  success: boolean;
  version?: string;
  error?: string;
  manual?: boolean;
  instructions?: string;
  output?: string;
}

// ---- Registry ----

let registryCache: { categories: Array<{ id: string; name: string; nameZh: string }>; tools: ToolEntry[] } | null = null;

export function loadRegistry(): { categories: Array<{ id: string; name: string; nameZh: string }>; tools: ToolEntry[] } {
  if (registryCache) return registryCache;
  const regPath = path.join(RESOURCES_PATH, 'agents', 'tools', 'tools-registry.json');
  try {
    const raw = JSON.parse(fs.readFileSync(regPath, 'utf-8'));
    registryCache = raw;
    return raw;
  } catch (e) {
    console.warn('[tool-installer] failed to load registry:', e);
    return { categories: [], tools: [] };
  }
}

// ---- Detection ----

function runCheck(command: string, timeoutMs = 10000): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const shell = isWin ? 'cmd.exe' : '/bin/sh';
    const args = isWin ? ['/c', command] : ['-c', command];

    let stdout = '';
    let done = false;

    const child = spawn(shell, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: { ...process.env, PATH: buildPath() },
    });

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', () => { /* ignore */ });

    child.on('close', (code) => {
      if (done) return;
      done = true;
      resolve({ ok: code === 0, stdout: stdout.trim() });
    });

    child.on('error', () => {
      if (done) return;
      done = true;
      resolve({ ok: false, stdout: '' });
    });

    setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, stdout: '' });
    }, timeoutMs);
  });
}

/** Check if a single tool is installed; parse version from stdout. */
export async function checkTool(tool: ToolEntry): Promise<ToolStatus> {
  try {
    const { ok, stdout } = await runCheck(tool.checkCommand);
    if (!ok) return { id: tool.id, installed: false };
    // Try to extract version from output (first line, strip prefixes)
    const version = extractVersion(stdout);
    return { id: tool.id, installed: true, version: version || undefined };
  } catch (e) {
    return { id: tool.id, installed: false, error: String(e) };
  }
}

/** Check all tools in the registry. */
export async function checkAllTools(): Promise<ToolStatus[]> {
  const { tools } = loadRegistry();
  // Run checks in parallel (capped at 8 concurrent)
  const results: ToolStatus[] = [];
  const concurrency = 8;
  let index = 0;

  async function worker() {
    while (index < tools.length) {
      const tool = tools[index++];
      results.push(await checkTool(tool));
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tools.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ---- Installation ----

export async function installTool(tool: ToolEntry): Promise<InstallResult> {
  const platform = process.platform as 'darwin' | 'linux' | 'win32';

  sendProgress(tool.id, 'installing', `Installing ${tool.name}...`);

  let result: InstallResult;

  switch (tool.installType) {
    case 'pip':
      result = await installViaPip(tool);
      break;
    case 'system':
      result = await installViaSystem(tool, platform);
      break;
    case 'cargo':
      result = await installViaCargo(tool);
      break;
    case 'clawhub':
      result = await installViaClawHub(tool);
      break;
    case 'manual':
      result = {
        success: false,
        manual: true,
        instructions: tool.manualInstructions?.[platform]
          || tool.manualInstructions?.['darwin']
          || `Visit ${tool.homepage} for installation instructions.`,
      };
      break;
    default:
      result = { success: false, error: `Unknown install type: ${tool.installType}` };
  }

  if (result.success) {
    // Verify installation
    const status = await checkTool(tool);
    result.version = status.version;

    // Update agent TOOLS.md
    try { updateAgentToolsMd(tool); } catch (e) {
      console.warn('[tool-installer] TOOLS.md update failed:', e);
    }

    sendProgress(tool.id, 'installed', `${tool.name} installed successfully`);

    appendAudit({
      type: 'config',
      agent: 'System',
      message: `Installed tool: ${tool.name}${result.version ? ' v' + result.version : ''} (${tool.installType})`,
    });
  } else if (!result.manual) {
    sendProgress(tool.id, 'error', result.error || 'Installation failed');

    appendAudit({
      type: 'config',
      agent: 'System',
      message: `Tool install failed: ${tool.name} — ${result.error || 'unknown error'}`,
      severity: 'warn',
    });
  }

  return result;
}

// ---- Install helpers ----

async function installViaPip(tool: ToolEntry): Promise<InstallResult> {
  const pkg = tool.installPackage || tool.id;
  return runInstallCommand('python3', ['-m', 'pip', 'install', '--upgrade', pkg], tool.id);
}

async function installViaSystem(tool: ToolEntry, platform: string): Promise<InstallResult> {
  const cmds = tool.installCommands;
  if (!cmds || !cmds[platform]) {
    return { success: false, error: `No install command for platform: ${platform}` };
  }
  const [cmd, ...args] = cmds[platform];
  // 'echo' commands are informational, not actual installs
  if (cmd === 'echo') {
    return { success: false, manual: true, instructions: args.join(' ') };
  }
  return runInstallCommand(cmd, args, tool.id);
}

async function installViaCargo(tool: ToolEntry): Promise<InstallResult> {
  const pkg = tool.installPackage || tool.id;
  return runInstallCommand('cargo', ['install', pkg], tool.id);
}

async function installViaClawHub(tool: ToolEntry): Promise<InstallResult> {
  const pkg = tool.installPackage || tool.id;
  return runInstallCommand('clawhub', ['install', pkg], tool.id);
}

function runInstallCommand(cmd: string, args: string[], toolId: string, timeoutMs = 300000): Promise<InstallResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    let stdout = '';
    let stderr = '';
    let done = false;

    let child: ChildProcess;
    try {
      child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: buildPath() },
        shell: isWin,
      });
    } catch (e) {
      resolve({ success: false, error: `Failed to spawn ${cmd}: ${e}` });
      return;
    }

    child.stdout?.on('data', (d: Buffer) => {
      const line = d.toString();
      stdout += line;
      sendProgress(toolId, 'installing', line.trim().slice(0, 200));
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    child.on('close', (code) => {
      if (done) return;
      done = true;
      if (code === 0) {
        resolve({ success: true, output: stdout });
      } else {
        resolve({
          success: false,
          error: stderr.trim().slice(0, 500) || `${cmd} exited with code ${code}`,
          output: stdout,
        });
      }
    });

    child.on('error', (e) => {
      if (done) return;
      done = true;
      resolve({ success: false, error: `${cmd} not found or failed: ${e.message}` });
    });

    // 5-minute timeout to prevent hanging installs
    setTimeout(() => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve({ success: false, error: `Installation timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);
  });
}

// ---- TOOLS.md generation ----

function updateAgentToolsMd(tool: ToolEntry): void {
  const ws = getWorkspaceBase();
  const roles = tool.agents || [];

  for (const role of roles) {
    const toolsMdPath = path.join(ws, 'system', `agent-${role}`, 'TOOLS.md');
    if (!fs.existsSync(path.dirname(toolsMdPath))) continue;

    let content = '';
    try {
      if (fs.existsSync(toolsMdPath)) {
        content = fs.readFileSync(toolsMdPath, 'utf-8');
      }
    } catch { /* start fresh */ }

    // Check if tool is already documented
    if (content.includes(`**${tool.name}**`)) continue;

    // If file is the default OpenClaw template, replace it
    if (!content.includes('## Installed Tools') && !content.includes('## Required Tools')) {
      content = `# Tools Available to ${capitalize(role)}\n\nThis file is auto-managed by ASRP. Do not edit the Installed Tools section manually.\n\n## Installed Tools\n\n`;
    }

    // Append tool entry
    const entry = `- **${tool.name}** (${tool.installType}) — ${tool.description}\n  Install: \`${tool.installPackage || tool.id}\` | Homepage: ${tool.homepage}\n`;

    if (content.includes('## Installed Tools')) {
      content = content.replace('## Installed Tools\n', '## Installed Tools\n' + entry);
    } else {
      content += '\n## Installed Tools\n' + entry;
    }

    fs.writeFileSync(toolsMdPath, content, 'utf-8');
  }
}

// ---- Utilities ----

function extractVersion(stdout: string): string | null {
  // Common patterns: "1.3.0", "git version 2.42.0", "v0.15.0"
  const m = stdout.match(/(\d+\.\d+(?:\.\d+)?(?:[-+.]\w+)?)/);
  return m ? m[1] : null;
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/** Build PATH with common tool locations so spawned processes can find them. */
function buildPath(): string {
  const env = process.env.PATH || '';
  const extras: string[] = [];
  if (process.platform === 'darwin') {
    extras.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin');
    // cargo
    const home = process.env.HOME || '';
    if (home) extras.push(path.join(home, '.cargo', 'bin'));
    // elan (Lean)
    if (home) extras.push(path.join(home, '.elan', 'bin'));
  } else if (process.platform === 'linux') {
    extras.push('/usr/local/bin', '/usr/bin', '/bin', '/snap/bin');
    const home = process.env.HOME || '';
    if (home) {
      extras.push(path.join(home, '.cargo', 'bin'));
      extras.push(path.join(home, '.elan', 'bin'));
      extras.push(path.join(home, '.local', 'bin'));
    }
  }
  return [...extras, env].join(path.delimiter);
}

function sendProgress(toolId: string, status: string, message: string): void {
  try {
    const wins = BrowserWindow.getAllWindows();
    for (const w of wins) {
      if (!w.isDestroyed()) {
        w.webContents.send('tools:install-progress', { toolId, status, message });
      }
    }
  } catch { /* ignore */ }
}
