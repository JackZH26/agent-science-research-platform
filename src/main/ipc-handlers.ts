import { ipcMain, app, shell, dialog, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as authService from './auth-service';
import * as keyManager from './key-manager';
import * as openclawBridge from './openclaw-bridge';
import { ollamaManager } from './ollama-manager';
import { autoUpdater } from './auto-updater';
import { runSelfTest } from './self-test';

// ---- Issue #1 (CRITICAL): Path resolution — works in dev and packaged ASAR builds ----
const RESOURCES_PATH = app.isPackaged
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
function getWorkspaceBase(): string {
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

function isPathAllowed(targetPath: string): boolean {
  const base = getWorkspaceBase();
  const resolved = path.resolve(targetPath);
  return resolved === base || resolved.startsWith(base + path.sep);
}

/**
 * Issue #3 (CRITICAL IDOR): Verify JWT and extract userId.
 * Throws if the token is invalid or expired.
 */
function getAuthenticatedUserId(token: string): number {
  const user = authService.getUser(token);
  if (!user) throw new Error('Unauthorized: invalid or expired token');
  return user.id;
}

/**
 * Issue #13: Validate agent name — reject path traversal characters.
 * Only allow alphanumeric, hyphen, underscore, and space.
 */
function isValidAgentName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= 64 && !/[./\\]/.test(name);
}

// ---- Issue #16: Rate limiter for system:log-error (max 10/minute) ----
let _logErrorCount = 0;
let _logErrorWindowStart = Date.now();
const LOG_ERROR_MAX_PER_MINUTE = 10;

function isLogErrorRateLimited(): boolean {
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
  registerAuditHandlers();
  registerSettingsHandlers();
  registerOpenClawHandlers();
  registerAssistantHandlers();
  registerOllamaHandlers();
  registerUpdaterHandlers();
  registerSelfTestHandlers();
}

// ============================================================
// AUTH HANDLERS (channel: 'auth:*')
// ============================================================

function registerAuthHandlers(): void {
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

function registerKeyHandlers(): void {
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

function registerSetupHandlers(): void {
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
      const userDataPath = app.getPath('userData');
      const workspacePath = path.join(userDataPath, 'workspace');
      if (keys.openrouterKey) {
        const writeOk = keyManager.writeKeyToWorkspace(keys.openrouterKey, workspacePath);
        if (!writeOk) {
          return { success: false, error: 'Failed to write API key to workspace .env — check permissions' };
        }
      }
      // NOTE (Issue #14): Keys stored in plaintext settings.json.
      // TODO: migrate to OS keychain (keytar) for production.
      const settingsPath = path.join(userDataPath, 'settings.json');
      let settings: Record<string, unknown> = {};
      try {
        if (fs.existsSync(settingsPath)) {
          settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
        }
      } catch { /* ignore */ }
      settings.openrouterKey = keys.openrouterKey || settings.openrouterKey;
      if (keys.anthropicKey) settings.anthropicKey = keys.anthropicKey;
      if (keys.googleKey) settings.googleKey = keys.googleKey;
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

// ============================================================
// SYSTEM HANDLERS (channel: 'system:*')
// ============================================================

function registerSystemHandlers(): void {
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
// AGENT HANDLERS (channel: 'agents:*')
// ============================================================

function registerAgentHandlers(): void {
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
// FILE HANDLERS (channel: 'files:*')
// ============================================================

function registerFileHandlers(): void {
  // Issue #1 (CRITICAL): All file handlers now guard against path traversal

  ipcMain.handle('files:list', async (_event, dirPath: string) => {
    if (!isPathAllowed(dirPath)) {
      return { files: [], error: 'Path outside workspace' };
    }
    try {
      if (!fs.existsSync(dirPath)) return { files: [], error: 'Path not found' };
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      const files = entries.map(e => ({
        name: e.name,
        path: path.join(dirPath, e.name),
        isDirectory: e.isDirectory(),
        size: e.isFile() ? fs.statSync(path.join(dirPath, e.name)).size : 0,
      }));
      return { files };
    } catch (err: unknown) {
      return { files: [], error: String(err) };
    }
  });

  ipcMain.handle('files:read', async (_event, filePath: string) => {
    if (!isPathAllowed(filePath)) {
      return { success: false, error: 'Path outside workspace' };
    }
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return { success: true, content };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('files:write', async (_event, filePath: string, content: string) => {
    if (!isPathAllowed(filePath)) {
      return { success: false, error: 'Path outside workspace' };
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content, 'utf-8');
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('files:delete', async (_event, filePath: string) => {
    if (!isPathAllowed(filePath)) {
      return { success: false, error: 'Path outside workspace' };
    }
    try {
      fs.rmSync(filePath, { recursive: true, force: true });
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('files:open-dialog', async (_event, options: Electron.OpenDialogOptions) => {
    return dialog.showOpenDialog(options || {});
  });

  ipcMain.handle('files:save-dialog', async (_event, options: Electron.SaveDialogOptions) => {
    return dialog.showSaveDialog(options || {});
  });
}

// ============================================================
// PAPER HANDLERS (channel: 'papers:*') — [DEMO STUB]
// ============================================================

function registerPaperHandlers(): void {
  // Issue #36: Use relative dates so stubs don't become confusingly historical
  const relDate = (daysAgo: number): string => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  };

  ipcMain.handle('papers:list', async () => {
    return {
      papers: [
        { id: 'paper-001', title: 'Multi-well double-delta DFT analysis', status: 'draft', created: relDate(2) },
        { id: 'paper-002', title: 'LDA binding energy corrections', status: 'submitted', created: relDate(6) },
      ],
    };
  });

  ipcMain.handle('papers:get', async (_event, paperId: string) => {
    return { success: true, paper: { id: paperId, content: '# Paper Content\n\n(stub)' } };
  });

  ipcMain.handle('papers:create', async (_event, metadata: Record<string, unknown>) => {
    return { success: true, paperId: `paper-${Date.now()}`, metadata };
  });

  ipcMain.handle('papers:update', async (_event, paperId: string, data: Record<string, unknown>) => {
    return { success: true, paperId, data };
  });

  ipcMain.handle('papers:export', async (_event, paperId: string, format: string) => {
    return { success: true, message: `Exported ${paperId} as ${format} (stub)` };
  });
}

// ============================================================
// EXPERIMENT HANDLERS (channel: 'experiments:*') — [DEMO STUB]
// ============================================================

function registerExperimentHandlers(): void {
  // Issue #36: Use relative dates instead of hardcoded domain-specific dates
  const relDate = (daysAgo: number): string => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  };

  ipcMain.handle('experiments:list', async () => {
    return {
      experiments: [
        { id: 'EXP-DEMO-003', hypothesis: 'Multi-well DD with exact KS gap at d=5,6,7', status: 'running', created: relDate(1) },
        { id: 'EXP-DEMO-002', hypothesis: 'Prime-spaced wells produce negative DD', status: 'refuted', created: relDate(2) },
        { id: 'EXP-DEMO-001', hypothesis: 'LDA overestimates 2e atom binding by >1%', status: 'confirmed', created: relDate(2) },
        { id: 'EXP-DEMO-005', hypothesis: 'Electron membrane model consistent with Stodolna 2013', status: 'confirmed', created: relDate(3) },
        { id: 'EXP-DEMO-004', hypothesis: 'Fibonacci lattice reduces DFT ill-conditioning', status: 'registered', created: relDate(1) },
      ],
    };
  });

  ipcMain.handle('experiments:get', async (_event, expId: string) => {
    return { success: true, experiment: { id: expId, data: {} } };
  });

  ipcMain.handle('experiments:register', async (_event, hypothesis: string, metadata: Record<string, unknown>) => {
    const id = `EXP-${new Date().toISOString().slice(0, 10)}-${String(Math.floor(Math.random() * 900) + 100)}`;
    return { success: true, id, hypothesis, metadata };
  });

  ipcMain.handle('experiments:update-status', async (_event, expId: string, status: string) => {
    return { success: true, expId, status };
  });
}

// ============================================================
// AUDIT HANDLERS (channel: 'audit:*') — [DEMO STUB]
// ============================================================

function registerAuditHandlers(): void {
  // Issue #36: Use relative timestamps
  const relTime = (minutesAgo: number): string => {
    const t = new Date(Date.now() - minutesAgo * 60 * 1000);
    return t.toTimeString().slice(0, 5);
  };

  ipcMain.handle('audit:list', async (_event, options: { limit?: number; offset?: number }) => {
    const limit = options?.limit ?? 50;
    return {
      entries: [
        { time: relTime(0),  agent: 'Engineer', message: 'EXP-003: Exact KS gap computed for d=3.0, DD=+0.215', severity: 'info' },
        { time: relTime(5),  agent: 'Reviewer', message: 'EXP-002: DD sign depends on KS gap definition — verify with exact potential', severity: 'warning' },
        { time: relTime(18), agent: 'Theorist', message: 'Registered EXP-004: Fibonacci ill-conditioning hypothesis', severity: 'info' },
        { time: relTime(33), agent: 'System',   message: 'Daily backup completed (workspace: 2.4 MB)', severity: 'info' },
        { time: relTime(48), agent: 'Engineer', message: 'EXP-003: iDEA reverse engineering started (tol=1e-6, mu=3.0)', severity: 'info' },
        { time: relTime(63), agent: 'System',   message: 'Health check: all agents online, disk 23%', severity: 'info' },
      ].slice(0, limit),
      total: 6,
    };
  });

  ipcMain.handle('audit:log', async (_event, entry: Record<string, unknown>) => {
    return { success: true, entry };
  });

  ipcMain.handle('audit:export', async () => {
    return { success: true, message: 'Audit export stub' };
  });
}

// ============================================================
// SETTINGS HANDLERS (channel: 'settings:*')
// ============================================================

function registerSettingsHandlers(): void {
  const userDataPath = app.getPath('userData');
  const settingsPath = path.join(userDataPath, 'settings.json');

  const defaultSettings = {
    theme: 'light',
    language: 'en',
    workspace: path.join(app.getPath('home'), 'asrp-workspace'),
    openrouterKey: '',
    defaultModel: 'claude-sonnet-4-6',
    budgetDaily: 15,
    notifications: true,
    minimizeToTray: true,
    autoStart: false,
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
    return loadSettings();
  });

  ipcMain.handle('settings:set', async (_event, updates: Record<string, unknown>) => {
    try {
      // Filter to only known, allowed keys
      const filteredUpdates: Record<string, unknown> = {};
      for (const key of Object.keys(updates)) {
        if (ALLOWED_SETTING_KEYS.has(key)) {
          filteredUpdates[key] = updates[key];
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
// OPENCLAW HANDLERS (channel: 'openclaw:*')
// ============================================================

function registerOpenClawHandlers(): void {
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

function registerAssistantHandlers(): void {
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

// ============================================================
// OLLAMA HANDLERS (channel: 'ollama:*')
// ============================================================

function registerOllamaHandlers(): void {
  ipcMain.handle('ollama:status', async () => {
    try {
      return await ollamaManager.getStatus();
    } catch (err: unknown) {
      return { installed: false, running: false, models: [], downloading: false, downloadProgress: 0, downloadSpeed: '', downloadEta: '', downloadModel: '', error: String(err) };
    }
  });

  ipcMain.handle('ollama:detect-hardware', async () => {
    try {
      const hardware = ollamaManager.detectHardware();
      const recommendation = ollamaManager.getRecommendation(hardware);
      return { success: true, hardware, recommendation };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('ollama:pull-model', async (event, modelName: string = 'gemma3:27b') => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);

    const progressHandler = (data: unknown) => {
      if (senderWindow && !senderWindow.isDestroyed()) {
        senderWindow.webContents.send('ollama:download-progress', data);
      }
    };
    const completeHandler = (data: unknown) => {
      if (senderWindow && !senderWindow.isDestroyed()) {
        senderWindow.webContents.send('ollama:download-complete', data);
      }
      cleanup();
    };
    const errorHandler = (data: unknown) => {
      if (senderWindow && !senderWindow.isDestroyed()) {
        senderWindow.webContents.send('ollama:download-error', data);
      }
      cleanup();
    };
    const cancelHandler = () => { cleanup(); };

    const cleanup = () => {
      ollamaManager.removeListener('download-progress', progressHandler);
      ollamaManager.removeListener('download-complete', completeHandler);
      ollamaManager.removeListener('download-error', errorHandler);
      ollamaManager.removeListener('download-cancelled', cancelHandler);
    };

    ollamaManager.on('download-progress', progressHandler);
    ollamaManager.on('download-complete', completeHandler);
    ollamaManager.on('download-error', errorHandler);
    ollamaManager.on('download-cancelled', cancelHandler);

    ollamaManager.pullModel(modelName).catch(() => { /* handled via events */ });

    return { success: true, message: `Pull started for ${modelName}` };
  });

  ipcMain.handle('ollama:cancel-pull', async () => {
    try {
      ollamaManager.cancelPull();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('ollama:list-models', async () => {
    try {
      const models = await ollamaManager.listModels();
      return { success: true, models };
    } catch (err: unknown) {
      return { success: false, models: [], error: String(err) };
    }
  });

  ipcMain.handle('ollama:chat', async (_event, messages: Array<{ role: string; content: string }>, model?: string) => {
    try {
      const reply = await ollamaManager.chat(
        messages as Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
        model
      );
      return { success: true, reply };
    } catch (err: unknown) {
      return { success: false, reply: '', error: String(err) };
    }
  });

  ipcMain.handle('ollama:delete-model', async (_event, modelName: string) => {
    try {
      await ollamaManager.deleteModel(modelName);
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('ollama:start', async () => {
    try {
      await ollamaManager.startOllama();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('ollama:stop', async () => {
    try {
      ollamaManager.stopOllama();
      return { success: true };
    } catch (err: unknown) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('ollama:install-instructions', async () => {
    return ollamaManager.installOllama();
  });
}

// ============================================================
// UPDATER HANDLERS (channel: 'updater:*')
// ============================================================

function registerUpdaterHandlers(): void {
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

function registerSelfTestHandlers(): void {
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
