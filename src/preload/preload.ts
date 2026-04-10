import { contextBridge, ipcRenderer } from 'electron';

// ============================================================
// ASRP Preload — contextBridge IPC API
// ============================================================
// All communication between renderer and main process goes
// through this typed bridge. nodeIntegration is OFF.
// ============================================================

type IpcResult<T = unknown> = Promise<T>;

function invoke<T = unknown>(channel: string, ...args: unknown[]): IpcResult<T> {
  return ipcRenderer.invoke(channel, ...args) as IpcResult<T>;
}

// ---- System API ----
const system = {
  info: () => invoke<{
    version: string; platform: string; arch: string;
    electron: string; node: string; resourcesPath: string;
  }>('system:info'),

  workspace: () => invoke<{ path: string }>('system:workspace'),

  openPath: (targetPath: string) =>
    invoke<{ success: boolean; error?: string }>('system:open-path', targetPath),

  selectDirectory: () =>
    invoke<{ canceled: boolean; path: string | null }>('system:select-directory'),

  health: () =>
    invoke<{ status: string; timestamp: string; uptime: number }>('system:health'),

  selfTest: () =>
    invoke<{
      success: boolean;
      error?: string;
      result: {
        passed: number;
        failed: number;
        errors: string[];
        details: Array<{ name: string; status: 'pass' | 'fail'; error?: string }>;
        durationMs: number;
      } | null;
    }>('system:self-test'),

  logError: (errorInfo: Record<string, unknown>) =>
    invoke<{ success: boolean }>('system:log-error', errorInfo),

  isHeadless: () =>
    invoke<{ headless: boolean; display: string | null; platform: string }>('system:is-headless'),
};

// ---- Agents API ----
const agents = {
  list: () =>
    invoke<{ agents: string[]; error?: string }>('agents:list'),

  get: (agentName: string) =>
    invoke<{ success: boolean; content?: string; error?: string }>('agents:get', agentName),

  status: () =>
    invoke<{ agents: Array<{ name: string; role: string; status: string; model: string }> }>('agents:status'),

  start: (token: string, agentName: string) =>
    invoke<{ success: boolean; message: string }>('agents:start', token, agentName),

  stop: (token: string, agentName: string) =>
    invoke<{ success: boolean; message: string }>('agents:stop', token, agentName),

  restart: (token: string, agentName: string) =>
    invoke<{ success: boolean; message: string }>('agents:restart', token, agentName),

  getSoul: (agentName: string) =>
    invoke<{ success: boolean; content?: string }>('agents:get-soul', agentName),

  // P0-fix: Now requires auth token
  saveSoul: (token: string, agentName: string, content: string) =>
    invoke<{ success: boolean; error?: string }>('agents:save-soul', token, agentName, content),

  rename: (token: string, oldName: string, newName: string) =>
    invoke<{ success: boolean; error?: string }>('agents:rename', token, oldName, newName),

  setModel: (token: string, agentName: string, model: string) =>
    invoke<{ success: boolean; error?: string }>('agents:set-model', token, agentName, model),

  // P0-fix: Now requires auth token
  logs: (token: string, agentName: string) =>
    invoke<{ logs: string[] }>('agents:logs', token, agentName),

  onStatusUpdate: (callback: (agents: unknown[]) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: unknown[]) => callback(data);
    ipcRenderer.on('agents:status-update', handler);
    return () => ipcRenderer.removeListener('agents:status-update', handler);
  },
};

// ---- Files API ----
const files = {
  list: (dirPath: string) =>
    invoke<{
      files: Array<{ name: string; path: string; isDirectory: boolean; size: number }>;
      error?: string;
    }>('files:list', dirPath),

  read: (filePath: string) =>
    invoke<{ success: boolean; content?: string; error?: string }>('files:read', filePath),

  write: (token: string, filePath: string, content: string) =>
    invoke<{ success: boolean; error?: string }>('files:write', token, filePath, content),

  delete: (token: string, filePath: string) =>
    invoke<{ success: boolean; error?: string }>('files:delete', token, filePath),

  copy: (token: string, srcPath: string, destPath: string) =>
    invoke<{ success: boolean; error?: string }>('files:copy', token, srcPath, destPath),

  openDialog: (options?: Electron.OpenDialogOptions) =>
    invoke<Electron.OpenDialogReturnValue>('files:open-dialog', options),

  saveDialog: (options?: Electron.SaveDialogOptions) =>
    invoke<Electron.SaveDialogReturnValue>('files:save-dialog', options),
};

