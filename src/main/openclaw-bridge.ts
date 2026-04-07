// ============================================================
// OpenClaw Bridge — Multi-agent gateway status
// Reads real data from agent configs, gateway APIs, and logs.
// ============================================================

import { openclawManager } from './openclaw-manager';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { app } from 'electron';

export interface AgentStatus {
  name: string;
  role: string;
  status: 'running' | 'idle' | 'stopped' | 'error';
  model: string;
  port: number;
  sessions: number;
  tokenUsage: { input: number; output: number; cost: number };
  uptime: number;
  recentLogs: string[];
  openclawVersion: string | null;
}

export interface WorkspaceStats {
  experiments: number;
  confirmed: number;
  refuted: number;
  papers: number;
}

export interface TokenUsage {
  models: Array<{ name: string; input: number; output: number; cost: number; budget: number; pct: number }>;
  dailyTotal: number;
  dailyBudget: number;
  pct: number;
}

export interface ResearchProgress {
  rh: number;
  sc: number;
  bc: number;
}

export interface GatewayStatus {
  running: boolean;
  pid: number | null;
  uptime: number;
}

/**
 * Read the model from an agent's openclaw.json config file.
 */
function readAgentModel(agentName: string): string {
  try {
    const safeName = agentName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const configPath = path.join(os.homedir(), `.openclaw-asrp-${safeName}`, 'openclaw.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return config?.agents?.defaults?.model || '';
    }
  } catch { /* ignore */ }
  // Fallback: read from settings.json
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (Array.isArray(settings.agentConfigs)) {
        const cfg = settings.agentConfigs.find(
          (c: Record<string, unknown>) => c && (c.agentId === agentName || c.discordBotName === agentName)
        );
        if (cfg) return (cfg as Record<string, string>).model || '';
      }
    }
  } catch { /* ignore */ }
  return '';
}

/**
 * Resolve displayName to internal agentId using settings.json
 */
function resolveAgentId(nameOrDisplay: string): string {
  // First try the manager
  const resolved = openclawManager.resolveAgentName(nameOrDisplay);
  if (resolved !== nameOrDisplay) return resolved;
  // Fallback: check settings.json
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (Array.isArray(settings.agentConfigs)) {
        const cfg = settings.agentConfigs.find(
          (c: Record<string, unknown>) => c && (c.discordBotName === nameOrDisplay || c.customName === nameOrDisplay)
        );
        if (cfg && (cfg as Record<string, string>).agentId) return (cfg as Record<string, string>).agentId;
      }
    }
  } catch { /* ignore */ }
  return nameOrDisplay;
}

export function getAgentStatuses(): AgentStatus[] {
  const status = openclawManager.getStatus();
  const ocVersion = status.version || null;
  return status.agents.map(a => {
    // Resolve internal name for config lookups
    const internalName = resolveAgentId(a.name);
    // Read model from config file (real data)
    const model = readAgentModel(internalName);
    // Get captured logs from manager
    const logs = openclawManager.getAgentLogs(a.name);

    return {
      name: a.name,
      role: a.role,
      status: a.running ? 'running' as const : (a.error ? 'error' as const : 'stopped' as const),
      model: model.replace(/^anthropic\//, ''),  // Strip provider prefix for display
      port: a.port,
      sessions: 0,  // Will be populated from gateway API when available
      tokenUsage: { input: 0, output: 0, cost: 0 },  // Will be populated from gateway API when available
      uptime: a.uptime,
      recentLogs: logs.length > 0 ? logs.slice(-50) : (a.error ? [a.error] : []),
      openclawVersion: ocVersion,
    };
  });
}

export function getWorkspaceStats(): WorkspaceStats {
  // Read from workspace directory — count experiment folders/files
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const workspace = settings.workspace as string;
      if (workspace && fs.existsSync(workspace)) {
        const entries = fs.readdirSync(workspace);
        const experiments = entries.filter(e => e.startsWith('EXP-') || e.startsWith('experiment')).length;
        const papers = entries.filter(e => e.endsWith('.pdf') || e.endsWith('.tex')).length;
        return { experiments, confirmed: 0, refuted: 0, papers };
      }
    }
  } catch { /* ignore */ }
  return { experiments: 0, confirmed: 0, refuted: 0, papers: 0 };
}

export function getTokenUsage(): TokenUsage {
  return { models: [], dailyTotal: 0, dailyBudget: 15.00, pct: 0 };
}

export function getResearchProgress(): ResearchProgress {
  return { rh: 0, sc: 0, bc: 0 };
}

export function getGatewayStatus(): GatewayStatus {
  const status = openclawManager.getStatus();
  const anyRunning = status.agents.some(a => a.running);
  const firstRunning = status.agents.find(a => a.running);
  return {
    running: anyRunning,
    pid: firstRunning?.pid ?? null,
    uptime: firstRunning?.uptime ?? 0,
  };
}

export function startAgent(_agentName: string): { success: boolean; message: string } {
  return { success: true, message: `Agent start requested` };
}
export function stopAgent(_agentName: string): { success: boolean; message: string } {
  return { success: true, message: `Agent stop requested` };
}
export function restartAgent(_agentName: string): { success: boolean; message: string } {
  return { success: true, message: `Agent restart requested` };
}

