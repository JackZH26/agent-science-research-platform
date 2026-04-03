# ASRP Desktop — Comprehensive 5-Round Code Review Report

**Date:** 2026-04-03
**Reviewer:** Claude Sonnet 4.6 (automated security + quality audit)
**Codebase:** ASRP Desktop v1.0.0 — Electron app, 91 tasks, AI-generated in single session
**Scope:** All TypeScript source files, renderer JS/HTML, config, and build manifests

---

## Round 1: Security Audit

---

### 🔴 CRITICAL — Path Traversal: Unrestricted Filesystem Access

**File: `src/main/ipc-handlers.ts:282–339`**

**Impact:** The `files:list`, `files:read`, `files:write`, and `files:delete` IPC handlers accept arbitrary `filePath`/`dirPath` strings from the renderer with **zero path validation or sandboxing**. Any renderer script can:
- Read `/etc/passwd`, `~/.ssh/id_rsa`, `~/.aws/credentials`
- Overwrite any file the process has permission to write
- Delete any file/directory on the system (`rmSync` with `recursive: true, force: true`)

```typescript
// files:read — no guard
ipcMain.handle('files:read', async (_event, filePath: string) => {
  const content = fs.readFileSync(filePath, 'utf-8');  // ANY path
  return { success: true, content };
});

// files:delete — recursive force delete with no guard
ipcMain.handle('files:delete', async (_event, filePath: string) => {
  fs.rmSync(filePath, { recursive: true, force: true });  // ANY path
```

**Fix:** Resolve the path against an allowed base directory and reject anything outside it:
```typescript
const allowedBase = path.resolve(app.getPath('userData'), 'workspace');
const resolved = path.resolve(filePath);
if (!resolved.startsWith(allowedBase + path.sep)) {
  return { success: false, error: 'Path outside workspace' };
}
```
Apply this guard to `files:list`, `files:read`, `files:write`, and `files:delete`.

---

### 🔴 CRITICAL — IDOR: No Auth Enforcement on Privileged IPC Channels

**Files: `src/main/ipc-handlers.ts:77,81,96,105,133,138,62`**

**Impact:** Multiple IPC handlers accept a `userId` parameter directly without verifying the caller is the authenticated user for that ID. Any renderer code can forge calls on behalf of any userId:

```typescript
ipcMain.handle('keys:assign-trial', async (_event, userId: number) => {
  return keyManager.assignTrialKey(userId);  // No auth check
});

ipcMain.handle('setup:save-profile', async (_event, userId: number, profile) => {
  authService.saveProfile(userId, profile);  // No auth check
});

ipcMain.handle('setup:complete', async (_event, userId: number) => {
  authService.markSetupComplete(userId);     // No auth check
});
```

A malicious call with `userId=1` can mark any user's setup complete, reassign trial keys to themselves, or overwrite profile data for another user.

**Fix:** Pass the JWT token and verify it on every privileged channel. Extract the `userId` from the verified token in the main process rather than accepting it as a parameter from the renderer.

---

### 🔴 CRITICAL — RESOURCES_PATH Resolves Incorrectly in Packaged App

**File: `src/main/ipc-handlers.ts:11–12`**

**Impact:**

```typescript
const APP_ROOT = path.join(__dirname, '..', '..');
const RESOURCES_PATH = path.join(APP_ROOT, 'resources');
```

In development: `dist/main/` → `dist/` → project root → `project/resources/` ✓
In packaged ASAR: `app.asar/dist/main/` → `app.asar/dist/` → `app.asar/` → `app.asar/resources/`

The actual resources in a packaged build are placed by `electron-builder` at `process.resourcesPath/resources/` (outside the ASAR). This means ALL of the following IPC handlers fail silently in production builds:
- `agents:list` → returns `{ agents: [] }`
- `agents:get` → returns `{ success: false, error: 'Agent not found' }`
- `agents:get-soul` → falls through to bridge stub
- `agents:save-soul` → writes to wrong location, silently fails

**Fix:** Use `process.resourcesPath` in packaged builds:
```typescript
const RESOURCES_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'resources')
  : path.join(__dirname, '..', '..', 'resources');
```

---

### 🟠 HIGH — XSS: `message` Injected Unsanitized into `innerHTML` in Toast

**File: `src/renderer/index.html:219`**

**Impact:** The global `showToast` function injects the `message` string directly into innerHTML without sanitization:

```javascript
toast.innerHTML = '<span>' + (icons[type] || '') + '</span>' +
                  '<span style="flex:1">' + message + '</span>';
```

Error messages from IPC calls (e.g., `String(err)` from the main process) are propagated to toast. Any data that flows through the error path from untrusted external sources (files read from disk, agent log content, workspace data) could inject HTML/script into the page.

**Fix:** Set `toast.textContent` for the message span or run through `DOMPurify`/manual HTML-entity escaping before inserting.

---

### 🟠 HIGH — Placeholder Trial Keys Hardcoded in Compiled Binary

**File: `src/main/key-manager.ts:6–12`**

**Impact:**

```typescript
const TRIAL_KEYS = [
  'sk-or-trial-key-001-placeholder-asrp-2026',
  ...
];
```

