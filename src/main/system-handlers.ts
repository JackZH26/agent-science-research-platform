import { ipcMain, app, shell, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { autoUpdater } from './auto-updater';
import { runSelfTest } from './self-test';
import * as safeKeyStore from './safe-key-store';
import {
  RESOURCES_PATH,
  getWorkspaceBase,
  isPathAllowed,
  isLogErrorRateLimited,
} from './ipc-handlers';

// ============================================================
// SYSTEM HANDLERS (channel: 'system:*')
// ============================================================

export function registerSystemHandlers(): void {
  ipcMain.handle('system:info', async () => {
    return {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      resourcesPath: RESOURCES_PATH,
    };
  });

  // Issue #9: Read workspace path from settings (user-configured), not hardcoded internal path
  ipcMain.handle('system:workspace', async () => {
    return { path: getWorkspaceBase() };
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
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled) return { canceled: true, path: null };
    return { canceled: false, path: result.filePaths[0] };
  });

  ipcMain.handle('system:health', async () => {
    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  });
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
    // Inject API key status (masked) from safeKeyStore so renderer knows if a key is configured
    const storedKey = safeKeyStore.getKey('openrouterKey');
    if (storedKey) {
      settings.openrouterKey = storedKey.slice(0, 8) + '••••••••';
    }
    return settings;
  });

  ipcMain.handle('settings:set', async (_event, updates: Record<string, unknown>) => {
    try {
      // Route API key updates through safeKeyStore (encrypted)
      if (typeof updates.openrouterKey === 'string') {
        const keyVal = updates.openrouterKey as string;
        // Only store if it's a real key (not the masked placeholder we send to renderer)
        if (keyVal && !keyVal.includes('••••')) {
          safeKeyStore.storeKey('openrouterKey', keyVal);
        }
        delete updates.openrouterKey; // Don't persist in settings.json
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
      const updated = { ...current, ...filteredUpdates };
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(updated, null, 2), 'utf-8');
      return { success: true, settings: updated };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('settings:reset', async () => {
    try {
      fs.writeFileSync(settingsPath, JSON.stringify(defaultSettings, null, 2), 'utf-8');
      return { success: true, settings: defaultSettings };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });
}

// ============================================================
// UPDATER HANDLERS (channel: 'updater:*')
// ============================================================

export function registerUpdaterHandlers(): void {
  ipcMain.handle('updater:status', async () => {
    return autoUpdater.getStatus();
  });

  ipcMain.handle('updater:check', async () => {
    try {
      await autoUpdater.checkForUpdates();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('updater:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('updater:install', async () => {
    try {
      autoUpdater.installUpdate();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });
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

  // Issue #16: Rate-limited (max 10/minute) to prevent disk exhaustion
  ipcMain.handle('system:log-error', async (_event, errorInfo: Record<string, unknown>) => {
    if (isLogErrorRateLimited()) {
      return { success: false, error: 'Rate limit exceeded' };
    }
    try {
      const userDataPath = app.getPath('userData');
      const logsPath = path.join(userDataPath, 'logs');
      fs.mkdirSync(logsPath, { recursive: true });
      const logFile = path.join(logsPath, 'error.log');
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
