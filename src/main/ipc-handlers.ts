import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as authService from './auth-service';
import * as keyManager from './key-manager';

import { registerAuthHandlers, registerKeyHandlers, registerSetupHandlers } from './auth-handlers';
import { registerFileHandlers } from './file-handlers';
import { registerAgentHandlers, registerOpenClawHandlers, registerAssistantHandlers, registerDiscordHandlers } from './agent-handlers';
import { registerPaperHandlers } from './paper-handlers';
import { registerExperimentHandlers } from './experiment-handlers';
import { registerAuthorHandlers } from './author-handlers';
import { registerAuditHandlers } from './audit-handlers';
import { registerSystemHandlers, registerSettingsHandlers, registerUpdaterHandlers, registerSelfTestHandlers, registerGatewayHandlers } from './system-handlers';
import { registerOllamaHandlers } from './ollama-handlers';

// ---- Issue #1 (CRITICAL): Path resolution — works in dev and packaged ASAR builds ----
export const RESOURCES_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'resources')
  : path.join(__dirname, '..', '..', 'resources');

// ============================================================
// Security helpers
// ============================================================

/**
 * Issue #1 (CRITICAL): Workspace path guard.
 * Returns the user's configured workspace base. All file IPC operations
 * are restricted to paths within this directory.
 */
export function getWorkspaceBase(): string {
  const userDataPath = app.getPath('userData');
  const settingsPath = path.join(userDataPath, 'settings.json');
  try {
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;
      if (typeof settings.workspace === 'string' && settings.workspace.trim()) {
        return path.resolve(settings.workspace);
      }
    }
  } catch { /* fall through to default */ }
  return path.join(userDataPath, 'workspace');
}

export function isPathAllowed(targetPath: string): boolean {
  const base = getWorkspaceBase();
  const resolved = path.resolve(targetPath);

  // M1: Resolve symlinks to prevent a symlink inside the workspace from escaping it.
  // For paths that don't yet exist (write targets), resolve the parent directory instead.
  let realResolved = resolved;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch {
    // Path doesn't exist yet (new file write) — resolve the parent instead
    try {
      const parent = fs.realpathSync(path.dirname(resolved));
      realResolved = path.join(parent, path.basename(resolved));
    } catch {
      // Parent also doesn't exist — fall back to the original resolved path
      realResolved = resolved;
    }
  }

  return realResolved === base || realResolved.startsWith(base + path.sep);
}

/**
 * Issue #3 (CRITICAL IDOR): Verify JWT and extract userId.
 * Throws if the token is invalid or expired.
 */
export function getAuthenticatedUserId(token: string): number {
  const user = authService.getUser(token);
  if (!user) throw new Error('Unauthorized: invalid or expired token');
  return user.id;
}

/**
 * Issue #13: Validate agent name — reject path traversal characters.
 * Only allow alphanumeric, hyphen, underscore, and space.
 */
export function isValidAgentName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && !/[./\\]/.test(name);
}

// ---- Issue #16: Rate limiter for system:log-error (max 10/minute) ----
export let _logErrorCount = 0;
export let _logErrorWindowStart = Date.now();
export const LOG_ERROR_MAX_PER_MINUTE = 10;

export function isLogErrorRateLimited(): boolean {
  const now = Date.now();
  if (now - _logErrorWindowStart > 60000) {
    _logErrorCount = 0;
    _logErrorWindowStart = now;
  }
  _logErrorCount++;
  return _logErrorCount > LOG_ERROR_MAX_PER_MINUTE;
}

// ============================================================
// IPC Handler Registration
// ============================================================

export function registerIpcHandlers(): void {
  const authDb = authService.getAuthDb();
  keyManager.initKeyManager(authDb);

  registerAuthHandlers();
  registerKeyHandlers();
  registerSetupHandlers();
  registerSystemHandlers();
  registerAgentHandlers();
  registerFileHandlers();
  registerPaperHandlers();
  registerExperimentHandlers();
  registerAuthorHandlers();
  registerAuditHandlers();
  registerSettingsHandlers();
  registerOpenClawHandlers();
  registerAssistantHandlers();
  registerOllamaHandlers();
  registerUpdaterHandlers();
  registerSelfTestHandlers();
  registerDiscordHandlers();
  registerGatewayHandlers();
}