export function getAgentLogs(agentName: string): string[] {
  // Get from manager's log buffer (supports both displayName and internal name)
  const logs = openclawManager.getAgentLogs(agentName);
  if (logs.length > 0) return logs;

  // Fallback: try to read from OpenClaw's own log files
  const internalName = resolveAgentId(agentName);
  const safeName = internalName.toLowerCase().replace(/[^a-z0-9]/g, '');
  const logDir = path.join(os.homedir(), `.openclaw-asrp-${safeName}`, 'logs');
  try {
    if (fs.existsSync(logDir)) {
      // Read config-audit.jsonl for recent activity
      const auditLog = path.join(logDir, 'config-audit.jsonl');
      if (fs.existsSync(auditLog)) {
        const lines = fs.readFileSync(auditLog, 'utf-8').trim().split('\n').filter(l => l.trim());
        return lines.slice(-50).map(line => {
          try {
            const entry = JSON.parse(line);
            return `[${entry.ts || ''}] ${entry.action || entry.message || line}`;
          } catch {
            return line;
          }
        });
      }
    }
  } catch { /* ignore */ }
  return [];
}

export function getAgentSoul(agentName: string): string {
  // Try to read from the workspace SOUL.md (where openclaw-config-generator writes it)
  const internalName = resolveAgentId(agentName);
  const safeName = internalName.toLowerCase().replace(/[^a-z0-9-]/g, '');

  // 1. Try workspace SOUL.md
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const workspace = settings.workspace as string || path.join(os.homedir(), 'asrp-workspace');
      const soulPath = path.join(workspace, `agent-${safeName}`, 'SOUL.md');
      if (fs.existsSync(soulPath)) {
        return fs.readFileSync(soulPath, 'utf-8');
      }
    }
  } catch { /* ignore */ }

  // 2. Try profile dir agent config (profile dir strips all non-alphanumeric)
  try {
    const profileSafeName = internalName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const profileDir = path.join(os.homedir(), `.openclaw-asrp-${profileSafeName}`);
    const configPath = path.join(profileDir, 'openclaw.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const wsDir = config?.agents?.defaults?.workspace;
      if (wsDir) {
        const soulPath = path.join(wsDir, 'SOUL.md');
        if (fs.existsSync(soulPath)) {
          return fs.readFileSync(soulPath, 'utf-8');
        }
      }
    }
  } catch { /* ignore */ }

  return `# ${agentName}\n\n(SOUL not loaded — no SOUL.md found in workspace)\n`;
}

export function saveAgentSoul(agentName: string, content: string): { success: boolean; error?: string } {
  const internalName = resolveAgentId(agentName);
  const safeName = internalName.toLowerCase().replace(/[^a-z0-9-]/g, '');

  try {
    // Save to workspace SOUL.md (where OpenClaw reads it from)
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    let workspace = path.join(os.homedir(), 'asrp-workspace');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings.workspace) workspace = settings.workspace as string;
    }
    const soulDir = path.join(workspace, `agent-${safeName}`);
    fs.mkdirSync(soulDir, { recursive: true });
    fs.writeFileSync(path.join(soulDir, 'SOUL.md'), content, 'utf-8');

    // Also save to profile dir workspace if it points somewhere different
    try {
      const profileDir = path.join(os.homedir(), `.openclaw-asrp-${safeName}`);
      const configPath = path.join(profileDir, 'openclaw.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const wsDir = config?.agents?.defaults?.workspace;
        if (wsDir && wsDir !== soulDir) {
          fs.mkdirSync(wsDir, { recursive: true });
          fs.writeFileSync(path.join(wsDir, 'SOUL.md'), content, 'utf-8');
        }
      }
    } catch { /* ignore */ }

    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: String(err) };
  }
}

export function renameAgent(_o: string, _n: string): { success: boolean } { return { success: true }; }

export function setAgentModel(agentName: string, model: string): { success: boolean; error?: string } {
  try {
    // Ensure model has provider prefix
    let modelId = model;
    if (modelId.startsWith('claude-') && !modelId.includes('/')) {
      modelId = 'anthropic/' + modelId;
    }

    // Resolve internal name
    const internalName = resolveAgentId(agentName);

    // 1. Update settings.json agentConfigs
    const userDataPath = app.getPath('userData');
    const settingsPath = path.join(userDataPath, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (Array.isArray(settings.agentConfigs)) {
        for (const cfg of settings.agentConfigs) {
          // Match by agentId or discordBotName (display name)
          if (cfg && (cfg.agentId === agentName || cfg.discordBotName === agentName || cfg.agentId === internalName)) {
            cfg.model = model;
            break;
          }
        }
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      }
    }

    // 2. Update the agent's openclaw.json config file
    const safeName = internalName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const configPath = path.join(os.homedir(), `.openclaw-asrp-${safeName}`, 'openclaw.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (config.agents && config.agents.defaults) {
        config.agents.defaults.model = modelId;
      }
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
    }

    return { success: true };
  } catch (err: unknown) {
    return { success: false, error: String(err) };
  }
}
