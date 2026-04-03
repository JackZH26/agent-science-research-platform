# ASRP Desktop — Second Round Code Review Report

**Date:** 2026-04-03
**Reviewer:** Claude Sonnet 4.6 (automated security + quality audit)
**Codebase:** ASRP Desktop v1.0.0 — post-round-1 fix commit (`b2fdd5c`)
**Scope:** All TypeScript, JS, HTML, CSS, and config files re-read in full

---

## Part 1: Round-1 Fix Verification

This section audits every fix claimed in commit `b2fdd5c fix: resolve all 46 code review issues`.

### CONFIRMED — Fixes that are correct and complete

| Issue # | Description | Status |
|---|---|---|
| #1 | `RESOURCES_PATH` uses `process.resourcesPath` in packaged builds | ✅ CONFIRMED |
| #1 | File handlers (`files:list/read/write/delete`) have `isPathAllowed()` guards | ✅ CONFIRMED |
| #4 | `showToast` uses DOM methods instead of `innerHTML` | ✅ CONFIRMED |
| #5 | Router error display uses `textContent` instead of `innerHTML` | ✅ CONFIRMED |
| #7 | Duplicate `navigate` listener removed from `index.html` | ✅ CONFIRMED |
| #8 | `agents:save-soul` writes to `userData/agents/`, not ASAR resources | ✅ CONFIRMED |
| #9 | `system:workspace` reads path from `settings.json` via `getWorkspaceBase()` | ✅ CONFIRMED |
| #10 | Self-test `results` object is now local to `runSelfTest()`, not module-level | ✅ CONFIRMED |
| #10 | Self-test `ollama:status (graceful)` no longer double-counts passes | ✅ CONFIRMED |
| #13 | `agents:get-soul` and `agents:save-soul` validate `agentName` via `isValidAgentName()` | ✅ CONFIRMED |
| #15 | `auth:logout` invalidates token via in-memory `revokedTokens` set | ✅ CONFIRMED |
| #15 | `getUser()` checks revocation list before verifying JWT | ✅ CONFIRMED |
| #16 | `system:log-error` rate-limited to 10 calls/minute | ✅ CONFIRMED |
| #17 | `writeKeyToWorkspace` returns boolean; caller propagates failure | ✅ CONFIRMED |
| #18 | `agents:status` now delegates to `openclawBridge` (single source of truth) | ✅ CONFIRMED |
| #19 | `settings:set` filters updates against `ALLOWED_SETTING_KEYS` allowlist | ✅ CONFIRMED |
| #21 | `startOllama()` polls `isRunning()` instead of using blind 2-second sleep | ✅ CONFIRMED |
| #22 | `cancelPull()` sets `isCancelled` flag; close handler skips `download-error` on cancel | ✅ CONFIRMED |
| #23 | Chat history trimmed to `HISTORY_MAX_LINES = 1000` on each write | ✅ CONFIRMED |
| #27 | JWT secret is generated randomly on first launch and persisted in `userData/.jwt-secret` | ✅ CONFIRMED |
| #28 | `sandbox: true` in BrowserWindow | ✅ CONFIRMED |
| #30 | macOS-only menu roles guarded by `process.platform === 'darwin'` | ✅ CONFIRMED |
| #32 | `statusPollInterval` stored and cleared in `app.on('before-quit')` | ✅ CONFIRMED |
| #36 | Stub dates are now relative (e.g., `relDate(2)`) | ✅ CONFIRMED |

### INCOMPLETE — Fixes that are partial or have gaps

---

#### 🔴 CRITICAL — IDOR Fix Broken: Setup Wizard Still Passes Raw `userId` to Token-Expecting Handlers

**File: `src/renderer/pages/setup.html:319, 373, 408, 448, 517`**

The IPC handlers were correctly refactored in round 1 to accept a JWT `token` string instead of a raw `userId` number. However, the setup wizard renderer was **never updated** — it still reads `state.userId` (an integer like `1`) from `localStorage` and passes it as the first argument to every setup IPC call:

```javascript
// setup.html line 319 — passes raw integer, not token
window.asrp.setup.saveProfile(state.userId, profile).catch(function() {});

// setup.html line 373 — passes raw integer, not token
window.asrp.keys.assignTrial(state.userId).then(function(res) { ... });

// setup.html line 408 — passes raw integer, not token
window.asrp.setup.saveKeys(state.userId, state.keysData).catch(function() {});

// setup.html line 448 — passes raw integer, not token
window.asrp.setup.initAgents(state.userId).catch(function() {});

// setup.html line 517 — passes raw integer, not token
window.asrp.setup.complete(state.userId).then(function() { ... });
```

The IPC handlers now call `getAuthenticatedUserId(token)` → `authService.getUser(token)` → `jwt.verify(token, ...)`. When `token` is the integer `1`, `jwt.verify()` throws immediately. Every setup wizard call returns `{ success: false, error: 'Unauthorized: invalid or expired token' }`.

**Impact:** The entire setup wizard is silently broken. A new user can advance through all 4 steps without any visible error (the calls use `.catch(() => {})` or are fire-and-forget), but nothing is actually saved:
- User profile is NOT stored in the DB
- API key is NOT written to the workspace `.env`
- Trial key is NOT assigned
- Setup is NOT marked complete in the DB
- The user ends up in a broken state where they appear to complete setup but have no profile, no key, and `setupComplete` remains false in the DB

The `state.token` variable **exists** in the setup wizard (line 289: `if (token) state.token = token;`) but is never passed to any of these calls.

**Fix:** Replace every `state.userId` argument with `state.token` in `setup.html` for all 5 listed lines.

---

#### 🔴 CRITICAL — IDOR Regression: `login.html` Passes Raw `userId` to `keys:assign-trial`

**File: `src/renderer/pages/login.html:223`**

Similarly, the registration handler in `login.html` calls:

```javascript
window.asrp.keys.assignTrial(result.user.id).catch(function() {});
```

`result.user.id` is an integer. The `keys:assign-trial` handler now expects a JWT token. The trial key assignment silently fails for every new user who registers via the login page.

The token is available on the same line as `result.token`, but is not used for this call.

**Impact:** New users never get a trial key assigned after registration.

---

#### 🔴 CRITICAL — Password Mismatch: Frontend Enforces 6 chars, Backend Enforces 8 chars

**File: `src/renderer/pages/login.html:54, 203–204`**

The round-1 fix added password validation to `auth-service.ts` with a minimum of **8 characters**:
```typescript
if (!password || password.length < 8) {
  return { success: false, error: 'Password must be at least 8 characters' };
}
```

But the registration form HTML still says:
```html
<input ... placeholder="At least 6 characters" minlength="6">
```
And the JS validation check is:
```javascript
if (password.length < 6) {
  showAlert('Password must be at least 6 characters', 'error'); return;
}
```

A user who enters a 6- or 7-character password will pass the frontend check, the form will submit, but the main process will return `{ success: false, error: 'Password must be at least 8 characters' }`. The user sees the backend error message without having been warned in advance by the frontend. The placeholder text ("At least 6 characters") actively misleads the user.

**Fix:** Align the frontend minimum to 8 characters, update the placeholder, and update the `minlength` attribute.

---

### BROKEN — Fixes that introduced new bugs

---

#### 🔴 CRITICAL — `setup:save-keys` Still Uses Hardcoded Internal Workspace Path (Issue #9 Fix Incomplete)

**File: `src/main/ipc-handlers.ts:192`**

The `system:workspace` handler was fixed to return the user-configured path from `getWorkspaceBase()`. But `setup:save-keys` still uses a hardcoded internal path for writing the `.env` file:

```typescript
ipcMain.handle('setup:save-keys', async (_event, token: string, keys: Record<string, string>) => {
  try {
    const userId = getAuthenticatedUserId(token);
    const userDataPath = app.getPath('userData');
    const workspacePath = path.join(userDataPath, 'workspace'); // ← hardcoded internal path
    if (keys.openrouterKey) {
      const writeOk = keyManager.writeKeyToWorkspace(keys.openrouterKey, workspacePath);
```

The API key `.env` file is written to `$userData/workspace/.env` regardless of what the user configured as their workspace. The user's ASRP workspace processes (which read from `~/asrp-workspace/.env` by default) will not find the key.

**Fix:** Replace the hardcoded `path.join(userDataPath, 'workspace')` with `getWorkspaceBase()`.

---

#### 🟠 HIGH — Toast in `sidebar.js` Still Uses `innerHTML` (XSS Fix Missed)