// ---- Papers API ----
const papers = {
  list: () =>
    invoke<{ papers: Array<{ id: string; title: string; status: string; created: string }> }>('papers:list'),

  scan: () =>
    invoke<{ directories: Array<{ researchId: string; researchLabel: string; papers: Array<{ name: string; path: string; size: number; modified: string }> }> }>('papers:scan'),

  get: (paperId: string) =>
    invoke<{ success: boolean; paper?: Record<string, unknown>; error?: string }>('papers:get', paperId),

  create: (token: string, metadata: Record<string, unknown>) =>
    invoke<{ success: boolean; paperId?: string; error?: string }>('papers:create', token, metadata),

  update: (token: string, paperId: string, data: Record<string, unknown>) =>
    invoke<{ success: boolean; error?: string }>('papers:update', token, paperId, data),

  export: (paperId: string, format: string) =>
    invoke<{ success: boolean; message?: string; error?: string }>('papers:export', paperId, format),
};

// ---- Authors API ----
const authors = {
  list: () =>
    invoke<{ authors: Array<{ id: string; name: string; title: string; institution: string; email: string }>; projectDefaults: Array<{ researchId: string; authorIds: string[] }> }>('authors:list'),

  save: (token: string, author: Record<string, unknown>) =>
    invoke<{ success: boolean; id?: string; error?: string }>('authors:save', token, author),

  delete: (token: string, authorId: string) =>
    invoke<{ success: boolean; error?: string }>('authors:delete', token, authorId),

  setProjectDefaults: (token: string, researchId: string, authorIds: string[]) =>
    invoke<{ success: boolean; error?: string }>('authors:set-project-defaults', token, researchId, authorIds),
};

// ---- Experiments API ----
const experiments = {
  list: () =>
    invoke<{
      experiments: Array<{
        id: string; title: string; abstract: string; tags: string[];
        status: string; created: string; score: number | null; result: string | null;
      }>;
    }>('experiments:list'),

  get: (expId: string) =>
    invoke<{ success: boolean; experiment?: Record<string, unknown>; error?: string }>('experiments:get', expId),

  register: (token: string, hypothesis: string, metadata: Record<string, unknown>) =>
    invoke<{ success: boolean; id?: string; error?: string }>('experiments:register', token, hypothesis, metadata),

  update: (token: string, expId: string, data: Record<string, unknown>) =>
    invoke<{ success: boolean; error?: string }>('experiments:update', token, expId, data),

  updateStatus: (token: string, expId: string, status: string, extra?: Record<string, unknown>) =>
    invoke<{ success: boolean; error?: string }>('experiments:update-status', token, expId, status, extra),

  // SRW-v1: Create research + run Phase 0 bootstrap in one call.
  startResearch: (token: string, metadata: Record<string, unknown>) =>
    invoke<{
      success: boolean;
      id?: string;
      code?: string;
      title?: string;
      workflow?: {
        phase: string | null;
        discordChannelId: string | null;
        discordChannelName: string | null;
        warnings: string[];
      };
      error?: string;
    }>('experiments:start-research', token, metadata),
};

// ---- Workflows API (SRW-v1) ----
const workflows = {
  get: (token: string, researchId: string) =>
    invoke<{ success: boolean; state?: unknown; error?: string }>('workflows:get', token, researchId),
  list: (token: string) =>
    invoke<{ success: boolean; workflows?: unknown[]; error?: string }>('workflows:list', token),
  pause: (token: string, researchId: string) =>
    invoke<{ success: boolean; state?: unknown; error?: string }>('workflows:pause', token, researchId),
  resume: (token: string, researchId: string) =>
    invoke<{ success: boolean; state?: unknown; error?: string }>('workflows:resume', token, researchId),
  stop: (token: string, researchId: string) =>
    invoke<{ success: boolean; state?: unknown; error?: string }>('workflows:stop', token, researchId),
  markComplete: (token: string, researchId: string) =>
    invoke<{ success: boolean; state?: unknown; error?: string }>('workflows:mark-complete', token, researchId),
  start: (token: string, researchId: string) =>
    invoke<{ success: boolean; state?: unknown; warnings?: string[]; error?: string }>('workflows:start', token, researchId),
  tickNow: (token: string) =>
    invoke<{ success: boolean; error?: string }>('workflows:tick-now', token),
};