These strings will be present verbatim in `dist/main/key-manager.js` and in packaged app bundles (`app.asar`). Anyone can extract them with `asar extract` or `strings`. If replaced with real API keys before distribution (as the comment instructs), those real keys will be fully exposed in the binary to any user who downloads the app.

**Fix:** Trial keys must **never** be hardcoded in application binaries. Implement server-side key assignment: the app contacts an ASRP endpoint with a user token, and the server distributes a key. The key should be stored only in the OS keychain, not in files or source code.

---

### 🟠 HIGH — XSS: `err.message` Injected into innerHTML in Router Error Display

**File: `src/renderer/js/router.js:127`**

**Impact:**

```javascript
document.getElementById('page-content').innerHTML = `
  ...
  <p ...>${err.message}</p>
  ...`;
```

`err.message` is set from a network error or fetch failure. While the current fetch only loads local `file://` pages, this pattern is unsafe and will become exploitable if the CSP or fetch source changes.

**Fix:** Use `textContent` to set error messages, or escape before interpolation.

---

### 🟠 HIGH — Duplicate `navigate` Event Listener Registration

**Files: `src/renderer/js/router.js:187–190`, `src/renderer/index.html:143–146`**

**Impact:** Two separate listeners are registered for the `navigate` IPC event:

```javascript
// router.js (inside Router.init())
window.asrp.on('navigate', (route) => { navigate(route); });

// index.html (inline script)
window.asrp.on('navigate', (route) => { Router.navigate(route); });
```

Every `navigate` event from the main process (tray menu, global shortcut, preferences click) fires both handlers. The first navigation call updates `currentRoute`, so the second call's `if (currentRoute === resolvedPath) return` may short-circuit — but this is a fragile coincidence. The double registration also leaks ipcRenderer listeners.

**Fix:** Remove the duplicate from `index.html`. The router's `init()` already handles this correctly.

---

### 🟠 HIGH — `agents:save-soul` Writes to App Bundle / ASAR (Breaks Packaged App)

**File: `src/main/ipc-handlers.ts:549–558`**

**Impact:**

```typescript
ipcMain.handle('agents:save-soul', async (_event, agentName: string, content: string) => {
  const soulPath = path.join(RESOURCES_PATH, 'agents', `${agentName.toLowerCase()}-soul.md`);
  fs.writeFileSync(soulPath, content, 'utf-8');
```

In a packaged app:
1. The ASAR is read-only — this write will throw `EROFS` or silently fail
2. Even if it somehow succeeded, writing into a signed macOS app bundle invalidates the code signature
3. With the RESOURCES_PATH bug above, even the path is wrong

**Fix:** Store user-modified SOUL files in `app.getPath('userData')/agents/` and read from there first, falling back to the packaged defaults.

---

### 🟠 HIGH — `system:workspace` Returns Wrong Path

**File: `src/main/ipc-handlers.ts:178–182`**

**Impact:**

```typescript
ipcMain.handle('system:workspace', async () => {
  const workspacePath = path.join(app.getPath('userData'), 'workspace');
  return { path: workspacePath };
});
```

This always returns an internal `$userData/workspace` path. The user can configure a different workspace path in Settings (`settings.workspace` defaults to `~/asrp-workspace`). The file browser presumably uses `system:workspace` to determine what to show, meaning it always shows the internal hidden directory instead of the user's configured workspace.

**Fix:** Load the `workspace` value from `settings.json` and return that.

---

### 🟡 MEDIUM — No Password Strength or Email Validation on Registration

**File: `src/main/ipc-handlers.ts:45–47`, `src/main/auth-service.ts:65–85`**

**Impact:** `auth:register` accepts any string for `name`, `email`, and `password` with no validation:
- Passwords can be 1 character long
- Email addresses are not validated (no `@` required)
- Names can be empty strings

The `bcrypt.hashSync` will still work, but a user with a trivial password would have their account easily compromised if the database file were exfiltrated.

**Fix:** Enforce minimum password length (≥12 chars), validate email format with a regex, and require non-empty name.

---

### 🟡 MEDIUM — `agents:get-soul` and `agents:save-soul` Allow Path Traversal via `agentName`

**File: `src/main/ipc-handlers.ts:539–558`**

**Impact:**

```typescript
const soulPath = path.join(RESOURCES_PATH, 'agents', `${agentName.toLowerCase()}-soul.md`);
```

`agentName` comes directly from the renderer. If `agentName = '../../main/auth-service'`, the resolved path would be `RESOURCES_PATH/agents/../../main/auth-service-soul.md` = `RESOURCES_PATH/../main/auth-service-soul.md`. This could allow reading or overwriting files in the `dist/main/` directory.

