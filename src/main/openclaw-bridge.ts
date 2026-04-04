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
  return status.agents.map(a => ({
    name: a.name,
    role: a.role,
    status: a.running ? 'running' as const : (a.error ? 'error' as const : 'stopped' as const),
    model: '',
    sessions: 0,
    tokenUsage: { input: 0, output: 0, cost: 0 },
    uptime: a.uptime,
    recentLogs: a.error ? [a.error] : [],
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
export function setAgentModel(_n: string, _m: string): { success: boolean } { return { success: true }; }