// ---- Audit API ----
const audit = {
  list: (options?: { limit?: number; offset?: number }) =>
    invoke<{
      entries: Array<{ time: string; agent: string; message: string; severity: string }>;
      total: number;
    }>('audit:list', options),

  log: (token: string, entry: Record<string, unknown>) =>
    invoke<{ success: boolean; error?: string }>('audit:log', token, entry),

  export: () =>
    invoke<{ success: boolean; message?: string; error?: string }>('audit:export'),
};

// ---- Settings API ----
const settings = {
  get: () =>
    invoke<Record<string, unknown>>('settings:get'),

  set: (token: string, updates: Record<string, unknown>) =>
    invoke<{ success: boolean; settings?: Record<string, unknown>; error?: string }>('settings:set', token, updates),

  reset: (token: string) =>
    invoke<{ success: boolean; settings?: Record<string, unknown>; error?: string }>('settings:reset', token),
};

// ---- Auth API ----
const auth = {
  register: (name: string, email: string, password: string) =>
    invoke<{ success: boolean; token?: string; user?: { id: number; name: string; email: string }; error?: string }>(
      'auth:register', name, email, password
    ),

  login: (email: string, password: string) =>
    invoke<{ success: boolean; token?: string; user?: { id: number; name: string; email: string }; error?: string }>(
      'auth:login', email, password
    ),

  logout: (token: string) =>
    invoke<{ success: boolean }>('auth:logout', token),

  user: (token: string) =>
    invoke<{ id: number; name: string; email: string; setupComplete: boolean } | null>(
      'auth:user', token
    ),

  // Issue #29: auth:setup-complete consolidated into setup:complete — kept as no-op shim for compat
  setupComplete: (token: string) =>
    invoke<{ success: boolean; error?: string }>('auth:setup-complete', token),
};

// ---- Keys API ----
const keys = {
  assignTrial: (token: string) =>
    invoke<{ success: boolean; key?: string; error?: string }>('keys:assign-trial', token),

  get: (token: string) =>
    invoke<{ key: string | null }>('keys:get', token),

  validate: (key: string) =>
    invoke<{ valid: boolean; error?: string }>('keys:validate', key),

  validateProvider: (provider: string, key: string) =>
    invoke<{ valid: boolean; provider: string; error?: string }>('keys:validate-provider', provider, key),

  providerList: () =>
    invoke<{ providers: Array<{ id: string; name: string; placeholder: string }> }>('keys:provider-list'),
};

// ---- Setup API ----
const setup = {
  // Issue #3 (IDOR fix): accept token instead of raw userId
  saveProfile: (token: string, profile: Record<string, string>) =>
    invoke<{ success: boolean; error?: string }>('setup:save-profile', token, profile),

  saveKeys: (token: string, apiKeys: Record<string, string>) =>
    invoke<{ success: boolean; error?: string }>('setup:save-keys', token, apiKeys),

  initAgents: (token: string) =>
    invoke<{ success: boolean; error?: string }>('setup:init-agents', token),

  saveAgentConfig: (token: string, agentConfigs: unknown[]) =>
    invoke<{ success: boolean; error?: string }>('setup:save-agent-config', token, agentConfigs),

  complete: (token: string) =>
    invoke<{ success: boolean; error?: string }>('setup:complete', token),
};

// ---- OpenClaw Bridge API ----
const openclaw = {
  agentStatuses: () =>
    invoke<{ agents: unknown[] }>('openclaw:agent-statuses'),

  workspaceStats: () =>
    invoke<{ experiments: number; confirmed: number; refuted: number; papers: number }>('openclaw:workspace-stats'),

  tokenUsage: () =>
    invoke<{
      models: Array<{ name: string; input: number; output: number; cost: number; budget: number; pct: number }>;
      dailyTotal: number;
      dailyBudget: number;
      pct: number;
    }>('openclaw:token-usage'),

  researchProgress: () =>
    invoke<{ rh: number; sc: number; bc: number }>('openclaw:research-progress'),

  gatewayStatus: () =>
    invoke<{ running: boolean; pid: number | null; uptime: number }>('openclaw:gateway-status'),
};

