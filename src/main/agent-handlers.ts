import { ipcMain, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as openclawBridge from './openclaw-bridge';
import * as safeKeyStore from './safe-key-store';
import {
  RESOURCES_PATH,
  isValidAgentName,
  getAuthenticatedUserId,
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

  // Issue #H1: Mutating agent actions require auth
  ipcMain.handle('agents:start', async (_event, token: string, agentName: string) => {
    try {
      getAuthenticatedUserId(token);
      return { success: true, message: `Agent ${agentName} start requested (stub)` };
    } catch (err: unknown) {
      return { success: false, message: String(err) };
    }
  });

  ipcMain.handle('agents:stop', async (_event, token: string, agentName: string) => {
    try {
      getAuthenticatedUserId(token);
      return { success: true, message: `Agent ${agentName} stop requested (stub)` };
    } catch (err: unknown) {
      return { success: false, message: String(err) };
    }
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

  ipcMain.handle('agents:restart', async (_event, token: string, agentName: string) => {
    try {
      getAuthenticatedUserId(token);
      return openclawBridge.restartAgent(agentName);
    } catch (err: unknown) {
      return { success: false, message: String(err) };
    }
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

  // Issue #H1: Mutating agent actions require auth
  ipcMain.handle('agents:rename', async (_event, token: string, oldName: string, newName: string) => {
    try {
      getAuthenticatedUserId(token);
      return openclawBridge.renameAgent(oldName, newName);
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('agents:set-model', async (_event, token: string, agentName: string, model: string) => {
    try {
      getAuthenticatedUserId(token);
      return openclawBridge.setAgentModel(agentName, model);
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
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

  // Map user-facing model names to OpenRouter model IDs
  const MODEL_NAME_MAP: Record<string, string> = {
    'Gemini 2.5 Flash': 'google/gemini-2.5-flash',
    'Claude Sonnet 4.6': 'anthropic/claude-sonnet-4-6',
    'Claude Haiku 4.5': 'anthropic/claude-haiku-4-5',
  };

  ipcMain.handle('assistant:chat', async (_event, message: string, context?: string, preferredModel?: string) => {
    try {
      // Resolve model: preferred → default
      const resolvedModel = (preferredModel && MODEL_NAME_MAP[preferredModel])
        ? MODEL_NAME_MAP[preferredModel]
        : DEFAULT_ASSISTANT_MODEL;

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

      // Resolve API key from all sources (encrypted store → env → legacy → trial)
      let apiKey = safeKeyStore.resolveOpenRouterKey();

      // If still no key, try to provision from ASRP server
      if (!apiKey) {
        try {
          const https = require('https');
          const trialKeyFile = path.join(app.getPath('userData'), '.trial-key');
          const provisionedKey = await new Promise<string>((resolve) => {
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
                    fs.writeFileSync(trialKeyFile, parsed.key, { mode: 0o600 });
                    resolve(parsed.key);
                  } else { resolve(''); }
                } catch { resolve(''); }
              });
            });
            req.on('error', () => resolve(''));
            req.write(JSON.stringify({}));
            req.end();
          });
          apiKey = provisionedKey;
        } catch { /* no trial key available */ }
      }

      if (!apiKey) {
        reply = 'No API key configured. Go to **Settings** → add your OpenRouter API key to enable the assistant.';
      } else {
        try {
          const https = require('https');
          const requestBody = JSON.stringify({
            model: resolvedModel,
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

// ============================================================
// DISCORD HANDLERS (channel: 'discord:*')
// ============================================================

export function registerDiscordHandlers(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const https = require('https') as typeof import('https');

  // Helper: make a GET request to the Discord API with a Bot token
  const discordGet = (apiPath: string, token: string): Promise<unknown> => {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'discord.com',
          path: `/api/v10${apiPath}`,
          method: 'GET',
          headers: {
            Authorization: `Bot ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'ASRP-Desktop (https://asrp.jzis.org, 1.0)',
          },
        },
        (res: import('http').IncomingMessage) => {
          let data = '';
          res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
          res.on('end', () => {
            try { resolve(JSON.parse(data)); }
            catch { resolve({ error: 'Invalid JSON response from Discord API' }); }
          });
        },
      );
      req.on('error', reject);
      req.end();
    });
  };

  // Validate a Discord bot token by calling GET /users/@me
  ipcMain.handle('discord:validate-token', async (_event, token: string) => {
    try {
      const data = await discordGet('/users/@me', token) as Record<string, unknown>;
      if (data.id) {
        return {
          valid: true,
          botName: data.username as string,
          botId: data.id as string,
          botTag: `${data.username as string}#${data.discriminator as string}`,
        };
      }
      return { valid: false, error: (data.message as string) || 'Invalid token' };
    } catch (err: unknown) {
      return { valid: false, error: String(err) };
    }
  });

  // Generate and open an OAuth invite URL for the bot; optionally scoped to a guild
  ipcMain.handle('discord:invite-url', async (_event, botAppId: string, guildId?: string) => {
    const permissions = '537069072'; // Send + Read + History + Manage Channels + Manage Webhooks
    const scope = 'bot';
    let url = `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(botAppId)}&permissions=${permissions}&scope=${scope}`;
    if (guildId) url += `&guild_id=${encodeURIComponent(guildId)}`;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { shell } = require('electron') as typeof import('electron');
    await shell.openExternal(url);
    return { url };
  });

  // List text channels (type===0) in a guild
  ipcMain.handle('discord:list-channels', async (_event, token: string, guildId: string) => {
    try {
      const data = await discordGet(`/guilds/${encodeURIComponent(guildId)}/channels`, token);
      if (Array.isArray(data)) {
        const channels = (data as Array<Record<string, unknown>>)
          .filter(c => c['type'] === 0)
          .map(c => ({ id: c['id'] as string, name: c['name'] as string }));
        return { channels };
      }
      const err = data as Record<string, unknown>;
      return { channels: [], error: (err['message'] as string) || 'Failed to list channels' };
    } catch (err: unknown) {
      return { channels: [], error: String(err) };
    }
  });

  // Check whether the bot is a member of a specific guild
  ipcMain.handle('discord:check-guild', async (_event, token: string, guildId: string) => {
    try {
      const data = await discordGet(`/guilds/${encodeURIComponent(guildId)}`, token) as Record<string, unknown>;
      if (data['id']) {
        return { inGuild: true, guildName: data['name'] as string };
      }
      return { inGuild: false, error: (data['message'] as string) || 'Bot not in guild' };
    } catch (err: unknown) {
      return { inGuild: false, error: String(err) };
    }
  });

  // Open a Discord URL in the system default browser (restricted to discord.com only)
  ipcMain.handle('discord:open-url', async (_event, url: string) => {
    if (typeof url !== 'string' || !url.startsWith('https://discord.com/')) {
      return { success: false, error: 'Only https://discord.com/ URLs are permitted' };
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { shell } = require('electron') as typeof import('electron');
    await shell.openExternal(url);
    return { success: true };
  });
}