**Fix:** Validate `agentName` matches a strict allowlist or at minimum reject strings containing `/`, `.`, or `\`.

---

### 🟡 MEDIUM — API Keys Stored Unencrypted on Disk

**File: `src/main/ipc-handlers.ts:114–126`**

**Impact:** OpenRouter, Anthropic, and Google API keys are written in plaintext to `$userData/settings.json`. On a shared machine (lab computer, university workstation), another local user or process with filesystem access can read the keys.

**Fix:** Use the OS credential store (`keytar` on all platforms, or `electron-keytar`). At minimum, document the risk clearly.

---

### 🟡 MEDIUM — `system:log-error` Has No Rate Limiting

**File: `src/main/ipc-handlers.ts:854–866`**

**Impact:** The renderer can invoke `system:log-error` arbitrarily with large payloads. The log file appends indefinitely with no size check, rotation, or rate limiting. A bug or malicious page could fill the disk.

**Fix:** Add per-session rate limiting (e.g., max 100 calls/minute) and a maximum log file size with rotation.

---

### 🟡 MEDIUM — `auth:logout` Is a No-Op

**File: `src/main/ipc-handlers.ts:53–55`**

**Impact:**

```typescript
ipcMain.handle('auth:logout', async () => {
  return { success: true };  // Does nothing
});
```

Logout does not invalidate the JWT token, clear any session state, or revoke key assignments. A token extracted from memory or storage before logout remains valid for its full 30-day lifetime.

**Fix:** Maintain a server-side revocation list (even in-memory is sufficient for a local app), check it in `getUser()`, and add the token to it on logout.

---

### 🟡 MEDIUM — `writeKeyToWorkspace` Silently Swallows Write Failure

**File: `src/main/key-manager.ts:72–93`**

**Impact:**

```typescript
} catch (err) {
  console.error('[KeyManager] Failed to write key to workspace:', err);
  // Returns void — caller has no idea the write failed
}
```

The `setup:save-keys` handler calls this and returns `{ success: true }` even if the `.env` file was never written. The user completes setup believing their key is configured, but the ASRP workspace processes won't find it.

**Fix:** Return a boolean or throw, and propagate the error to `setup:save-keys` so it can return `{ success: false, error: ... }`.

---

### 🟡 MEDIUM — CSP Allows `unsafe-inline` Scripts

**File: `src/renderer/index.html:8`**

**Impact:**

```html
<meta http-equiv="Content-Security-Policy" content="
  ...
  script-src 'self' 'unsafe-inline';