// ---- Assistant Chat API ----
const assistant = {
  chat: (token: string, message: string, context?: string, preferredModel?: string) =>
    invoke<{ success: boolean; reply: string; model: string; error?: string }>(
      'assistant:chat', token, message, context, preferredModel
    ),

  getModel: () =>
    invoke<{ model: string; type: 'local' | 'cloud' }>('assistant:get-model'),

  history: () =>
    invoke<{ messages: Array<{ role: string; content: string; ts: string }> }>('assistant:history'),

  saveMessage: (token: string, role: string, content: string) =>
    invoke<{ success: boolean; error?: string }>('assistant:save-message', token, role, content),

  clearHistory: (token: string) =>
    invoke<{ success: boolean; error?: string }>('assistant:clear-history', token),

  onToggle: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('assistant:toggle', handler);
    return () => ipcRenderer.removeListener('assistant:toggle', handler);
  },
};

// ---- Ollama Local AI API ----
const ollama = {
  status: () =>
    invoke<{
      installed: boolean;
      running: boolean;
      models: string[];
      downloading: boolean;
      downloadProgress: number;
      downloadSpeed: string;
      downloadEta: string;
      downloadModel: string;
    }>('ollama:status'),

  detectHardware: () =>
    invoke<{
      success: boolean;
      hardware?: { ram: number; gpu: string; gpuVram: number; os: string; arch: string };
      recommendation?: 'recommended' | 'possible_slow' | 'not_recommended';
      error?: string;
    }>('ollama:detect-hardware'),

  pullModel: (token: string, modelName?: string) =>
    invoke<{ success: boolean; message?: string; error?: string }>('ollama:pull-model', token, modelName),

  cancelPull: () =>
    invoke<{ success: boolean; error?: string }>('ollama:cancel-pull'),

  listModels: () =>
    invoke<{ success: boolean; models: string[]; error?: string }>('ollama:list-models'),

  chat: (messages: Array<{ role: string; content: string }>, model?: string) =>
    invoke<{ success: boolean; reply: string; error?: string }>('ollama:chat', messages, model),

  deleteModel: (token: string, modelName: string) =>
    invoke<{ success: boolean; error?: string }>('ollama:delete-model', token, modelName),

  start: (token: string) =>
    invoke<{ success: boolean; error?: string }>('ollama:start', token),

  stop: (token: string) =>
    invoke<{ success: boolean; error?: string }>('ollama:stop', token),

  installInstructions: () =>
    invoke<{ url: string; instructions: string }>('ollama:install-instructions'),

  onDownloadProgress: (callback: (data: {
    progress: number; speed: string; eta: string; model: string; status: string;
  }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: {
      progress: number; speed: string; eta: string; model: string; status: string;
    }) => callback(data);
    ipcRenderer.on('ollama:download-progress', handler);
    return () => ipcRenderer.removeListener('ollama:download-progress', handler);
  },

  onDownloadComplete: (callback: (data: { model: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { model: string }) => callback(data);
    ipcRenderer.on('ollama:download-complete', handler);
    return () => ipcRenderer.removeListener('ollama:download-complete', handler);
  },

  onDownloadError: (callback: (data: { model: string; error: string }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: { model: string; error: string }) => callback(data);
    ipcRenderer.on('ollama:download-error', handler);
    return () => ipcRenderer.removeListener('ollama:download-error', handler);
  },
};

// ---- Auto-Updater API ----
const updater = {
  status: () =>
    invoke<{
      checking: boolean; available: boolean; downloading: boolean;
      ready: boolean; version: string | null; progress: number; error: string | null;
    }>('updater:status'),

  check: () =>
    invoke<{ success: boolean; error?: string }>('updater:check'),

  download: (token: string) =>
    invoke<{ success: boolean; error?: string }>('updater:download', token),

  install: (token: string) =>
    invoke<{ success: boolean; error?: string }>('updater:install', token),

  onStatus: (callback: (status: {
    checking: boolean; available: boolean; downloading: boolean;
    ready: boolean; version: string | null; progress: number; error: string | null;
  }) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: {
      checking: boolean; available: boolean; downloading: boolean;
      ready: boolean; version: string | null; progress: number; error: string | null;
    }) => callback(data);
    ipcRenderer.on('updater:status', handler);
    return () => ipcRenderer.removeListener('updater:status', handler);
  },
};

