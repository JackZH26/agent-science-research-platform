import { ipcMain, app, shell, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { autoUpdater } from './auto-updater';
import { runSelfTest } from './self-test';
import * as safeKeyStore from './safe-key-store';
import { openclawManager } from './openclaw-manager';
import { generateAllConfigs, hasConfig } from './openclaw-config-generator';
import * as keyValidator from './key-validator';
import {
  RESOURCES_PATH,
  getWorkspaceBase,
  getAuthenticatedUserId,
  isPathAllowed,
  isLogErrorRateLimited,
  atomicWriteJSON,
  withAuth,
} from './ipc-handlers';

// ============================================================
// SYSTEM HANDLERS (channel: 'system:*')
// ============================================================

export function registerSystemHandlers(): void {
  ipcMain.handle('system:info', async () => {
    try {
      return {
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        electron: process.versions.electron,
        node: process.versions.node,
        resourcesPath: RESOURCES_PATH,
      };
    } catch (err: unknown) {
      return { version: '?', platform: '?', arch: '?', electron: '?', node: '?', resourcesPath: '', error: String(err) };
    }
  });

  // Issue #9: Read workspace path from settings (user-configured), not hardcoded internal path
  ipcMain.handle('system:workspace', async () => {
    try {
      return { path: getWorkspaceBase() };
    } catch (err: unknown) {
      return { path: '', error: String(err) };
    }
  });

  ipcMain.handle('system:open-path', async (_event, targetPath: string) => {
    // L1: Restrict open-path to workspace and its children
    if (!isPathAllowed(targetPath)) {
      return { success: false, error: 'Path outside workspace' };
    }
    try {
      await shell.openPath(targetPath);
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('system:select-directory', async () => {
    try {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled) return { canceled: true, path: null };
      return { canceled: false, path: result.filePaths[0] };
    } catch (err: unknown) {
      return { canceled: true, path: null, error: String(err) };
    }
  });

  ipcMain.handle('system:health', async () => {
    try {
      return {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      };
    } catch (err: unknown) {
      return { status: 'error', timestamp: '', uptime: 0, error: String(err) };
    }
  });
}

// ============================================================
// Workspace sync — propagates workspace changes to agent configs
// ============================================================

/**
 * When the user changes workspace in settings, update every agent's
 * openclaw.json to point to the new workspace, and copy SOUL.md files.
 */
function syncAgentWorkspaces(
  settings: Record<string, unknown>,
  newWorkspace: string,
  oldWorkspace: string,
): void {
  const configs = settings.agentConfigs as Array<{ agentId?: string; role?: string; name?: string }> | undefined;
  if (!Array.isArray(configs)) return;

  for (const cfg of configs) {
    const agentId = (cfg as Record<string, string>).agentId;
    if (!agentId) continue;

    // SRW-v3: default role renamed assistant→reviewer. Legacy 'assistant'
    // is still accepted as an alias here (discord-api.ts auto-migrates settings).
    let rawRole = ((cfg as Record<string, string>).role || 'reviewer').toLowerCase();
    if (rawRole === 'assistant') rawRole = 'reviewer';
    const role = rawRole;
    const safeName = agentId.toLowerCase().replace(/[^a-z0-9]/g, '');
    const profileDir = path.join(os.homedir(), `.openclaw-asrp-${safeName}`);
    const configPath = path.join(profileDir, 'openclaw.json');

    // Agent dirs now live inside system/ and use role-based naming
    const agentDirName = `agent-${role}`;
    const newAgentWs = path.join(newWorkspace, 'system', agentDirName);

    // Try old locations for migration: root/agent-{name} or root/system/agent-{name} or old workspace
    const oldNameDir = `agent-${agentId.toLowerCase().replace(/[^a-z0-9-]/g, '')}`;
    const oldAgentWsRoot = oldWorkspace ? path.join(oldWorkspace, oldNameDir) : '';
    const oldAgentWsSystem = oldWorkspace ? path.join(oldWorkspace, 'system', oldNameDir) : '';

    try {
      // 1. Create new agent workspace directory inside system/
      fs.mkdirSync(newAgentWs, { recursive: true });

      // 2. Copy SOUL.md from old locations if new doesn't have one
      const newSoul = path.join(newAgentWs, 'SOUL.md');
      if (!fs.existsSync(newSoul)) {
        for (const oldDir of [oldAgentWsSystem, oldAgentWsRoot]) {
          if (oldDir) {
            const oldSoul = path.join(oldDir, 'SOUL.md');
            if (fs.existsSync(oldSoul)) {
              fs.copyFileSync(oldSoul, newSoul);
              console.log(`[Workspace] Copied SOUL.md for ${agentId}: ${oldSoul} → ${newSoul}`);
              break;
            }
          }
        }
      }

      // 3. Update openclaw.json workspace path
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (config.agents && config.agents.defaults) {
          config.agents.defaults.workspace = newAgentWs;
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
          console.log(`[Workspace] Updated ${agentId} config: workspace → ${newAgentWs}`);
        }
      }
    } catch (err) {
      console.error(`[Workspace] Failed to sync ${agentId}:`, err);
    }
  }
}

// ============================================================
// SETTINGS HANDLERS (channel: 'settings:*')
// ============================================================

export function registerSettingsHandlers(): void {
  const userDataPath = app.getPath('userData');
  const settingsPath = path.join(userDataPath, 'settings.json');

  const defaultSettings = {
    theme: 'light',
    language: 'en',
    workspace: path.join(app.getPath('home'), 'asrp-workspace'),
    openrouterKey: '',
    defaultModel: 'google/gemini-2.5-flash',
    budgetDaily: 15,
    notifications: true,
    minimizeToTray: true,
    autoStart: false,
    setupComplete: false,
    guildId: '',
  };

  // Issue #19: Allowlist of valid setting keys — prevents renderer from polluting settings.json
  const ALLOWED_SETTING_KEYS = new Set(Object.keys(defaultSettings));

  const loadSettings = (): Record<string, unknown> => {
    try {
      if (fs.existsSync(settingsPath)) {
        const raw = fs.readFileSync(settingsPath, 'utf-8');
        return { ...defaultSettings, ...JSON.parse(raw) };
      }
    } catch { /* Fall through to defaults */ }
    return { ...defaultSettings };
  };

  ipcMain.handle('settings:get', async () => {
    const settings = loadSettings();
    // Inject API key status (masked) from safeKeyStore so renderer knows if keys are configured
    for (const keyField of ['openrouterKey', 'anthropicKey', 'googleKey']) {
      const storedKey = safeKeyStore.getKey(keyField);
      if (storedKey) {
        settings[keyField] = storedKey.slice(0, 8) + '••••••••';
      }
    }
    return settings;
  });

  ipcMain.handle('settings:set', withAuth(async (_userId: number, updates: Record<string, unknown>) => {
    try {
      // Route API key updates through safeKeyStore (encrypted)
      const keyFields = ['openrouterKey', 'anthropicKey', 'googleKey'];
      for (const keyField of keyFields) {
        if (typeof updates[keyField] === 'string') {
          const keyVal = updates[keyField] as string;
          // Only store if it's a real key (not the masked placeholder we send to renderer)
          if (keyVal && !keyVal.includes('••••')) {
            safeKeyStore.storeKey(keyField, keyVal);
          }
          delete updates[keyField]; // Don't persist in settings.json
        }
      }

      // Filter to only known, allowed keys
      const filteredUpdates: Record<string, unknown> = {};
      for (const key of Object.keys(updates)) {
        if (ALLOWED_SETTING_KEYS.has(key)) {
          filteredUpdates[key] = updates[key];
        }
      }

      // M3: Validate workspace path — must be within the user's home directory,
      // not a system root or critical directory.
      if (typeof filteredUpdates.workspace === 'string') {
        const wsPath = path.resolve(filteredUpdates.workspace as string);
        const homePath = app.getPath('home');
        const dangerousPaths = ['/', '/etc', '/usr', '/bin', '/sbin', '/System', 'C:\\', 'C:\\Windows'];
        const isDangerous = dangerousPaths.some(p => wsPath === p || wsPath.startsWith(p + path.sep));
        const isInHome = wsPath === homePath || wsPath.startsWith(homePath + path.sep);
        if (isDangerous || !isInHome) {
          return { success: false, error: 'Workspace path must be within your home directory' };
        }
      }
      const current = loadSettings();

      // ── Workspace change: sync to all agent openclaw.json configs ──
      if (typeof filteredUpdates.workspace === 'string') {
        const newWs = path.resolve(filteredUpdates.workspace as string);
        const oldWs = current.workspace ? path.resolve(current.workspace as string) : '';
        if (newWs !== oldWs) {
          syncAgentWorkspaces(current, newWs, oldWs);
        }
      }

      const updated = { ...current, ...filteredUpdates };
      atomicWriteJSON(settingsPath, updated);
      return { success: true, settings: updated };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  }));

  ipcMain.handle('settings:reset', withAuth(async () => {
    try {
      atomicWriteJSON(settingsPath, defaultSettings);
      return { success: true, settings: defaultSettings };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  }));
}

// ============================================================
// UPDATER HANDLERS (channel: 'updater:*')
// ============================================================

export function registerUpdaterHandlers(): void {
  ipcMain.handle('updater:status', async () => {
    try {
      return autoUpdater.getStatus();
    } catch (err: unknown) {
      return { checking: false, available: false, downloading: false, ready: false, version: null, progress: 0, error: String(err) };
    }
  });

  ipcMain.handle('updater:check', async () => {
    try {
      await autoUpdater.checkForUpdatesManual();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('updater:download', withAuth(async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  }));

  ipcMain.handle('updater:install', withAuth(async () => {
    try {
      autoUpdater.installUpdate();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  }));
}

// ============================================================
// SELF-TEST + ERROR LOG HANDLERS (channel: 'system:*')
// ============================================================

export function registerSelfTestHandlers(): void {
  ipcMain.handle('system:self-test', async () => {
    try {
      const result = await runSelfTest();
      return { success: true, result };
    } catch (err: unknown) {
      return { success: false, error: String(err), result: null };
    }
  });

  // Issue #16: Rate-limited (max 10/minute) + log rotation (max 5 MB) to prevent disk exhaustion
  const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
  ipcMain.handle('system:log-error', async (_event, errorInfo: Record<string, unknown>) => {
    if (isLogErrorRateLimited()) {
      return { success: false, error: 'Rate limit exceeded' };
    }
    try {
      const userDataPath = app.getPath('userData');
      const logsPath = path.join(userDataPath, 'logs');
      fs.mkdirSync(logsPath, { recursive: true });
      const logFile = path.join(logsPath, 'error.log');

      // Rotate: if log exceeds 5 MB, rename to .old (overwrite previous .old) and start fresh
      try {
        const stat = fs.statSync(logFile);
        if (stat.size > LOG_MAX_BYTES) {
          const oldFile = logFile + '.old';
          fs.renameSync(logFile, oldFile);
        }
      } catch { /* file may not exist yet */ }

      const line = JSON.stringify({ ts: new Date().toISOString(), ...errorInfo }) + '\n';
      fs.appendFileSync(logFile, line, 'utf-8');
      return { success: true };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('system:is-headless', async () => {
    const display = process.env.DISPLAY;
    const isHeadless = process.platform === 'linux' && (!display || display.trim() === '');
    return { headless: isHeadless, display: display || null, platform: process.platform };
  });
}

// ============================================================
// OPENCLAW GATEWAY HANDLERS (channel: 'gateway:*')
// ============================================================

export function registerGatewayHandlers(): void {
  ipcMain.handle('gateway:status', async () => {
    try {
      return openclawManager.getStatus();
    } catch (err: unknown) {
      return { installed: false, version: null, agents: [], error: String(err) };
    }
  });

  // P0-fix: Gateway start/stop require auth — controls all agent processes
  ipcMain.handle('gateway:start', withAuth(async () => {
    // If no configs exist yet, try to generate from saved setup data
    if (!hasConfig()) {
      try {
        const settingsFile = path.join(app.getPath('userData'), 'settings.json');
        if (fs.existsSync(settingsFile)) {
          const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
          const configs = settings.agentConfigs as Array<{ agentId?: string; role?: string; model?: string; discordToken?: string; customName?: string; discordBotName?: string }> | undefined;
          const guildId = settings.guildId as string | undefined;
          if (Array.isArray(configs) && guildId) {
            const agents = configs.filter(c => c && c.discordToken).map(c => ({
              name: c.agentId || 'Agent',
              role: c.role === 'Assistant' ? 'Reviewer' : (c.role || 'Reviewer'),
              model: c.model || 'claude-sonnet-4-6',
              discordToken: c.discordToken || '',
              customName: c.customName || '',
              discordBotName: c.discordBotName || '',
            }));
            if (agents.length > 0) {
              generateAllConfigs(agents, guildId, getWorkspaceBase());
            }
          }
        }
      } catch { /* ignore */ }
    }
    return openclawManager.startAll();
  }));

  ipcMain.handle('gateway:stop', withAuth(async () => {
    openclawManager.stopAll();
    return { success: true };
  }));

  ipcMain.handle('gateway:restart', withAuth(async (_userId: number, agentName?: string) => {
    if (agentName) {
      return openclawManager.restartAgent(agentName);
    }
    openclawManager.stopAll();
    await new Promise(resolve => setTimeout(resolve, 1000));
    return openclawManager.startAll();
  }));

  ipcMain.handle('gateway:install', withAuth(async () => {
    return openclawManager.install();
  }));

  // Generate configs for all agents and start all gateways
  ipcMain.handle('gateway:setup-and-start', async (_event, token: string, agentConfigs: Array<{
    name: string; role: string; model: string; discordToken: string; customName?: string; discordBotName?: string;
  }>, guildId: string) => {
    try {
      // H4 fix: verify auth
      getAuthenticatedUserId(token);

      const workspacePath = getWorkspaceBase();
      const configResult = generateAllConfigs(agentConfigs, guildId, workspacePath);
      if (!configResult.success) {
        return { success: false, error: configResult.errors.join('; ') };
      }

      const startResult = await openclawManager.startAll();
      const failures = startResult.results.filter(r => !r.success);
      if (failures.length > 0) {
        return {
          success: false,
          error: failures.map(f => `${f.name}: ${f.error}`).join('; '),
          partial: startResult.results,
        };
      }
      return { success: true, results: startResult.results };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('gateway:has-config', async () => {
    try {
      return { hasConfig: hasConfig() };
    } catch {
      return { hasConfig: false };
    }
  });

  ipcMain.handle('gateway:check-update', async () => {
    try {
      return await openclawManager.checkForUpdate();
    } catch (err: unknown) {
      return { updateAvailable: false, currentVersion: null, latestVersion: null, error: String(err) };
    }
  });

  // Gateway logs (for debugging) — requires auth (may contain sensitive info)
  ipcMain.handle('gateway:logs', withAuth(async () => {
    const status = openclawManager.getStatus();
    return { status, installed: openclawManager.isInstalled(), binary: openclawManager.findBinary() };
  }));

  // Key validation
  ipcMain.handle('keys:validate-provider', async (_event, provider: string, key: string) => {
    try {
      return await keyValidator.validateKey(provider, key);
    } catch (err: unknown) {
      return { valid: false, provider, error: String(err) };
    }
  });

  ipcMain.handle('keys:provider-list', async () => {
    try {
      return { providers: keyValidator.getProviderList() };
    } catch (err: unknown) {
      return { providers: [], error: String(err) };
    }
  });
}
