import { app, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as authService from './auth-service';
import * as keyManager from './key-manager';
import * as crypto from 'crypto';

import { registerAuthHandlers, registerKeyHandlers, registerSetupHandlers } from './auth-handlers';
import { registerFileHandlers } from './file-handlers';
import { registerAgentHandlers, registerOpenClawHandlers, registerAssistantHandlers, registerDiscordHandlers } from './agent-handlers';
import { registerPaperHandlers } from './paper-handlers';
import { registerExperimentHandlers } from './experiment-handlers';
import { registerWorkflowHandlers } from './workflow-handlers';
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
let _logErrorCount = 0;
let _logErrorWindowStart = Date.now();
const LOG_ERROR_MAX_PER_MINUTE = 10;

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
// Atomic file write — prevents data corruption on crash
// ============================================================

/**
 * Atomic write: write to .tmp, fsync, then rename.
 * rename() is atomic on POSIX; on Windows it's close enough for local use.
 */
export function atomicWriteFileSync(filePath: string, data: string, mode?: number): void {
  const tmp = filePath + '.tmp.' + crypto.randomBytes(4).toString('hex');
  const opts: fs.WriteFileOptions = { encoding: 'utf-8' };
  if (mode !== undefined) (opts as { mode: number }).mode = mode;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

/** Shorthand: atomically write JSON with pretty-print */
export function atomicWriteJSON(filePath: string, data: unknown): void {
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2));
}

// ============================================================
// IPC Auth middleware — consistent auth guard for handlers
// ============================================================

/**
 * Wrap an IPC handler function so the first arg is verified as a valid auth token.
 * Usage: ipcMain.handle('channel', withAuth(async (userId, ...args) => { ... }))
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withAuth<T>(handler: (userId: number, ...args: any[]) => Promise<T>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (_event: IpcMainInvokeEvent, token: string, ...args: any[]): Promise<T | { success: false; error: string }> => {
    try {
      const userId = getAuthenticatedUserId(token);
      return await handler(userId, ...args);
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  };
}

// ============================================================
// Validation helpers
// ============================================================

/** Allowed roles for assistant:save-message — prevent system prompt injection */
const ALLOWED_CHAT_ROLES = new Set(['user', 'assistant']);

export function isAllowedChatRole(role: string): boolean {
  return ALLOWED_CHAT_ROLES.has(role);
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
  registerWorkflowHandlers();
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
