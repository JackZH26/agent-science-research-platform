// ============================================================
// Discord API helper module
// ============================================================
// Shared low-level helpers for Discord REST API v10.
// Used by both the IPC handlers in agent-handlers.ts and the
// Research Workflow orchestrator in research-workflow.ts.
// ============================================================

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as safeKeyStore from './safe-key-store';

const USER_AGENT = 'ASRP-Desktop (https://asrp.jzis.org, 1.0)';
const TIMEOUT_MS = 15000;

function requestJson(
  method: 'GET' | 'POST',
  apiPath: string,
  token: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers: Record<string, string> = {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    };
    if (body) headers['Content-Length'] = String(Buffer.byteLength(bodyStr));

    const req = https.request(
      {
        hostname: 'discord.com',
        path: `/api/v10${apiPath}`,
        method,
        timeout: TIMEOUT_MS,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          try { resolve(data ? JSON.parse(data) : {}); }
          catch { resolve({ error: 'Invalid JSON response from Discord API' }); }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('Discord API request timed out (15s)')); });
    req.on('error', reject);
    if (body) req.write(bodyStr);
    req.end();
  });
}

export function discordGet(apiPath: string, token: string): Promise<unknown> {
  return requestJson('GET', apiPath, token);
}

export function discordPost(
  apiPath: string,
  token: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  return requestJson('POST', apiPath, token, body);
}

/**
 * Read a working Discord bot token from settings / safeKeyStore.
 * Returns null if nothing is configured.
 */
export function readBotToken(): string | null {
  try {
    const settingsFile = path.join(app.getPath('userData'), 'settings.json');
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      const configs = settings.agentConfigs as Array<{ discordToken?: string }> | undefined;
      if (Array.isArray(configs)) {
        for (const cfg of configs) {
          if (cfg.discordToken) return cfg.discordToken;
        }
      }
    }
  } catch { /* fall through */ }
  try {
    const stored = safeKeyStore.getKey('discordBotToken');
    if (stored) return stored;
  } catch { /* ignore */ }
  return null;
}

/**
 * Read the configured guild ID from settings.
 */
export function readGuildId(): string | null {
  try {
    const settingsFile = path.join(app.getPath('userData'), 'settings.json');
    if (fs.existsSync(settingsFile)) {
      const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
      if (typeof settings.guildId === 'string' && settings.guildId) return settings.guildId;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Sanitize a research title into a Discord channel name
 * (lowercase, alphanumeric + hyphens, max 100 chars).
 */
export function sanitizeChannelName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'research';
}

/**
 * Create a text channel in the configured guild. Returns {channelId, channelName}
 * on success. Used both by the IPC handler and the workflow bootstrap.
 */
export async function createResearchChannel(
  channelName: string,
): Promise<{ success: true; channelId: string; channelName: string } | { success: false; error: string }> {
  const guildId = readGuildId();
  if (!guildId) return { success: false, error: 'Guild ID not configured' };
  const token = readBotToken();
  if (!token) return { success: false, error: 'No Discord bot token available' };

  const safeName = sanitizeChannelName(channelName);
  try {
    const data = await discordPost(
      `/guilds/${encodeURIComponent(guildId)}/channels`,
      token,
      { name: safeName, type: 0, topic: `Research: ${channelName}` },
    ) as Record<string, unknown>;
    if (data['id']) {
      return {
        success: true,
        channelId: data['id'] as string,
        channelName: (data['name'] as string) || safeName,
      };
    }
    return { success: false, error: (data['message'] as string) || 'Failed to create channel' };
  } catch (err: unknown) {
    return { success: false, error: String(err) };
  }
}

/**
 * Post a markdown message to a Discord channel. Splits messages >1900 chars
 * into multiple posts since Discord limits content to 2000 characters.
 */
export async function postMessageToChannel(
  channelId: string,
  content: string,
): Promise<{ success: true; messageId?: string } | { success: false; error: string }> {
  const token = readBotToken();
  if (!token) return { success: false, error: 'No Discord bot token available' };
  if (!channelId) return { success: false, error: 'Missing channelId' };

  const chunks = splitMessage(content, 1900);
  let lastId: string | undefined;
  try {
    for (const chunk of chunks) {
      const data = await discordPost(
        `/channels/${encodeURIComponent(channelId)}/messages`,
        token,
        { content: chunk },
      ) as Record<string, unknown>;
      if (data['id']) {
        lastId = data['id'] as string;
      } else {
        return { success: false, error: (data['message'] as string) || 'Failed to post message' };
      }
    }
    return { success: true, messageId: lastId };
  } catch (err: unknown) {
    return { success: false, error: String(err) };
  }
}

/** Split a long message on paragraph / line boundaries, keeping each chunk ≤ maxLen. */
function splitMessage(content: string, maxLen: number): string[] {
  if (content.length <= maxLen) return [content];
  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > maxLen) {
    let cut = remaining.lastIndexOf('\n\n', maxLen);
    if (cut < maxLen * 0.5) cut = remaining.lastIndexOf('\n', maxLen);
    if (cut < maxLen * 0.5) cut = remaining.lastIndexOf(' ', maxLen);
    if (cut <= 0) cut = maxLen;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}