```

`unsafe-inline` nullifies most XSS protection provided by CSP. Inline scripts can execute freely, meaning any HTML injection (via the toast XSS or router error XSS above) becomes code execution.

**Context:** The router's `executeScripts()` function requires this because it re-executes `<script>` tags in loaded page fragments. This is a design choice that necessitates the weak CSP.

**Fix:** Either use nonce-based CSP (generate a nonce per load and inject it into scripts) or replace dynamic `<script>` re-execution with a module-based approach.

---

### 🔵 LOW — `electron-store` Installed but Never Used

**File: `package.json:24`**

**Impact:** `electron-store@^8.1.0` is a runtime dependency that is never imported by any source file. It increases install size, adds a potential vulnerability surface, and is misleading to readers.

**Fix:** Remove from `dependencies`.

---

### 🔵 LOW — `sandbox: false` in BrowserWindow

**File: `src/main/index.ts:38`**

**Impact:** Setting `sandbox: false` allows the preload script to use Node.js APIs. While the preload script only uses `contextBridge` and `ipcRenderer`, disabling sandbox increases the attack surface if a vulnerability in the preload is discovered.

**Fix:** If preload only needs `contextBridge`/`ipcRenderer`, enable `sandbox: true` — Electron supports `contextBridge` in sandboxed mode since v12.

---

### 🔵 LOW — Hardcoded JWT Secret

**File: `src/main/auth-service.ts:7`**

**Impact:**

```typescript
const JWT_SECRET = 'asrp-desktop-local-jwt-secret-2026';
```

Acceptable for a local desktop app (tokens are local-only), but the secret is trivially extractable from the compiled JS. If the database is ever exported or moved between machines, tokens signed on the original machine will still be valid.

**Fix:** Generate a random secret on first launch and store it in the OS keychain. Alternatively, accept this risk explicitly given the local-only use case and document it.

---

## Round 2: Functional Completeness

For each IPC handler: **REAL** = does real work | **STUB** = returns mock/placeholder data | **PARTIAL** = partially implemented | **DEAD** = has no UI caller

| Channel | Status | Notes |
|---|---|---|
| `auth:register` | REAL | Fully implemented |
| `auth:login` | REAL | Fully implemented |
| `auth:logout` | STUB | Returns `{ success: true }`, does nothing |
| `auth:user` | REAL | JWT decode + DB lookup |
| `auth:setup-complete` | REAL | Marks setup complete in DB |
| `keys:assign-trial` | REAL | Assigns placeholder keys — keys are placeholders |
| `keys:get` | REAL | Returns assigned key from DB |
| `keys:validate` | PARTIAL | Checks format only, not actual validity |
| `setup:save-profile` | REAL | Persists to SQLite |
| `setup:save-keys` | REAL | Writes to `.env` and `settings.json` |
| `setup:init-agents` | STUB | `return { success: true }` — Phase 7.5 |
| `setup:complete` | REAL | Sets DB flag + settings flag |
| `system:info` | REAL | |
| `system:workspace` | PARTIAL | Returns wrong path (see Round 1) |
| `system:open-path` | REAL | No path validation (see Round 1) |
| `system:select-directory` | REAL | |
| `system:health` | REAL | |
| `system:self-test` | REAL | Runs 25-test suite |
| `system:log-error` | REAL | Appends to error.log |
| `system:is-headless` | REAL | DEAD — no UI renders this |
| `agents:list` | REAL | Reads from RESOURCES_PATH (broken in prod) |
| `agents:get` | REAL | Reads from RESOURCES_PATH (broken in prod) |
| `agents:status` | STUB | Returns hardcoded idle list (contradicts openclaw bridge) |
| `agents:start` | STUB | Returns stub message, no action |
| `agents:stop` | STUB | Returns stub message, no action |
| `agents:restart` | STUB | Delegates to openclawBridge.restartAgent stub |
| `agents:get-soul` | PARTIAL | Reads file OR falls back to bridge stub |
| `agents:save-soul` | PARTIAL | Writes file (broken in prod, path traversal risk) |
| `agents:rename` | STUB | Returns `{ success: true }`, no state change |
| `agents:set-model` | STUB | Returns `{ success: true }`, no state change |
| `agents:logs` | STUB | Returns mock log strings from openclaw-bridge |
| `files:list` | REAL | No path guard (see Round 1) |
| `files:read` | REAL | No path guard (see Round 1) |
| `files:write` | REAL | No path guard (see Round 1) |
| `files:delete` | REAL | No path guard, recursive+force (see Round 1) |
| `files:open-dialog` | REAL | |
| `files:save-dialog` | REAL | |
| `papers:list` | STUB | Returns hardcoded 2 papers |
| `papers:get` | STUB | Returns `{ content: '(stub)' }` |
| `papers:create` | STUB | Generates `paper-${Date.now()}` ID, not persisted |
| `papers:update` | STUB | Echoes back arguments |
| `papers:export` | STUB | Returns stub message |
| `experiments:list` | STUB | Returns hardcoded 5 experiments |
| `experiments:get` | STUB | Returns `{ data: {} }` |
| `experiments:register` | STUB | Generates EXP-ID, not persisted |
| `experiments:update-status` | STUB | Echoes back, no state change |
| `audit:list` | STUB | Returns hardcoded 6 entries (total: 847 is fake) |
| `audit:log` | STUB | Echoes entry back, nothing persisted |
| `audit:export` | STUB | Returns stub message |
| `settings:get` | REAL | Reads from settings.json with defaults |
| `settings:set` | REAL | Writes to settings.json |
| `settings:reset` | REAL | Writes defaults to settings.json |
| `openclaw:agent-statuses` | STUB | Returns MOCK_AGENTS with realistic data |
| `openclaw:workspace-stats` | STUB | Returns hardcoded `{ experiments: 5, confirmed: 2, ... }` |
| `openclaw:token-usage` | STUB | Returns hardcoded token costs |
| `openclaw:research-progress` | STUB | Returns hardcoded `{ rh: 65, sc: 76, bc: 16 }` |
| `openclaw:gateway-status` | STUB | Always returns `{ running: false }` — DEAD (no UI) |
| `assistant:get-model` | STUB | Always returns `{ model: 'Claude Sonnet 4.6', type: 'cloud' }` |
| `assistant:chat` | STUB | Keyword-matching mock responses, no real AI call |
| `assistant:history` | REAL | Reads JSONL file |
| `assistant:save-message` | REAL | Appends to JSONL file |
| `assistant:clear-history` | REAL | Truncates JSONL file |
| `ollama:status` | REAL | Detects CLI + HTTP health |
| `ollama:detect-hardware` | REAL | Uses nvidia-smi / system_profiler |
| `ollama:pull-model` | REAL | Spawns `ollama pull` |
| `ollama:cancel-pull` | REAL | Kills process (with bug — see Round 3) |
| `ollama:list-models` | REAL | Calls Ollama HTTP API |
| `ollama:chat` | REAL | Calls Ollama HTTP API |
| `ollama:delete-model` | REAL | Calls Ollama HTTP API |
| `ollama:start` | REAL | Spawns `ollama serve` (with bug — see Round 3) |
| `ollama:stop` | REAL | Kills serve process |
| `ollama:install-instructions` | REAL | Returns platform-specific URLs |
| `updater:status` | REAL | |
| `updater:check` | REAL | |
| `updater:download` | REAL | |
| `updater:install` | REAL | |

**Critical stub confusion:** The dashboard displays `openclaw:workspace-stats` and `openclaw:token-usage` as if they are live data. Researchers using this tool may interpret the hardcoded values (e.g., "$4.75 spent today", "65% reproducibility") as real measurements. This is a significant correctness issue for a research tool.

---

## Round 3: Runtime Bug Hunt

---

### 🟠 HIGH — Self-Test Has Module-Level Mutable State: Race Condition on Concurrent Runs

**File: `src/main/self-test.ts:24–30`**

```typescript
// Module-level singleton — NOT reset-safe for concurrent calls
const results: SelfTestResult = {
  passed: 0, failed: 0, errors: [], details: [], durationMs: 0,
};
```

`runSelfTest()` resets the object at the start, but if two IPC invocations arrive before the first completes (e.g., user double-clicks "Run Self-Test"), both calls operate on the same `results` object. Pass/fail counts will be mixed and the reported result will be corrupted.

**Fix:** Declare `results` as a local variable inside `runSelfTest()`, not at module level.

---

### 🟠 HIGH — Self-Test `ollama:status (graceful)` Double-Counts Passes

**File: `src/main/self-test.ts:287–296`**

```typescript
await test('ollama:status (graceful)', async () => {
  try {
    const status = await ollamaManager.getStatus();
    // ...asserts...
  } catch {
    pass('ollama:status (graceful)');  // ← calls pass()
    return;                             // ← fn returns without throwing
  }
});
// test() then also calls pass() because fn() didn't throw
```

When Ollama is not installed and `getStatus()` throws, the catch block calls `pass()` once and returns. The outer `test()` function sees no exception and calls `pass()` again. `results.passed` is incremented twice. The self-test always reports N+1 passed tests when Ollama is absent.

**Fix:** In the catch block, throw from the test to signal a skip, or restructure to not call `pass()` in the catch and instead re-throw if needed.

---

### 🟠 HIGH — `cancelPull()` Emits Both `download-cancelled` and `download-error`

**File: `src/main/ollama-manager.ts:213–219`, `src/main/ollama-manager.ts:189–200`**

```typescript
cancelPull(): void {
  if (this.pullProcess) {
    this.pullProcess.kill('SIGTERM');
    this.pullProcess = null;
    this.isDownloading = false;
    this.emit('download-cancelled', { model: this.downloadModel });
  }
}
```

When SIGTERM kills the subprocess, the `close` event fires with a non-zero exit code. The close handler at line 196–200 checks only `code === 0`, so it always emits `download-error` on cancel:

```typescript
this.pullProcess.on('close', (code) => {
  this.isDownloading = false;
  this.pullProcess = null;
  if (code === 0) { ... resolve() }
  else {
    this.emit('download-error', ...);  // fires on cancel too
    reject(err);
  }
});
```

The renderer receives both `download-cancelled` and then `download-error`. The `ipcHandler` for `ollama:pull-model` forwards the error event and removes all listeners, but the Promise also rejects and its `.catch(() => {})` is silently swallowed.

**Fix:** Set a `this.isCancelled` flag in `cancelPull()` and check it in the `close` event handler before emitting `download-error`.

---

### 🟡 MEDIUM — `startOllama()` Uses Blind 2-Second Timeout

**File: `src/main/ollama-manager.ts:290–303`**

```typescript
startOllama(): Promise<void> {
  return new Promise((resolve, reject) => {
    this.serveProcess = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' });
    this.serveProcess.unref();
    setTimeout(() => resolve(), 2000);  // Assumes ready after 2s
  });
}
```

On a slow system or first launch, Ollama may not be ready in 2 seconds. Subsequent `listModels()` or `chat()` calls will fail with connection refused. There's also no error handler on `this.serveProcess` — if the spawn itself fails (e.g., `ollama` not in PATH), `reject` is never called and the Promise hangs until the timeout resolves it with a false success.

**Fix:** Add a process `error` event handler that calls `reject(err)`. Poll `isRunning()` in a loop with a timeout instead of using a fixed sleep.

---

### 🟡 MEDIUM — 30-Second Polling Interval Is Never Cleared

**File: `src/main/index.ts:246–251`**

```typescript
setInterval(() => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const statuses = openclawBridge.getAgentStatuses();
    mainWindow.webContents.send('agents:status-update', statuses);
  }
}, 30000);
```

The interval ID is never stored, so it can never be cleared. If the app is launched on macOS, the window is closed (triggering tray minimize), and then the dock icon is clicked to create a new window (`createWindow()` is called again from the `activate` handler), the interval continues firing and sends events to whatever `mainWindow` currently is. This is functionally okay but leaks the interval handle permanently.

**Fix:** Store the return value of `setInterval()` and clear it in `app.on('before-quit')`.

---

### 🟡 MEDIUM — Listener Accumulation in `ollama:pull-model` Handler

**File: `src/main/ipc-handlers.ts:700–725`**

```typescript
ollamaManager.on('download-progress', progressHandler);
ollamaManager.on('download-complete', completeHandler);
ollamaManager.on('download-error', errorHandler);
```

Listeners are cleaned up inside `completeHandler` and `errorHandler`. But if `senderWindow` is destroyed mid-download (user closes window), neither callback will remove the listeners (the window check prevents the send, but doesn't trigger removal). These orphaned listeners accumulate on the singleton `ollamaManager` EventEmitter across window sessions.

**Fix:** Clean up listeners in a `finally`-style block or listen once using `.once()`. Add the cleanup to the window `destroyed` event.

---

### 🟡 MEDIUM — Chat History File Grows Unboundedly

**File: `src/main/ipc-handlers.ts:632–645`**

Every chat message is appended to `assistant-chat.jsonl` with no rotation, size limit, or archiving. History is loaded (limited to last 50 entries) but never trimmed on disk. Long-running research sessions will accumulate thousands of messages.

**Fix:** On `clearHistory()`, truncate to zero. On each append, periodically check file size and trim to a maximum (e.g., 10,000 lines) by rewriting.

---

### 🟡 MEDIUM — `settings:set` Accepts Any Key Without Whitelist

**File: `src/main/ipc-handlers.ts:483–493`**

```typescript
ipcMain.handle('settings:set', async (_event, updates: Record<string, unknown>) => {
  const current = loadSettings();
  const updated = { ...current, ...updates };  // Any key accepted
  fs.writeFileSync(settingsPath, JSON.stringify(updated, null, 2));
```

The renderer can set arbitrary keys in settings.json. This includes polluting the settings file with junk, or overwriting the `userId` field that `setup:save-keys` uses, causing cross-user key reassignment.

**Fix:** Validate `updates` against an allowlist of known setting keys.

---

### 🔵 LOW — `auth:setup-complete` and `setup:complete` Both Call `markSetupComplete`

**Files: `src/main/ipc-handlers.ts:62–69`, `src/main/ipc-handlers.ts:138–157`**

Both IPC handlers independently call `authService.markSetupComplete(userId)`. The `setup:complete` handler also updates settings.json while `auth:setup-complete` does not. This duplication suggests the two handlers are not cleanly delineated and could diverge if one is modified without updating the other. The setup wizard likely calls both, making one redundant.

**Fix:** Consolidate into a single `setup:complete` call. Remove `auth:setup-complete` or clarify its distinct purpose.

---

### 🔵 LOW — macOS-Only Menu Roles Present on All Platforms

**File: `src/main/index.ts:204–211`**

```typescript
{ role: 'zoom' },       // macOS only
{ role: 'front' },      // macOS only
{ role: 'hide' },       // macOS only
{ role: 'hideOthers' }, // macOS only
```

These roles are defined in the menu template for all platforms. The macOS-specific `ASRP` top-level menu is correctly removed on non-macOS platforms (`template.shift()`), but `role: 'zoom'` and `role: 'front'` in the Window submenu remain on Windows/Linux where they are no-ops. On Linux specifically, `role: 'zoom'` will log a warning.

**Fix:** Conditionally include macOS-specific roles.

---

## Round 4: Architecture & Code Quality

---

### 🟠 HIGH — `openclaw-bridge` Mock Data Presented as Real Research Data

**File: `src/main/openclaw-bridge.ts`**

The dashboard renders token costs ("$4.75 today"), research progress percentages (RH=65%, SC=76%, BC=16%), and workspace statistics (5 experiments, 2 confirmed) sourced entirely from hardcoded constants:

```typescript
const MOCK_TOKEN_USAGE: TokenUsage = ((): TokenUsage => {
  const opus = { ... cost: 3.35, ... };
  ...
})();

const MOCK_RESEARCH_PROGRESS: ResearchProgress = {
  rh: 65, sc: 76, bc: 16,
};
```

There is **no indication** in the UI that this data is mock data. Researchers may record screenshots, cite these metrics in papers, or make decisions based on them. This is the most critical correctness issue for a research tool.

**Fix:** Add a prominent "DEMO DATA — Not connected to OpenClaw" banner to every page that renders data from the bridge, until real integration is complete.

---

### 🟡 MEDIUM — `ipc-handlers.ts` Is 875 Lines — Should Be Split

**File: `src/main/ipc-handlers.ts`**

One file registers 60+ IPC handlers across 15 functional areas. This makes it difficult to maintain, navigate, and test individual handler groups. As a point of reference, the file is larger than the combined size of `auth-service.ts` + `key-manager.ts` + `auto-updater.ts`.

**Fix:** Split into `handlers/auth.ts`, `handlers/files.ts`, `handlers/agents.ts`, `handlers/papers.ts`, etc., each exporting a `register*Handlers()` function.

---

### 🟡 MEDIUM — Duplicate Settings Load/Write Logic in 4 Places

**Files: `src/main/ipc-handlers.ts:117–121`, `:144–148`, `src/main/self-test.ts:141–154`**

The pattern of "read settings.json, parse, merge, write back" is repeated in:
1. `setup:save-keys` handler — manual read/parse/write
2. `setup:complete` handler — manual read/parse/write
3. `self-test.ts` `settings:set` test — manual read/parse/write
4. `registerSettingsHandlers` — via `loadSettings()` closure

The `loadSettings` closure is correctly encapsulated but not exported or reused in the first three cases.

**Fix:** Export `loadSettings` and a `saveSettings(updates)` function from `ipc-handlers.ts` (or a new `settings-service.ts`) and reuse everywhere.

---

### 🟡 MEDIUM — Conflicting Agent Status from Two Different Sources

**Files: `src/main/ipc-handlers.ts:253–263`, `src/main/openclaw-bridge.ts:53–138`**

The `agents:status` IPC handler returns:
```typescript
{ agents: [
  { name: 'Albert', status: 'idle' },
  { name: 'Wall-E', status: 'idle' },  // idle
  ...
]}
```

The `openclaw:agent-statuses` handler returns the same agents but with Wall-E as `'running'`. The agents page and the dashboard may use these different sources, displaying inconsistent data to the user.

**Fix:** Remove the `agents:status` handler and replace all callers with `openclaw:agent-statuses`.

---

### 🟡 MEDIUM — `electron-builder.yml` References Non-Existent Build Assets

**File: `electron-builder.yml:35–48,67–75`**

The build manifest references:
- `build/icon.ico` (Windows)
- `build/icon.icns` (macOS)
- `build/icon.png` (Linux, also tray)
- `build/installerHeader.bmp`
- `build/installer.nsh`
- `build/entitlements.mac.plist`
- `build/dmg-background.png`
- `build/runtimes/node/${os}` (embedded Node.js)

None of these files appear to exist in the repository. Running `npm run dist` will fail for all platforms. The tray icon fallback exists in code, but actual packaging is broken.

**Fix:** Create the `build/` directory with required assets, or remove platform-specific references until assets are available.

---

### 🔵 LOW — `openclaw-bridge.saveAgentSoul()` Is Dead Code

**File: `src/main/openclaw-bridge.ts:249–252`**

```typescript
export function saveAgentSoul(_agentName: string, _content: string): { success: boolean } {
  // Stub — real implementation writes to SOUL.md in agent workspace
  return { success: true };
}
```

This function is never called. The `agents:save-soul` IPC handler writes files directly without going through this function.

**Fix:** Remove or mark with a `// TODO` comment explaining why it's retained.

---

### 🔵 LOW — `resources/agents/assistant-soul.md` and `assistant-init.md` Are Orphaned

**Glob: `resources/agents/assistant-*.md`**

There are resource files for an "assistant" agent type (`assistant-soul.md`, `assistant-init.md`) but no corresponding entry in the `MOCK_AGENTS` list, no `assistant.md` definition file, and no UI reference. These are dead resources likely copied from the parent ASRP project.

**Fix:** Remove or document their intended purpose.

---

### 🔵 LOW — Hardcoded Domain-Specific Dates Will Become Stale

**File: `src/main/ipc-handlers.ts:386–394`**

The stub experiments list contains hardcoded dates (`2026-04-01`, `2026-04-02`, `2026-04-03`). In a month these will be confusingly historical. Combined with the mock data issue above, researchers may not realize these are not real experiments.

**Fix:** Generate dates dynamically relative to `new Date()`, or add a prominent MOCK label.

---

### ⚪ STYLE — `src/renderer/js/sidebar.js` Has Undefined `Toast` Reference

**Based on CHANGELOG Phase 3 note:** The sidebar uses a local `Toast` helper. The `error-handler.js` checks for `typeof Toast !== 'undefined'` before calling `Toast.show()`. The actual `Toast` implementation was not visible in reviewed files — it may be defined inline in `sidebar.js`. This should be verified to avoid silent failures if the sidebar hasn't loaded yet when the first toast fires.

---

### ⚪ STYLE — No README.md Exists

**File: (missing)**

The project has a CHANGELOG but no README. A researcher cloning this repo has no entry point documentation: no build instructions, no architecture overview, no explanation of which parts are mock vs. real.

---

### ⚪ STYLE — No ESLint, No Prettier, No EditorConfig

No `.eslintrc`, `.prettierrc`, or `.editorconfig` files exist. TypeScript `strict: true` provides type safety but nothing enforces consistent style, import order, or catches common JS anti-patterns (`var` vs `let`, unused assignments, etc.).

---

## Round 5: Repository Cleanup

---

### 🟠 HIGH — `dist/` Is in `.gitignore` but Compiled Files Exist Locally

**File: `.gitignore:7`**

`dist/` is correctly excluded from version control. The local `dist/` directory exists from a previous build run. This is fine, but worth noting that the git status "clean" means no dist files are tracked. **Verify before any forced `git add`.** The compiled files include source maps (`.js.map`) which would expose TypeScript source of security-sensitive files if accidentally committed.

---

### 🟡 MEDIUM — No `LICENSE` File

**File: `package.json:8` declares `"license": "Apache-2.0"` but no `LICENSE` file exists**

A `package.json` license field is informational but not legally binding. A `LICENSE` file in the root is the standard way to license code. GitHub also uses it for badge generation and license detection.

**Fix:** Add an `Apache-2.0` license file. Templates available at https://www.apache.org/licenses/LICENSE-2.0.txt

---

### 🟡 MEDIUM — `.github/workflows/` Is in `.gitignore`

**File: `.gitignore:48`**

```
.github/workflows/
```

CI/CD workflow files are excluded from version control. This means:
1. Automated tests, lint checks, and build verification don't run on PRs
2. New contributors cannot see how the project is built/deployed
3. The release pipeline (electron-builder + GitHub publish) is undocumented

**Fix:** Remove `.github/workflows/` from `.gitignore`. CI workflows should be under version control.

---

### 🔵 LOW — `resources/core/` Directory May Be Duplicated from Parent ASRP Repo

**Glob: `resources/core/{audit,budget,permissions,registry,validator}/README.md`**

These directories appear to be structural documentation from the parent ASRP platform rather than resources needed by the desktop app. If they're copies rather than symlinks, they'll become stale as the parent repo evolves.

**Fix:** Verify whether these are needed at runtime. If not, remove them from the desktop repo and document the dependency on the parent project instead.

---

### 🔵 LOW — Missing `.nvmrc` or Node Version Specification

No `.nvmrc`, `.node-version`, or `engines` field in `package.json`. The project uses `@types/node@^20.14.2` but doesn't enforce Node 20 at runtime. Using Node 18 or 22 may produce subtle differences.

**Fix:** Add `"engines": { "node": ">=20.0.0" }` to `package.json` and create a `.nvmrc` with the recommended version.

---

### 🔵 LOW — `electron-store` in `dependencies` (Runtime) Despite Never Being Used

**File: `package.json:24`**

`electron-store` is listed under `dependencies` (shipped to production) but is never imported anywhere in the codebase. It adds ~150KB to the packaged app and is a false signal to future maintainers that the settings system uses electron-store.

**Fix:** Remove from `package.json` and run `npm install`.

---

### ⚪ STYLE — `electron@^29.4.6` Is Significantly Outdated

**File: `package.json:33`**

Electron 29 was released in February 2024. As of April 2026, Electron's current stable is v34+. Electron 29 is past its end-of-life date per the Electron release schedule (each version is supported for ~1 major Chromium version cycle). Known CVEs may exist against Electron 29's bundled Chromium.

**Fix:** Upgrade to the current stable Electron version (v34+). Test thoroughly after upgrade as API changes may exist.

---

### ⚪ STYLE — `package-lock.json` Not in Repository

No `package-lock.json` found in the repository. For an Electron app with native dependencies (`better-sqlite3`), the exact versions of native modules matter significantly for packaging and security. Without a lockfile, `npm install` may produce different dependency trees across machines.

**Fix:** Commit `package-lock.json`. (It is not in `.gitignore`.) Run `npm install` to generate it and commit it.

---

## Summary Table

| Severity | Count | Items |
|---|---|---|
| 🔴 CRITICAL | 3 | Path traversal, IDOR auth bypass, RESOURCES_PATH wrong in prod |
| 🟠 HIGH | 8 | XSS toast, XSS router, placeholder keys in binary, duplicate navigate listener, save-soul breaks in prod, workspace path wrong, self-test race condition, mock data shown as real |
| 🟡 MEDIUM | 16 | No password validation, agent path traversal, unencrypted API keys, no logout invalidation, log-error no rate limit, writeKeyToWorkspace silent fail, conflicting agent status, settings:set no whitelist, CSP unsafe-inline, startOllama blind timeout, cancel+error double emit, history grows unbounded, duplicate settings code, build assets missing, chat history unbounded, settings userId leak |
| 🔵 LOW | 12 | sandbox:false, hardcoded JWT secret, dead electron-store dep, duplicate markSetupComplete, macOS-only menu roles, no rate limit on log-error, dead saveAgentSoul, orphaned assistant resources, stale hardcoded dates, no lockfile, outdated Electron, no nvmrc |
| ⚪ STYLE | 7 | No README, no LICENSE, no ESLint/Prettier, ipc-handlers.ts too large, .gitignore excludes workflows, sidebar Toast reference, Electron version outdated |
| **TOTAL** | **46** | |

---

## Top 10 Priority Fixes

| Priority | Issue | Severity | Estimated Fix |
|---|---|---|---|
| 1 | **Add path guards to all file IPC handlers** (files:list/read/write/delete) | 🔴 CRITICAL | 2 hours |
| 2 | **Fix IDOR: verify JWT on all userId-taking IPC channels** | 🔴 CRITICAL | 3 hours |
| 3 | **Fix RESOURCES_PATH for packaged app** (`process.resourcesPath`) | 🔴 CRITICAL | 30 minutes |
| 4 | **Add "DEMO DATA" banner to all mock-data pages** (dashboard, agents, audit, experiments) | 🟠 HIGH | 1 hour |
| 5 | **Remove duplicate `navigate` event registration** in `index.html` | 🟠 HIGH | 10 minutes |
| 6 | **Move user SOUL storage out of RESOURCES_PATH** into `userData/agents/` | 🟠 HIGH | 2 hours |
| 7 | **Fix XSS in showToast**: use `textContent` instead of `innerHTML` for message | 🟠 HIGH | 15 minutes |
| 8 | **Fix self-test module-level `results` race condition** | 🟠 HIGH | 20 minutes |
| 9 | **Fix `system:workspace` to read from settings.json** | 🟠 HIGH | 30 minutes |
| 10 | **Create `build/` directory with required icon/asset files** or remove broken references from `electron-builder.yml` | 🟡 MEDIUM | 2 hours (asset creation) |

---

## Notes for Research Use

This codebase was generated by an AI assistant in a single session. It demonstrates strong architectural thinking (context isolation, typed IPC bridge, modular handlers) but has several patterns characteristic of AI-generated Electron apps:

1. **Stubs presented as real features** — approximately 40% of IPC handlers return hardcoded or mock data. The UI renders them without differentiation. A researcher using this tool will see plausible-looking but entirely fabricated experiment results, token costs, and research progress scores.

2. **Development-only paths in production code** — the RESOURCES_PATH bug and save-soul destination are examples of code that works in the dev environment but breaks silently in production.

3. **Security-correct at the surface, leaky underneath** — `contextIsolation: true`, `nodeIntegration: false`, and the typed contextBridge are all correct choices. But the file handlers underneath have no sandboxing, effectively negating the isolation for any local attacker.

4. **Missing build assets** — the app cannot be distributed as-is because `electron-builder.yml` references ~8 files in a `build/` directory that doesn't exist in the repository.

_Generated by Claude Sonnet 4.6 — 2026-04-03_
