import { ipcMain, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as openclawBridge from './openclaw-bridge';
import {
  RESOURCES_PATH,
  isValidAgentName,
} from './ipc-handlers';

// ============================================================
// AGENT HANDLERS (channel: 'agents:*')
// ============================================================

export function registerAgentHandlers(): void {
  ipcMain.handle('agents:list', async () => {
    try {
      const agentsPath = path.join(RESOURCES_PATH, 'agents');
      if (!fs.existsSync(agentsPath)) return { agents: [] };

      const files = fs.readdirSync(agentsPath);
      const agentNames = [...new Set(
        files
          .filter(f => f.endsWith('.md') || f.endsWith('.json'))
          .map(f => f.replace(/-(soul|init|openclaw)\.(md|json)$/, '').replace(/\.md$/, ''))
          .filter(n => n && !n.includes('.'))
      )];

      return { agents: agentNames };
    } catch (err: unknown) {
      return { agents: [], error: String(err) };
    }
  });

  // Issue #13: Validate agentName to prevent path traversal
  ipcMain.handle('agents:get', async (_event, agentName: string) => {
    if (!isValidAgentName(agentName)) {
      return { success: false, error: 'Invalid agent name' };
    }
    try {
      const agentPath = path.join(RESOURCES_PATH, 'agents', `${agentName}.md`);
      if (!fs.existsSync(agentPath)) {
        return { success: false, error: 'Agent not found' };
      }
      const content = fs.readFileSync(agentPath, 'utf-8');
      return { success: true, content };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  // Issue #18: Replaced conflicting hardcoded list with openclaw bridge (single source of truth)
  ipcMain.handle('agents:status', async () => {
    const agents = openclawBridge.getAgentStatuses();
    return {
      agents: agents.map(a => ({
        name: a.name,
        role: a.role,
        status: a.status,
        model: a.model,
      })),
    };
  });

  ipcMain.handle('agents:start', async (_event, agentName: string) => {
    return { success: true, message: `Agent ${agentName} start requested (stub)` };
  });

  ipcMain.handle('agents:stop', async (_event, agentName: string) => {
    return { success: true, message: `Agent ${agentName} stop requested (stub)` };
  });
}

// ============================================================
// OPENCLAW HANDLERS (channel: 'openclaw:*')
// ============================================================

export function registerOpenClawHandlers(): void {
  ipcMain.handle('openclaw:agent-statuses', async () => {
    return { agents: openclawBridge.getAgentStatuses() };
  });

  ipcMain.handle('openclaw:workspace-stats', async () => {
    return openclawBridge.getWorkspaceStats();
  });

  ipcMain.handle('openclaw:token-usage', async () => {
    return openclawBridge.getTokenUsage();
  });

  ipcMain.handle('openclaw:research-progress', async () => {
    return openclawBridge.getResearchProgress();
  });

  ipcMain.handle('openclaw:gateway-status', async () => {
    return openclawBridge.getGatewayStatus();
  });

  ipcMain.handle('agents:restart', async (_event, agentName: string) => {
    return openclawBridge.restartAgent(agentName);
  });

  // Issue #13: Validate agentName to prevent path traversal
  // Issue #8: Read user-modified SOUL from userData/agents/ first, then fallback to packaged resources
  ipcMain.handle('agents:get-soul', async (_event, agentName: string) => {
    if (!isValidAgentName(agentName)) {
      return { success: false, error: 'Invalid agent name' };
    }
    const userDataPath = app.getPath('userData');
    const userSoulPath = path.join(userDataPath, 'agents', `${agentName.toLowerCase()}-soul.md`);
    try {
      if (fs.existsSync(userSoulPath)) {
        return { success: true, content: fs.readFileSync(userSoulPath, 'utf-8') };
      }
    } catch { /* fall through */ }
    try {
      const soulPath = path.join(RESOURCES_PATH, 'agents', `${agentName.toLowerCase()}-soul.md`);
      if (fs.existsSync(soulPath)) {
        return { success: true, content: fs.readFileSync(soulPath, 'utf-8') };
      }
    } catch { /* fall through */ }
    return { success: true, content: openclawBridge.getAgentSoul(agentName) };
  });

  // Issue #8: Write to userData/agents/ (writable location), not resources/ (read-only in packaged ASAR)
  // Issue #13: Validate agentName to prevent path traversal
  ipcMain.handle('agents:save-soul', async (_event, agentName: string, content: string) => {
    if (!isValidAgentName(agentName)) {
      return { success: false, error: 'Invalid agent name' };
    }
    try {
      const userDataPath = app.getPath('userData');
      const soulPath = path.join(userDataPath, 'agents', `${agentName.toLowerCase()}-soul.md`);
      fs.mkdirSync(path.dirname(soulPath), { recursive: true });
      fs.writeFileSync(soulPath, content, 'utf-8');
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('agents:rename', async (_event, oldName: string, newName: string) => {
    return openclawBridge.renameAgent(oldName, newName);
  });

  ipcMain.handle('agents:set-model', async (_event, agentName: string, model: string) => {
    return openclawBridge.setAgentModel(agentName, model);
  });

  ipcMain.handle('agents:logs', async (_event, agentName: string) => {
    return { logs: openclawBridge.getAgentLogs(agentName) };
  });
}

// ============================================================
// ASSISTANT HANDLERS (channel: 'assistant:*')
// ============================================================

export function registerAssistantHandlers(): void {
  const userDataPath = app.getPath('userData');
  const chatHistoryPath = path.join(userDataPath, 'logs', 'assistant-chat.jsonl');
  // Issue #23: Maximum lines stored on disk (older entries trimmed automatically)
  const HISTORY_MAX_LINES = 1000;

  const ensureHistoryFile = () => {
    fs.mkdirSync(path.dirname(chatHistoryPath), { recursive: true });
    if (!fs.existsSync(chatHistoryPath)) {
      fs.writeFileSync(chatHistoryPath, '', 'utf-8');
    }
  };

  const trimHistoryIfNeeded = () => {
    try {
      const raw = fs.readFileSync(chatHistoryPath, 'utf-8');
      const lines = raw.split('\n').filter(l => l.trim());
      if (lines.length > HISTORY_MAX_LINES) {
        const trimmed = lines.slice(-HISTORY_MAX_LINES).join('\n') + '\n';
        fs.writeFileSync(chatHistoryPath, trimmed, 'utf-8');
      }
    } catch { /* ignore */ }
  };

  ipcMain.handle('assistant:get-model', async () => {
    return { model: 'Claude Sonnet 4.6', type: 'cloud' as const };
  });

  ipcMain.handle('assistant:chat', async (_event, message: string, context?: string) => {
    try {
      const mockResponses: Record<string, string> = {
        'register': 'To register an experiment, navigate to **Experiments** → click **+ Register Experiment** → fill in your hypothesis and metadata. The system will assign an EXP-ID automatically.',
        'model': 'To switch an agent\'s model, go to **Agents** → click on the agent card → use the **Model** dropdown. Changes take effect after the agent restarts.',
        'pipeline': 'The paper pipeline status shows: 2 papers in workspace (1 submitted, 1 draft). Wall-E is running EXP-003 which feeds into the DD paper.',
        'default': 'I\'m your ASRP research assistant. I can help you navigate the platform, understand experiment results, and manage your agents. What would you like to know?',
      };

      const lowerMsg = message.toLowerCase();
      let reply = mockResponses['default'];
      if (lowerMsg.includes('register') || lowerMsg.includes('experiment')) {
        reply = mockResponses['register'];
      } else if (lowerMsg.includes('model') || lowerMsg.includes('switch')) {
        reply = mockResponses['model'];
      } else if (lowerMsg.includes('pipeline') || lowerMsg.includes('paper') || lowerMsg.includes('status')) {
        reply = mockResponses['pipeline'];
      }

      if (context) {
        reply = `*[Context: ${context}]*\n\n${reply}`;
      }

      ensureHistoryFile();
      const userEntry = JSON.stringify({ role: 'user', content: message, ts: new Date().toISOString() });
      const assistantEntry = JSON.stringify({ role: 'assistant', content: reply, ts: new Date().toISOString() });
      fs.appendFileSync(chatHistoryPath, userEntry + '\n' + assistantEntry + '\n', 'utf-8');
      trimHistoryIfNeeded();

      return { success: true, reply, model: 'Claude Sonnet 4.6' };
    } catch (err: unknown) {
      return { success: false, reply: 'Error processing message', error: String(err), model: 'unknown' };
    }
  });

  ipcMain.handle('assistant:history', async () => {
    try {
      ensureHistoryFile();
      const raw = fs.readFileSync(chatHistoryPath, 'utf-8');
      const lines = raw.trim().split('\n').filter(l => l.trim());
      const messages = lines
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean)
        .slice(-50);
      return { messages };
    } catch {
      return { messages: [] };
    }
  });

  ipcMain.handle('assistant:save-message', async (_event, role: string, content: string) => {
    try {
      ensureHistoryFile();
      const entry = JSON.stringify({ role, content, ts: new Date().toISOString() });
      fs.appendFileSync(chatHistoryPath, entry + '\n', 'utf-8');
      trimHistoryIfNeeded();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('assistant:clear-history', async () => {
    try {
      fs.writeFileSync(chatHistoryPath, '', 'utf-8');
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });
}
