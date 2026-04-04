import { ipcMain, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as authService from './auth-service';
import * as keyManager from './key-manager';
import * as safeKeyStore from './safe-key-store';
import {
  getAuthenticatedUserId,
  getWorkspaceBase,
} from './ipc-handlers';

// ============================================================
// AUTH HANDLERS (channel: 'auth:*')
// ============================================================

export function registerAuthHandlers(): void {
  ipcMain.handle('auth:register', async (_event, name: string, email: string, password: string) => {
    return authService.register(name, email, password);
  });

  ipcMain.handle('auth:login', async (_event, email: string, password: string) => {
    return authService.login(email, password);
  });

  // Issue #15: Logout now invalidates token via auth-service blacklist
  ipcMain.handle('auth:logout', async (_event, token: string) => {
    return authService.logout(token);
  });

  ipcMain.handle('auth:user', async (_event, token: string) => {
    return authService.getUser(token);
  });

  // Issue #29: auth:setup-complete consolidated into setup:complete.
  // Kept for backwards compatibility — now only verifies auth, no longer
  // duplicates the markSetupComplete call that setup:complete already makes.
  ipcMain.handle('auth:setup-complete', async (_event, token: string) => {
    try {
      getAuthenticatedUserId(token); // Just verify the token is valid
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });
}

// ============================================================
// KEY HANDLERS (channel: 'keys:*')
// ============================================================

export function registerKeyHandlers(): void {
  // Issue #3 (IDOR): Accept token, verify auth before assigning key
  ipcMain.handle('keys:assign-trial', async (_event, token: string) => {
    try {
      const userId = getAuthenticatedUserId(token);
      return keyManager.assignTrialKey(userId);
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  // Issue #3 (IDOR): Accept token, verify auth before returning key
  ipcMain.handle('keys:get', async (_event, token: string) => {
    try {
      const userId = getAuthenticatedUserId(token);
      const key = keyManager.getUserKey(userId);
      return { key };
    } catch {
      return { key: null };
    }
  });

  ipcMain.handle('keys:validate', async (_event, key: string) => {
    return keyManager.validateKey(key);
  });
}

// ============================================================
// SETUP HANDLERS (channel: 'setup:*')
// ============================================================

export function registerSetupHandlers(): void {
  // Issue #3 (IDOR): Accept token instead of userId; extract userId server-side
  ipcMain.handle('setup:save-profile', async (_event, token: string, profile: authService.UserProfile) => {
    try {
      const userId = getAuthenticatedUserId(token);
      authService.saveProfile(userId, profile);
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  // Issue #3 (IDOR): Accept token instead of userId
  // Issue #14: API keys stored in plaintext — TODO: migrate to OS keychain (keytar)
  // Issue #17: writeKeyToWorkspace now returns boolean; propagate error on failure
  ipcMain.handle('setup:save-keys', async (_event, token: string, keys: Record<string, string>) => {
    try {
      const userId = getAuthenticatedUserId(token);
      const workspacePath = getWorkspaceBase(); // C4: use configured workspace, not hardcoded internal path
      if (keys.openrouterKey) {
        const writeOk = keyManager.writeKeyToWorkspace(keys.openrouterKey, workspacePath);
        if (!writeOk) {
          return { success: false, error: 'Failed to write API key to workspace .env — check permissions' };
        }
      }
      // Issue #14 FIX: Store API keys using safeStorage (encrypted) instead of plaintext
      if (keys.openrouterKey) safeKeyStore.storeKey('openrouterKey', keys.openrouterKey);
      if (keys.anthropicKey) safeKeyStore.storeKey('anthropicKey', keys.anthropicKey);
      if (keys.googleKey) safeKeyStore.storeKey('googleKey', keys.googleKey);

      // Write non-sensitive settings only
      const userDataPath = app.getPath('userData');
      const settingsPath = path.join(userDataPath, 'settings.json');
      let settings: Record<string, unknown> = {};
      try {
        if (fs.existsSync(settingsPath)) {
          settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        }
      } catch { /* use empty */ }
      // Remove any legacy plaintext keys from settings.json
      delete settings.openrouterKey;
      delete settings.anthropicKey;
      delete settings.googleKey;
      settings.userId = userId;
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  // Issue #3 (IDOR): Accept token instead of userId
  ipcMain.handle('setup:init-agents', async (_event, token: string) => {
    try {
      getAuthenticatedUserId(token); // Verify auth
      // Stub — real OpenClaw integration in Phase 7.5
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('setup:save-agent-config', async (_event, token: string, agentConfigs: unknown[]) => {
    try {
      getAuthenticatedUserId(token); // Verify auth
      const userDataPath = app.getPath('userData');
      const settingsPath = path.join(userDataPath, 'settings.json');
      let settings: Record<string, unknown> = {};
      try {
        if (fs.existsSync(settingsPath)) {
          settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        }
      } catch { /* use empty */ }
      settings.agentConfigs = agentConfigs;
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  // Issue #3 (IDOR): Accept token instead of userId
  ipcMain.handle('setup:complete', async (_event, token: string) => {
    try {
      const userId = getAuthenticatedUserId(token);
      authService.markSetupComplete(userId);
      const userDataPath = app.getPath('userData');
      const settingsPath = path.join(userDataPath, 'settings.json');
      let settings: Record<string, unknown> = {};
      try {
        if (fs.existsSync(settingsPath)) {
          settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        }
      } catch { /* ignore */ }
      settings.setupComplete = true;
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });
}
