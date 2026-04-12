import { ipcMain, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as openclawBridge from './openclaw-bridge';
import * as safeKeyStore from './safe-key-store';
import {
  discordGet,
  createResearchChannel,
  postMessageToChannel,
} from './discord-api';
import {
  RESOURCES_PATH,
  isValidAgentName,
  isAllowedChatRole,
  withAuth,
  atomicWriteJSON,
} from './ipc-handlers';
import { generateSingleAgentConfig } from './openclaw-config-generator';
import { openclawManager } from './openclaw-manager';
import { appendAudit } from './audit-store';

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
    try {
      const agents = openclawBridge.getAgentStatuses();
      return {
        agents: agents.map(a => ({
          name: a.name,
          role: a.role,
          status: a.status,
          model: a.model,
        })),
      };
    } catch (err: unknown) {
      return { agents: [], error: String(err) };
    }
  });

  // Issue #H1: Mutating agent actions require auth (standardized to withAuth)
  ipcMain.handle('agents:start', withAuth(async (_userId: number, agentName: string) => {
    return { success: true, message: `Agent ${agentName} start requested (stub)` };
  }));

  ipcMain.handle('agents:stop', withAuth(async (_userId: number, agentName: string) => {
    return { success: true, message: `Agent ${agentName} stop requested (stub)` };
  }));

  // ------ Custom Agent CRUD ------

  const MAX_AGENTS = 6;
  const BASE_ROLES = ['theorist', 'engineer', 'reviewer', 'assistant'];

  // Create a new custom agent
  ipcMain.handle('agents:create', withAuth(async (
    _userId: number,
    opts: {
      name: string;
      role: string;
      model: string;
      discordToken: string;
      discordBotName: string;
      soulContent?: string;
    },
  ) => {
    // Validate inputs
    if (!opts.name || typeof opts.name !== 'string' || opts.name.length > 32) {
      return { success: false, error: 'Invalid agent name (1-32 characters)' };
    }
    if (!opts.role || typeof opts.role !== 'string' || opts.role.length > 32) {
      return { success: false, error: 'Invalid role (1-32 characters)' };
    }
    if (!opts.discordToken || typeof opts.discordToken !== 'string' || opts.discordToken.length < 50) {
      return { success: false, error: 'Invalid Discord bot token' };
    }
    if (!opts.discordBotName || typeof opts.discordBotName !== 'string') {
      return { success: false, error: 'Discord bot name is required' };
    }
    if (opts.soulContent && opts.soulContent.length > 51200) {
      return { success: false, error: 'SOUL content exceeds 50KB limit' };
    }

    // Read current settings
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    let settings: Record<string, unknown> = {};
    try {
      if (fs.existsSync(settingsPath)) {
        settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      }
    } catch { /* start fresh */ }

    const configs = (settings.agentConfigs || []) as Array<Record<string, unknown>>;

    // Check agent limit
    if (configs.length >= MAX_AGENTS) {
      return { success: false, error: `Maximum ${MAX_AGENTS} agents reached` };
    }

    // Check duplicate name
    const nameLC = opts.name.toLowerCase();
    if (configs.some(c => c && ((c.agentId as string) || '').toLowerCase() === nameLC)) {
      return { success: false, error: 'An agent with this name already exists' };
    }

    // Determine index and guildId
    const index = configs.length;
    const guildId = (settings.guildId || settings.discordGuildId || '') as string;
    const workspace = (settings.workspace || path.join(require('os').homedir(), 'asrp-workspace')) as string;

    // Generate config files
    const result = generateSingleAgentConfig(
      {
        name: opts.name,
        role: opts.role,
        model: opts.model || 'claude-sonnet-4-6',
        discordToken: opts.discordToken,
        discordBotName: opts.discordBotName,
        customName: opts.discordBotName,
      },
      index,
      guildId,
      workspace,
      opts.soulContent,
    );

    if (!result.success) {
      return { success: false, error: result.error };
    }

    // Persist to settings.json
    configs.push({
      agentId: opts.name,
      role: opts.role,
      model: opts.model || 'claude-sonnet-4-6',
      discordToken: opts.discordToken,
      discordBotName: opts.discordBotName,
      customName: opts.discordBotName,
      isCustom: true,
    });
    settings.agentConfigs = configs;
    atomicWriteJSON(settingsPath, settings);

    appendAudit({
      type: 'config',
      agent: 'System',
      message: `Custom agent created: ${opts.discordBotName} (${opts.role})`,
    });

    return { success: true, agentName: opts.name };
  }));

  // Delete a custom agent (base 3 agents cannot be deleted)
  ipcMain.handle('agents:delete', withAuth(async (_userId: number, agentName: string) => {
    if (!isValidAgentName(agentName)) {
      return { success: false, error: 'Invalid agent name' };
    }

    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      return { success: false, error: 'Cannot read settings' };
    }

    const configs = (settings.agentConfigs || []) as Array<Record<string, unknown>>;
    const idx = configs.findIndex(c => c && (c.agentId === agentName || c.discordBotName === agentName));
    if (idx === -1) {
      return { success: false, error: 'Agent not found' };
    }

    // Prevent deleting base agents
    const cfg = configs[idx];
    const role = ((cfg.role as string) || '').toLowerCase();
    if (BASE_ROLES.includes(role) && !cfg.isCustom) {
      return { success: false, error: 'Cannot delete base agents (Theorist, Engineer, Reviewer)' };
    }

    // Stop agent if running
    openclawManager.removeAgent(agentName);

    // Remove from settings
    configs.splice(idx, 1);
    settings.agentConfigs = configs;
    atomicWriteJSON(settingsPath, settings);

    appendAudit({
      type: 'config',
      agent: 'System',
      message: `Custom agent deleted: ${agentName}`,
    });

    return { success: true };
  }));
}