// ---- Discord Bot Configuration API ----
const discord = {
  validateToken: (token: string) =>
    invoke<{ valid: boolean; botName?: string; botId?: string; botTag?: string; error?: string }>(
      'discord:validate-token', token
    ),

  inviteUrl: (botAppId: string, guildId?: string) =>
    invoke<{ url: string }>('discord:invite-url', botAppId, guildId),

  listChannels: (token: string, guildId: string) =>
    invoke<{ channels: Array<{ id: string; name: string }>; error?: string }>(
      'discord:list-channels', token, guildId
    ),

  checkGuild: (token: string, guildId: string) =>
    invoke<{ inGuild: boolean; guildName?: string; error?: string }>(
      'discord:check-guild', token, guildId
    ),

  openUrl: (url: string) =>
    invoke<{ success: boolean; error?: string }>('discord:open-url', url),

  // P0-fix: Now requires auth token
  createChannel: (token: string, channelName: string) =>
    invoke<{ success: boolean; channelId?: string; channelName?: string; error?: string }>(
      'discord:create-channel', token, channelName
    ),

  postMessage: (token: string, channelId: string, content: string) =>
    invoke<{ success: boolean; messageId?: string; error?: string }>(
      'discord:post-message', token, channelId, content
    ),
};

// ---- OpenClaw Gateway API ----
const gateway = {
  status: () =>
    invoke<{
      installed: boolean;
      version: string | null;
      agents: Array<{
        name: string; role: string; port: number;
        running: boolean; pid: number | null; uptime: number; error: string | null;
      }>;
      error: string | null;
    }>('gateway:status'),

  // P0-fix: Now requires auth token
  start: (token: string) =>
    invoke<{ results: Array<{ name: string; success: boolean; error?: string }> }>('gateway:start', token),

  stop: (token: string) =>
    invoke<{ success: boolean }>('gateway:stop', token),

  restart: (token: string, agentName?: string) =>
    invoke<{ success: boolean; error?: string }>('gateway:restart', token, agentName),

  install: (token: string) =>
    invoke<{ success: boolean; error?: string }>('gateway:install', token),

  setupAndStart: (token: string, agentConfigs: Array<{
    name: string; role: string; model: string; discordToken: string; customName?: string;
  }>, guildId: string) =>
    invoke<{ success: boolean; error?: string }>('gateway:setup-and-start', token, agentConfigs, guildId),

  hasConfig: () =>
    invoke<{ hasConfig: boolean }>('gateway:has-config'),

  checkUpdate: () =>
    invoke<{ updateAvailable: boolean; currentVersion: string | null; latestVersion: string | null }>(
      'gateway:check-update'
    ),

  logs: (token: string) =>
    invoke<{ status: unknown; installed: boolean; binary: string | null }>(
      'gateway:logs', token
    ),
};

// ---- Navigation events from main process ----
const on = (channel: 'navigate', callback: (route: string) => void): (() => void) => {
  const allowedChannels = ['navigate'] as const;
  if (!allowedChannels.includes(channel as typeof allowedChannels[number])) {
    throw new Error(`Channel ${channel} not allowed`);
  }
  const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => {
    callback(args[0] as string);
  };
  ipcRenderer.on(channel, handler);
  // Return unsubscribe function
  return () => ipcRenderer.removeListener(channel, handler);
};

// ============================================================
// Expose to renderer via contextBridge
// ============================================================
contextBridge.exposeInMainWorld('asrp', {
  system,
  agents,
  files,
  papers,
  authors,
  experiments,
  workflows,
  audit,
  settings,
  auth,
  keys,
  setup,
  openclaw,
  assistant,
  ollama,
  updater,
  discord,
  gateway,
  on,
});