**File: `src/renderer/js/sidebar.js:208–211`**

The round-1 fix corrected `showToast()` in `index.html` to use DOM methods instead of `innerHTML`. However, the `Toast` object defined in `sidebar.js` was not fixed:

```javascript
// sidebar.js Toast.show() — still uses innerHTML
toast.innerHTML = `
  <span>${icons[type] || icons.info}</span>
  <span>${message}</span>
`;
```

`Toast.show()` is called throughout the renderer (including in `agents.html`, `settings.html`, `dashboard.html`, `assistant-chat.js`). Any message containing HTML characters from an untrusted source (error messages, agent names, file names) injected into `Toast.show()` is an XSS vector.

The fix in `index.html` created a patched `window.showToast`, but `Toast.show()` in `sidebar.js` is the version used by most page scripts. Two separate toast implementations with different security properties creates confusion and leaves the XSS open.

**Fix:** Apply the same DOM-method construction to `Toast.show()` in `sidebar.js`.

---

#### 🟠 HIGH — `error-handler.js` `showRetryBanner` and `showEmptyState` Use `innerHTML` with Unsanitized Data

**File: `src/renderer/js/error-handler.js:98–131`**

Both global helpers inject the `message` and `title` parameters directly into `innerHTML`:

```javascript
window.showRetryBanner = function (containerId, message, retryFn) {
  el.innerHTML = [
    ...
    '  <div style="...">' + (message || 'Unable to load data.') + '</div>',  // ← unsanitized
    ...
  ].join('');
};

window.showEmptyState = function (containerId, icon, title, message, ...) {
  el.innerHTML = [
    '  <h3>' + (title || 'Nothing here yet') + '</h3>',  // ← unsanitized
    '  <p>' + (message || '') + '</p>',                  // ← unsanitized
    ...
  ].join('');
};
```

If callers pass error messages from IPC responses (which may originate from file system errors containing file paths, or network errors), these are injected unsanitized.

**Fix:** Use `textContent` assignment or HTML-escape the parameters before insertion.

---

#### 🟠 HIGH — Dashboard and Other Pages Inject Unsanitized API/IPC Data into `innerHTML`

**Files: `src/renderer/pages/dashboard.html:168–196, 214, 234, 270, 288`**

The dashboard was not updated to sanitize IPC data before `innerHTML` injection. Experiment hypotheses (`e.hypothesis`), agent names (`a.name`), agent roles (`a.role`), and audit messages (`e.message`) from IPC responses are all injected with template literals directly into `innerHTML`:

```javascript
// dashboard.html:168-174
expList.innerHTML = experiments.slice(0, 5).map(e => `
  ...
  <span class="exp-hyp">${e.hypothesis}</span>   ← unsanitized
`).join('');

// dashboard.html:189-196
agentList.innerHTML = agents.map(a => `
  ...
  <span class="name">${roleEmoji[a.role] || '🤖'} ${a.name}</span>  ← unsanitized
  <span class="role">${a.role}</span>
`).join('');

// dashboard.html:214-219
auditList.innerHTML = entries.map(e => `
  ...
  <span class="msg">${e.message}</span>   ← unsanitized
`).join('');
```

Similar patterns appear in `agents.html:221`, `experiments.html:253`, `audit.html:208`, and `papers.html:275`. While the current data is stub data, the pattern will persist as the app is developed and real user data or external data flows through.

**Fix:** HTML-escape all IPC data before interpolation, or build DOM nodes with `textContent`.

---

#### 🟠 HIGH — `files.html` Injects `result.error` and `f.name` into `innerHTML` Unsanitized

**File: `src/renderer/pages/files.html:157, 202, 266`**

Three specific locations inject file system data directly:

```javascript
// Line 157: error string from IPC into innerHTML
container.innerHTML = `<div ...>Error: ${error}</div>`;

// Line 202: f.name (actual filename from disk) into innerHTML
row.innerHTML = `...<span ...>${f.name}</span>...`;

// Line 266: result.error from IPC into innerHTML
document.getElementById('preview-content').innerHTML =
  `<div class="alert error show" style="margin:14px">${result.error}</div>`;
```

File names on disk (especially on user-provided workspaces) may contain HTML special characters. The error message from the IPC layer may contain file paths with angle brackets or HTML that appeared in file contents. Both are reflected directly into the DOM.