// ============================================================
// OPENCLAW HANDLERS (channel: 'openclaw:*')
// ============================================================

export function registerOpenClawHandlers(): void {
  ipcMain.handle('openclaw:agent-statuses', async () => {
    try {
      return { agents: openclawBridge.getAgentStatuses() };
    } catch (err: unknown) {
      return { agents: [], error: String(err) };
    }
  });

  ipcMain.handle('openclaw:workspace-stats', async () => {
    try {
      return openclawBridge.getWorkspaceStats();
    } catch (err: unknown) {
      return { experiments: 0, confirmed: 0, refuted: 0, papers: 0, error: String(err) };
    }
  });

  ipcMain.handle('openclaw:token-usage', async () => {
    try {
      return openclawBridge.getTokenUsage();
    } catch (err: unknown) {
      return { models: [], dailyTotal: 0, dailyBudget: 0, pct: 0, error: String(err) };
    }
  });

  ipcMain.handle('openclaw:research-progress', async () => {
    try {
      return openclawBridge.getResearchProgress();
    } catch (err: unknown) {
      return { rh: 0, sc: 0, bc: 0, error: String(err) };
    }
  });

  ipcMain.handle('openclaw:gateway-status', async () => {
    try {
      return openclawBridge.getGatewayStatus();
    } catch (err: unknown) {
      return { running: false, pid: null, uptime: 0, error: String(err) };
    }
  });

  ipcMain.handle('agents:restart', withAuth(async (_userId: number, agentName: string) => {
    return openclawBridge.restartAgent(agentName);
  }));

  // Issue #13: Validate agentName to prevent path traversal
  // Reads SOUL.md from the agent's workspace directory (where OpenClaw reads it)
  // Resolves displayName (e.g. "ASRP-Albert") to internal agentId (e.g. "Albert")
  ipcMain.handle('agents:get-soul', async (_event, agentName: string) => {
    if (!isValidAgentName(agentName)) {
      return { success: false, error: 'Invalid agent name' };
    }
    // Use the bridge's SOUL loader which resolves names and checks workspace paths
    const content = openclawBridge.getAgentSoul(agentName);
    return { success: true, content };
  });

  // Save SOUL to the agent's workspace directory (where OpenClaw reads it)
  // Issue #13: Validate agentName to prevent path traversal
  // P0-fix: Now requires authentication (writes to disk)
  ipcMain.handle('agents:save-soul', withAuth(async (_userId: number, agentName: string, content: string) => {
    if (!isValidAgentName(agentName)) {
      return { success: false, error: 'Invalid agent name' };
    }
    return openclawBridge.saveAgentSoul(agentName, content);
  }));

  // Issue #H1: Mutating agent actions require auth (standardized to withAuth)
  ipcMain.handle('agents:rename', withAuth(async (_userId: number, oldName: string, newName: string) => {
    return openclawBridge.renameAgent(oldName, newName);
  }));

  ipcMain.handle('agents:set-model', withAuth(async (_userId: number, agentName: string, model: string) => {
    return openclawBridge.setAgentModel(agentName, model);
  }));

  // P0-fix: Logs may contain sensitive info — require auth
  ipcMain.handle('agents:logs', withAuth(async (_userId: number, agentName: string) => {
    return { logs: openclawBridge.getAgentLogs(agentName) };
  }));
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
    try {
      return { model: DEFAULT_ASSISTANT_MODEL_LABEL, type: 'cloud' as const };
    } catch {
      return { model: 'unknown', type: 'cloud' as const };
    }
  });

  // Map user-facing model names to OpenRouter model IDs
  const MODEL_NAME_MAP: Record<string, string> = {
    'Gemini 2.5 Flash': 'google/gemini-2.5-flash',
    'Claude Sonnet 4.6': 'anthropic/claude-sonnet-4-6',
    'Claude Haiku 4.5': 'anthropic/claude-haiku-4-5',
  };

  ipcMain.handle('assistant:chat', withAuth(async (_userId: number, message: string, context?: string, preferredModel?: string) => {
    try {
      // Resolve model: preferred → default
      const resolvedModel = (preferredModel && MODEL_NAME_MAP[preferredModel])
        ? MODEL_NAME_MAP[preferredModel]
        : DEFAULT_ASSISTANT_MODEL;

      // Build messages array with system prompt + context + history + user message
      const systemPrompt = `You are the ASRP research assistant. You help users navigate the platform, manage experiments, configure agents, and understand results. Be concise and helpful. If asked about ASRP features, explain how to use them.`;

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
          const provisionBody = JSON.stringify({});
          const provisionedKey = await new Promise<string>((resolve) => {
            const req = https.request({
              hostname: 'asrp.jzis.org',
              path: '/api/key/provision',
              method: 'POST',
              timeout: 10000, // 10s timeout for provisioning
              headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(provisionBody),
              },
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
            req.on('timeout', () => { req.destroy(); resolve(''); });
            req.on('error', () => resolve(''));
            req.write(provisionBody);
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
              timeout: 30000, // 30s timeout
              headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(requestBody),
                'HTTP-Referer': 'https://asrp.jzis.org',
                'X-Title': 'ASRP',
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
            req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out (30s)')); });
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
  }));

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

  // P0-fix: Validate role to prevent system prompt injection
  ipcMain.handle('assistant:save-message', withAuth(async (_userId: number, role: string, content: string) => {
    if (!isAllowedChatRole(role)) {
      return { success: false, error: 'Invalid role — only "user" and "assistant" are allowed' };
    }
    try {
      ensureHistoryFile();
      const entry = JSON.stringify({ role, content, ts: new Date().toISOString() });
      fs.appendFileSync(chatHistoryPath, entry + '\n', 'utf-8');
      trimHistoryIfNeeded();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  }));

  ipcMain.handle('assistant:clear-history', withAuth(async () => {
    try {
      fs.writeFileSync(chatHistoryPath, '', 'utf-8');
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  }));
}

// ============================================================
// DISCORD HANDLERS (channel: 'discord:*')
// ============================================================

export function registerDiscordHandlers(): void {
  // Low-level REST helpers are provided by ./discord-api.ts and imported above.

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

  // Create a text channel in a guild for a new research
  // P0-fix: Requires auth — creates Discord resources
  ipcMain.handle('discord:create-channel', withAuth(async (_userId: number, channelName: string) => {
    return await createResearchChannel(channelName);
  }));

  // Post a message to a Discord channel. Requires auth — sends to external service.
  ipcMain.handle('discord:post-message', withAuth(async (_userId: number, channelId: string, content: string) => {
    if (typeof channelId !== 'string' || !channelId) {
      return { success: false, error: 'Missing channelId' };
    }
    if (typeof content !== 'string' || !content.trim()) {
      return { success: false, error: 'Empty content' };
    }
    return await postMessageToChannel(channelId, content);
  }));

  // Open a Discord URL in the system default browser (restricted to discord.com only)
  ipcMain.handle('discord:open-url', async (_event, url: string) => {
    if (typeof url !== 'string' || !url.startsWith('https://discord.com/')) {
      return { success: false, error: 'Only https://discord.com/ URLs are permitted' };
    }
     
    const { shell } = require('electron') as typeof import('electron');
    await shell.openExternal(url);
    return { success: true };
  });
}
