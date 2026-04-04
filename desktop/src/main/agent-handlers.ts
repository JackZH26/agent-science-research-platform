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

  // Default model for assistant — use Gemini Flash via OpenRouter (fast + cheap)
  const DEFAULT_ASSISTANT_MODEL = 'google/gemini-2.5-flash';
  const DEFAULT_ASSISTANT_MODEL_LABEL = 'Gemini 2.5 Flash';

  ipcMain.handle('assistant:get-model', async () => {
    return { model: DEFAULT_ASSISTANT_MODEL_LABEL, type: 'cloud' as const };
  });

  ipcMain.handle('assistant:chat', async (_event, message: string, context?: string) => {
    try {
      // Build messages array with system prompt + context + history + user message
      const systemPrompt = `You are the ASRP Desktop research assistant. You help users navigate the platform, manage experiments, configure agents, and understand results. Be concise and helpful. If asked about ASRP features, explain how to use them.`;

      const messages: Array<{ role: string; content: string }> = [
        { role: 'system', content: systemPrompt },
      ];

      // Add recent history for context (last 10 messages)
      try {
        ensureHistoryFile();
        const raw = fs.readFileSync(chatHistoryPath, 'utf-8');
        const lines = raw.trim().split('\n').filter(l => l.trim());
        const history = lines
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean)
          .slice(-10);
        for (const h of history) {
          messages.push({ role: h.role, content: h.content });
        }
      } catch {
        // No history, that's fine
      }

      // Add context if available
      let userContent = message;
      if (context) {
        userContent = `[Context: User is on the ${context} page]\n\n${message}`;
      }
      messages.push({ role: 'user', content: userContent });

      // Try OpenRouter API
      let reply = '';
      let modelLabel = DEFAULT_ASSISTANT_MODEL_LABEL;

      // Read API key: settings.json (user key) → cached trial key → provision from server
      let apiKey = process.env.OPENROUTER_KEY || '';
      const { app: electronApp } = require('electron');
      const settingsFile = path.join(electronApp.getPath('userData'), 'settings.json');
      try {
        if (fs.existsSync(settingsFile)) {
          const s = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
          if (s.openrouterKey && !s.openrouterKey.includes('placeholder')) apiKey = s.openrouterKey;
        }
      } catch { /* use env fallback */ }

      // If no key, try to provision from ASRP server
      if (!apiKey) {
        try {
          const trialKeyFile = path.join(electronApp.getPath('userData'), '.trial-key');
          if (fs.existsSync(trialKeyFile)) {
            apiKey = fs.readFileSync(trialKeyFile, 'utf-8').trim();
          } else {
            // Fetch from server
            const https = require('https');
            const provisionedKey = await new Promise<string>((resolve, reject) => {
              const req = https.request({
                hostname: 'asrp.jzis.org',
                path: '/api/key/provision',
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
              }, (res: import('http').IncomingMessage) => {
                let data = '';
                res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
                res.on('end', () => {
                  try {
                    const parsed = JSON.parse(data);
                    if (parsed.key) {
                      // Cache the trial key locally
                      fs.writeFileSync(trialKeyFile, parsed.key, { mode: 0o600 });
                      resolve(parsed.key);
                    } else {
                      resolve('');
                    }
                  } catch { resolve(''); }
                });
              });
              req.on('error', () => resolve(''));
              req.write(JSON.stringify({}));
              req.end();
            });
            apiKey = provisionedKey;
          }
        } catch { /* no trial key available */ }
      }

      if (!apiKey) {
        reply = 'No API key configured. Go to **Settings** → add your OpenRouter API key to enable the assistant.';
      } else {
        try {
          const https = require('https');
          const requestBody = JSON.stringify({
            model: DEFAULT_ASSISTANT_MODEL,
            messages,
            max_tokens: 1024,
            temperature: 0.7,
          });

          reply = await new Promise<string>((resolve, reject) => {
            const req = https.request({
              hostname: 'openrouter.ai',
              path: '/api/v1/chat/completions',
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://asrp.jzis.org',
                'X-Title': 'ASRP Desktop',
              },
            }, (res: import('http').IncomingMessage) => {
              let data = '';
              res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
              res.on('end', () => {
                try {
                  const parsed = JSON.parse(data);
                  if (parsed.choices?.[0]?.message?.content) {
                    // Update model label from response
                    if (parsed.model) modelLabel = parsed.model;
                    resolve(parsed.choices[0].message.content);
                  } else if (parsed.error) {
                    resolve(`API error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
                  } else {
                    resolve('Unexpected API response. Check your API key and model settings.');
                  }
                } catch {
                  resolve('Failed to parse API response.');
                }
              });
            });
            req.on('error', (err: Error) => reject(err));
            req.write(requestBody);
            req.end();
          });
        } catch (apiErr: unknown) {
          reply = `API call failed: ${apiErr instanceof Error ? apiErr.message : String(apiErr)}`;
        }
      }

      // Save to history
      ensureHistoryFile();
      const userEntry = JSON.stringify({ role: 'user', content: message, ts: new Date().toISOString() });
      const assistantEntry = JSON.stringify({ role: 'assistant', content: reply, ts: new Date().toISOString() });
      fs.appendFileSync(chatHistoryPath, userEntry + '\n' + assistantEntry + '\n', 'utf-8');
      trimHistoryIfNeeded();

      return { success: true, reply, model: modelLabel };
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