**Fix:** Escape `f.name`, `error`, and `result.error` before `innerHTML` insertion. The `escHtml()` helper is already defined in `files.html` but not applied to these locations.

---

#### 🟡 MEDIUM — `startOllama()` Polling Can Still Resolve After Spawn Error

**File: `src/main/ollama-manager.ts:303–350`**

The fix adds a `serveProcess.on('error', reject)` handler, which is correct. However, there is a race condition: the `poll()` function starts after a `setTimeout(poll, 200)` delay. If the `error` event fires synchronously (or within the 200ms window) before the first poll resolves the promise, `reject` is called correctly. But if the first `isRunning()` poll happens to succeed (e.g., a previously running Ollama instance is detected) before the error event fires, `resolve()` is called first and the error is silently ignored. The returned promise resolves with "success" even though the spawn failed.

Additionally, once `reject` is called via the error handler, the polling `setTimeout` callbacks are still pending and will continue to call `isRunning()` for up to 10 seconds, calling `reject()` again on each timeout expiry (since `attempts >= maxAttempts` will still be triggered).

**Fix:** Add a `resolved` flag that prevents both `resolve` and `reject` from being called more than once.

---

## Part 2: New Issues Found in Round 2

### Security

---

#### 🟠 HIGH — JWT Secret File Written Without Restrictive Permissions

**File: `src/main/auth-service.ts:32`**

The generated JWT secret is written to `userData/.jwt-secret`:

```typescript
fs.writeFileSync(secretPath, newSecret, 'utf-8');
```

No file permissions are specified, so the file is created with the process's umask (typically `0o644` — world-readable on Linux/macOS). Any local user on a shared machine with read access to the home directory can read the JWT secret, then forge tokens for any userId.

**Fix:** Use `fs.writeFileSync(secretPath, newSecret, { encoding: 'utf-8', mode: 0o600 })` to make the file readable only by the owning user.

---

#### 🟠 HIGH — Path Guard Vulnerable to Symlink Attacks

**File: `src/main/ipc-handlers.ts:39–43`**

The `isPathAllowed()` function uses `path.resolve()` to normalize the path:

```typescript
function isPathAllowed(targetPath: string): boolean {
  const base = getWorkspaceBase();
  const resolved = path.resolve(targetPath);
  return resolved === base || resolved.startsWith(base + path.sep);
}
```

`path.resolve()` resolves `..` components and absolutizes relative paths, but it does **not** follow symbolic links. If a user creates a symlink inside the workspace directory pointing outside it (e.g., `~/asrp-workspace/escape -> /etc`), `path.resolve('~/asrp-workspace/escape/passwd')` returns `~/asrp-workspace/escape/passwd`, which passes the `startsWith(base)` check. The actual read/write then follows the symlink to `/etc/passwd`.

