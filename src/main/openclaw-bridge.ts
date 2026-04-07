// ============================================================
// OpenClaw Bridge — Multi-agent gateway status
// ============================================================

import { openclawManager } from './openclaw-manager';

export interface AgentStatus {
  name: string;
  role: string;
  status: 'running' | 'idle' | 'stopped' | 'error';
  model: string;
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

export function getAgentStatuses(): AgentStatus[] {
  const status = openclawManager.getStatus();
  const ocVersion = status.version || null;
  return status.agents.map(a => ({
    name: a.name,
    role: a.role,
    status: a.running ? 'running' as const : (a.error ? 'error' as const : 'stopped' as const),
    model: '',
    sessions: 0,
    tokenUsage: { input: 0, output: 0, cost: 0 },
    uptime: a.uptime,
    recentLogs: a.error ? [a.error] : [],
    openclawVersion: ocVersion,
  }));
}

export function getWorkspaceStats(): WorkspaceStats {
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
export function getAgentLogs(_agentName: string): string[] { return []; }
export function getAgentSoul(agentName: string): string {
  return `# ${agentName}\n\n(SOUL not loaded)\n`;
}
export function saveAgentSoul(_n: string, _c: string): { success: boolean } { return { success: true }; }
export function renameAgent(_o: string, _n: string): { success: boolean } { return { success: true }; }
export function setAgentModel(agentName: string, model: string): { success: boolean; error?: string } {
  try {
    const { app } = require('electron');
    const path = require('path');
    const fs = require('fs');
    const os = require('os');

    // Ensure model has provider prefix
    let modelId = model;
    if (modelId.startsWith('claude-') && !modelId.includes('/')) {
      modelId = 'anthropic/' + modelId;
    }

    // 1. Update settings.json agentConfigs
    const userDataPath = app.getPath('userData');
    const settingsPath = path.join(userDataPath, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (Array.isArray(settings.agentConfigs)) {
        for (const cfg of settings.agentConfigs) {
          // Match by agentId or discordBotName (display name)
          if (cfg && (cfg.agentId === agentName || cfg.discordBotName === agentName)) {
            cfg.model = model;
            break;
          }
        }
        fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      }
    }

    // 2. Update the agent's openclaw.json config file
    // Find agent's internal name (agentId) from settings to locate profile dir
    let internalName = agentName;
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (Array.isArray(settings.agentConfigs)) {
        const cfg = settings.agentConfigs.find(
          (c: Record<string, unknown>) => c && (c.agentId === agentName || c.discordBotName === agentName)
        );
        if (cfg && cfg.agentId) internalName = cfg.agentId;
      }
    }
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