**Fix:** After `path.resolve()`, also call `fs.realpathSync()` to resolve symlinks, and check the real path against the base. Handle the case where `realpathSync` throws (path doesn't exist yet for write) by resolving the parent directory instead.

---

#### 🟡 MEDIUM — `settings.workspace` Can Be Injected by Renderer via `settings:set` to Point Outside Allowed Base

**File: `src/main/ipc-handlers.ts:566–601`**

`settings:set` now filters updates against `ALLOWED_SETTING_KEYS`, which includes `'workspace'`. This means the renderer can set `settings.workspace` to any arbitrary path. `getWorkspaceBase()` then reads that path and uses it as the allowed file operation base. A renderer that calls:

```javascript
window.asrp.settings.set({ workspace: '/' })
```

would make `isPathAllowed('/')` return `true`, effectively disabling the path guard for the file handlers. The workspace path itself is user-controlled without any validation of whether it is a safe location.

**Fix:** Validate that the workspace path is not a critical system directory (not `/`, `/etc`, `/usr`, `C:\Windows`, etc.) before accepting it. At minimum, require it to be within the user's home directory.

---

#### 🟡 MEDIUM — `system:open-path` Has No Path Validation

**File: `src/main/ipc-handlers.ts:275–282`**

The `system:open-path` handler, which calls `shell.openPath()` on an arbitrary path string from the renderer, was not fixed in round 1 and remains without any path validation. A renderer can pass any path including sensitive locations. `shell.openPath` on macOS/Linux will open the file/directory in the default application (e.g., Finder/Files). While this is lower risk than read/write, it can be used to probe the filesystem for sensitive directories or trigger unexpected application launches.

**Fix:** Apply `isPathAllowed()` before calling `shell.openPath()`, or restrict to opening only the workspace path and its children.

---

#### 🟡 MEDIUM — `revokedTokens` Set Grows Indefinitely

**File: `src/main/auth-service.ts:43`**

```typescript
const revokedTokens = new Set<string>();
```

Every call to `logout()` adds the token (a ~200-byte JWT string) to this set. The set is never pruned. JWT tokens have a 30-day expiry, but the revocation set has no corresponding cleanup. A user who logs in and out frequently, or an attacker who calls `auth:logout` repeatedly with large tokens, can grow this set without bound, consuming memory until the process is killed.

**Fix:** Periodically (e.g., every hour) scan the set and remove tokens whose `exp` claim has passed. Alternatively, store only the JWT's `jti` (JWT ID) claim rather than the full token string.

---

### Functional Completeness

---

#### 🟠 HIGH — Demo Data Displayed Without Any "DEMO" Label (Round 1 Fix Incomplete)

**Files: `src/renderer/pages/dashboard.html`, `src/renderer/pages/experiments.html`, `src/renderer/pages/audit.html`, `src/renderer/pages/agents.html`**

Round 1 listed "Add DEMO DATA banner to all mock-data pages" as Priority #4. The commit message claims all 46 issues were fixed. However, there is **no DEMO banner anywhere** in any of these pages. The dashboard renders `$4.75` token costs, `65%` research progress, and `847 audit entries` as if they are real measurements. There is no visual indication whatsoever that this data is hardcoded stub data.

This is especially concerning because the commit says the issue is fixed but the pages are unchanged.

**Impact:** Researchers may record screenshots of the dashboard and cite the mock values in papers or reports.

**Fix:** Add a prominently visible banner (e.g., `⚠ DEMO DATA — Not connected to OpenClaw`) at the top of each affected page.

---

#### 🟡 MEDIUM — `audit:list` Hardcodes `total: 6` Despite Round-1 Fix

**File: `src/main/ipc-handlers.ts:523–535`**

The round-1 fix replaced hardcoded dates with `relTime()`. But the `total: 847` fake count from the original was not just changed to `total: 6` — it was also used in `dashboard.html` directly:

```javascript
// dashboard.html:291
<div class="health-item"><span class="icon">✅</span> Audit: 847 entries</div>
```

This hardcoded `847 entries` string is still present in `dashboard.html` (line 291), showing fake data in the system health panel despite the underlying handler now returning `total: 6`.

**Fix:** Load the actual total from `window.asrp.audit.list()` and display it dynamically, or remove the static string.

---

### Runtime Bugs

---

#### 🔵 LOW — `_chordTimer` Declared With `var` but Used as `ReturnType<typeof setTimeout>`

**File: `src/renderer/index.html:149`**

```javascript
var _chordTimer = null;
...
_chordTimer = setTimeout(function() { _chordPending = false; }, 1500);
```

On TypeScript-strict environments this is fine (it's JS, not TS), but the `clearTimeout(_chordTimer)` call on line 155 passes `null` on the first invocation. `clearTimeout(null)` is harmless (it's a no-op), but it is a minor stylistic issue. Not a runtime bug, but worth noting in the context of a clean refactor.

---

#### 🟡 MEDIUM — `files.html` PDF Preview Uses `file://` Protocol Directly Without Validation

**File: `src/renderer/pages/files.html:250`**

```javascript
iframe.src = 'file://' + filePath;
```

The `filePath` comes from a file that passed the `isPathAllowed()` check in the main process. However, once a path is accepted and rendered in the iframe's `src`, the renderer can construct paths that were never validated. The `file://` iframe `src` is set in the renderer, not via an IPC call, so the path guard in the main process is bypassed entirely for PDF preview. A maliciously crafted filename (or a filename loaded from a path that was valid) could navigate the iframe to `file:///etc/passwd` if the source was somehow manipulated.

The current CSP `connect-src 'none'` does not prevent `iframe src` navigation via `file://`. Electron's `webSecurity: true` on the BrowserWindow applies, but `file://` is explicitly allowed by the navigation handler in `index.ts`.

This is a lower severity because the path must first appear in the workspace directory listing, but it is a bypass of the intended security model.

---

#### 🟡 MEDIUM — `ollama:pull-model` IPC Handler Does Not Guard `modelName` Input

**File: `src/main/ipc-handlers.ts:821`**

```typescript
ipcMain.handle('ollama:pull-model', async (event, modelName: string = 'gemma3:27b') => {
```

`modelName` is passed directly to `spawn('ollama', ['pull', modelName], ...)`. While `spawn` does not invoke a shell so there is no shell injection, an attacker-controlled `modelName` such as `../../etc/passwd` could potentially affect filesystem operations depending on how `ollama pull` handles its argument. At minimum, the model name should be validated against a basic allowlist (e.g., only alphanumeric, `:`, `.`, `-`) before passing to the subprocess.

---

### Architecture & Code Quality

---

#### 🟡 MEDIUM — `.eslintrc.json` References Plugins Not in `package.json`

**File: `.eslintrc.json:3–5`**

```json
{
  "parser": "@typescript-eslint/parser",
  "plugins": ["@typescript-eslint"],
  "extends": ["eslint:recommended"],
```

`@typescript-eslint/parser` and `@typescript-eslint/eslint-plugin` are referenced in `.eslintrc.json` but are not listed in `package.json` `devDependencies`. The ESLint config was added but the dependencies were not. Running `npm run lint` (if it existed) or any ESLint invocation would fail with `Cannot find module '@typescript-eslint/parser'`.

**Fix:** Add `@typescript-eslint/parser`, `@typescript-eslint/eslint-plugin`, and `eslint` to `devDependencies`, or update `.eslintrc.json` to not use these missing packages.

---

#### 🔵 LOW — `setup:save-keys` and `setup:complete` Still Duplicate Settings Read/Write Logic

**File: `src/main/ipc-handlers.ts:201–213, 238–246`**

Both handlers still independently perform the "read settings.json, merge, write back" pattern instead of using the `loadSettings` / save helpers that were created in `registerSettingsHandlers`. This was identified as Issue #25 in Round 1 and was not fixed. The `loadSettings` function is a closure inside `registerSettingsHandlers` and is not exported, so it cannot be reused without refactoring.

---

#### 🔵 LOW — `openclaw-bridge.ts` Model Names Reference Non-Existent Model IDs

**File: `src/main/openclaw-bridge.ts:57, 75, 89, 100`**

The mock agent data uses model names like `'claude-opus-4-6'` and `'claude-sonnet-4-6'`. These are presented in the UI (agent cards dropdown, dashboard status). These identifiers are developer-invented and do not correspond to actual Anthropic API model IDs (which use formats like `claude-opus-4-5` or `claude-sonnet-3-5`). If these values are ever used in real API calls, they will fail. The dropdown in `agents.html` similarly hardcodes `claude-haiku-4-5` and `claude-sonnet-4-6` as values.

---

#### 🔵 LOW — `ipc-handlers.ts` Grew Larger, Not Smaller (Issue #24 Not Addressed)

**File: `src/main/ipc-handlers.ts`**

The file is now ~997 lines (grew from 875 lines). The round-1 fix added security helpers and reorganized some code but did not split the file into sub-modules. The issue was documented but not fixed.

---

### Repository Cleanup

---

#### 🔵 LOW — `LICENSE` File Still Missing

**File: (missing)**

The round-1 fix did not add a `LICENSE` file. `package.json` still declares `"license": "Apache-2.0"` but there is no `LICENSE` file at the repository root.

---

#### 🔵 LOW — `.github/workflows/` No Longer in `.gitignore` (Fixed) but Still Has No Workflows

The `.github/workflows/` entry has been removed from `.gitignore` (the current `.gitignore` does not contain it). However, no workflow files exist — there is no `.github/` directory at all. The repo has no CI. This is better than before (the entry was excluded) but still means no automated test runs on PRs.

---

#### ⚪ STYLE — README.md Claims Features Are "Real-Time" Without Noting They Are Demo

**File: `README.md:9`**

The README states:
> **Dashboard** — Real-time agent status, token usage, research progress

All of these are static mock data. The README does not mention that the dashboard data is placeholder/demo. The README was added as a fix for the missing-README issue from round 1, but it does not accurately represent the app's actual behavior.

---

#### ⚪ STYLE — `electron-store` Successfully Removed from `package.json`

Round 1 flagged `electron-store` as a dead dependency. It has been removed from `package.json`. ✅

---

#### ⚪ STYLE — `engines` Field Added to `package.json`

`"engines": { "node": ">=20.0.0" }` added correctly. ✅

---

## Part 3: Summary Table

### Round-1 Fix Verification Summary

| Category | Count |
|---|---|
| CONFIRMED correct | 24 |
| INCOMPLETE or BROKEN | 6 |

### New Issues Found in Round 2

| Severity | Count | Items |
|---|---|---|
| 🔴 CRITICAL | 3 | Setup wizard IDOR regression, login.html IDOR regression, password min mismatch |
| 🟠 HIGH | 5 | setup:save-keys wrong path, Toast.show XSS, error-handler XSS, dashboard innerHTML XSS, files.html innerHTML XSS |
| 🟡 MEDIUM | 6 | startOllama race, JWT secret permissions, symlink bypass, workspace path injection, revokedTokens memory leak, audit:list hardcoded 847 |
| 🔵 LOW | 5 | system:open-path no guard, ollama modelName no guard, eslintrc missing deps, settings duplicate logic, ipc-handlers.ts still large |
| ⚪ STYLE | 3 | README accuracy, openclaw model IDs wrong, LICENSE still missing |
| **TOTAL** | **22** | |

---

## Part 4: Top Priority Fixes

| Priority | Issue | Severity | Root Cause |
|---|---|---|---|
| 1 | **Setup wizard passes `userId` instead of `token`** — setup is entirely broken for new users | 🔴 CRITICAL | Renderer not updated when handlers were refactored |
| 2 | **`login.html` calls `assignTrial(user.id)` instead of `assignTrial(token)`** — trial keys never assigned | 🔴 CRITICAL | Same root cause as above |
| 3 | **Password minimum: frontend says 6, backend requires 8** — misleading UX, registration can fail unexpectedly | 🔴 CRITICAL | Frontend and backend not kept in sync |
| 4 | **`setup:save-keys` uses hardcoded internal workspace path** — API key written to wrong location | 🔴 CRITICAL (functional) | `getWorkspaceBase()` fix was not applied here |
| 5 | **Toast.show() in sidebar.js still uses innerHTML** — XSS in every toast from page scripts | 🟠 HIGH | Fix applied to `index.html` but not `sidebar.js` |
| 6 | **Dashboard/agents/audit/experiments inject IPC data into innerHTML** — XSS if any real data flows | 🟠 HIGH | Pages not updated alongside toast fix |
| 7 | **No DEMO banner on any mock-data page** — researchers may treat mock data as real | 🟠 HIGH | Round-1 fix not implemented despite being Priority #4 |
| 8 | **JWT secret file written world-readable (no 0o600)** — secret extractable on shared machines | 🟠 HIGH | `fs.writeFileSync` default permissions used |
| 9 | **Path guard does not resolve symlinks** — symlink inside workspace escapes sandbox | 🟠 HIGH | `path.resolve()` used instead of `fs.realpathSync()` |
| 10 | **`settings.workspace` can be set to `/` by renderer, disabling path guard** | 🟡 MEDIUM | No validation of workspace value on write |

---

## Notes for Developers

The most critical finding of this round is that the IDOR fix from round 1 was **applied to the wrong half of the stack**. The main-process handlers were correctly updated to accept tokens, but the renderer scripts that call those handlers were not updated in parallel. The result is not "partial security" — it is a **complete functional regression**: every IPC call in the setup wizard now returns an auth failure silently, making the app unusable for new users while appearing to work.

The XSS fixes from round 1 were similarly applied selectively: `showToast` in `index.html` was fixed, but `Toast.show()` in `sidebar.js` (which is what most page scripts call) was not. The result is two toast implementations with different security properties, and the insecure one is the one that gets used.

The pattern suggests the fixes were applied as targeted patches to the file that was specifically cited in the round-1 report, without a comprehensive search for all callers or related implementations.

_Generated by Claude Sonnet 4.6 — 2026-04-03_
