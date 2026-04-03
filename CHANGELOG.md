# ASRP Desktop — Changelog

All notable changes to ASRP Desktop are documented here.

---

## [0.1.0] — 2026-04-03

### Summary
First production release of ASRP Desktop — the Electron-based GUI for the
Agent Science Research Platform (ASRP). Phases 0 through 9 complete (91/91 tasks).

---

### Phase 0 — Project Bootstrap
- Electron + TypeScript project scaffold (`src/main`, `src/preload`, `src/renderer`)
- `electron-builder` config, `tsconfig.json`, `package.json`
- Build pipeline: `npm run build` → `dist/`, `npm start`, `npm run dev` (hot-reload)
- CSP header, contextBridge (nodeIntegration OFF), `window.asrp` typed API surface

### Phase 1 — Authentication
- SQLite user database (`better-sqlite3`, `userData/asrp-auth.db`)
- `auth-service.ts`: register, login, logout, getUser, saveProfile, markSetupComplete
- bcryptjs password hashing (10 rounds), JWT session tokens (30-day expiry)
- Login/Register page (`pages/login.html`) with tab switching, form validation,
  auto-redirect to `/setup` (new user) or `/dashboard` (returning user)

### Phase 2 — Setup Wizard
- 4-step onboarding flow (`pages/setup.html`):
  1. Research profile (institution, research line, role)
  2. API keys (OpenRouter, Anthropic, Google)
  3. Agent initialisation (stub — OpenClaw integration Phase 7.5)
  4. Completion + launch dashboard
- Trial key assignment via `key-manager.ts`

### Phase 3 — App Shell & Navigation
- Mint Apple design system (`css/mint-apple.css`): color tokens, typography,
  buttons, cards, badges, stat-cards, tables, agent/experiment/audit rows
- App shell layout (`css/app.css`): sidebar + content area grid, fullscreen mode
  for login/setup, header bar, page-loading overlay, toast notifications
- SPA hash-router (`js/router.js`): 9 routes, page caching, script re-execution
- Sidebar component (`js/sidebar.js`): nav groups, active state, workspace path,
  collapse/expand animation (Ctrl/Cmd+B), toast helper (`Toast`)

### Phase 4 — Dashboard
- `pages/dashboard.html`: experiment stat cards (total / confirmed / refuted / papers),
  agent status cards (5 agents with dot indicators), recent experiments table,
  live audit trail, token budget bars (per model + daily total), research progress
  arcs (RH / SC / BC), system health panel, local AI status, polling every 30s

### Phase 5 — Agents Page
- `pages/agents.html`: expandable agent cards, per-agent token usage, log viewer,
  SOUL editor modal (Markdown, full-screen), inline rename, model dropdown,
  Start / Stop / Restart buttons, real-time status polling

### Phase 6 — Files Browser
- `pages/files.html`: directory tree view, file type icons, syntax highlighting
  (Python, JSON, LaTeX, Markdown), edit mode with Save/Cancel, file search,
  git status badges (modified / untracked / staged), file type filters,
  drag-to-select placeholder

### Phase 7 — Experiments Registry
- `pages/experiments.html`: experiment list with status filters (all / running /
  confirmed / refuted / registered), research-line filter, text search,
  detail panel, validation checklist (hypothesis falsifiability criteria),
  Register Experiment modal with auto-generated EXP-ID

### Phase 7.5 — OpenClaw Bridge
- `openclaw-bridge.ts`: typed interfaces for AgentStatus, WorkspaceStats,
  TokenUsage, ResearchProgress, GatewayStatus; realistic mock data for all 5 agents
- IPC channels: `openclaw:agent-statuses`, `openclaw:workspace-stats`,
  `openclaw:token-usage`, `openclaw:research-progress`, `openclaw:gateway-status`

### Phase 8 — Polish & Integration
- `pages/papers.html`: paper management stub (list + create)
- `pages/audit.html`: audit timeline, severity / type / agent chip filters,
  date range picker, stats bar, CSV export
- `pages/settings.html`: workspace, AI model, API keys, daily budget, language,
  behavior checkboxes (tray, notifications, auto-start), Local AI / Ollama section,
  updater status panel, About section
- `ollama-manager.ts`: hardware detection (RAM, GPU, VRAM), `ollama pull` with
  streaming progress events, model list, delete, start/stop server, Ollama chat
- `auto-updater.ts`: electron-updater integration stub
- Assistant chat panel (`js/assistant-chat.js`): collapsed / expanded / fullscreen
  states, quick action buttons, cloud + local model switching, chat history
  persistence, Cmd/Ctrl+J toggle

### Phase 9 — Testing, Polish & Final QA (T-086 – T-091)

#### T-086 / T-087 — Self-Test
- `src/main/self-test.ts`: 25-test suite covering auth, setup, settings, OpenClaw
  stats, files (write/read/delete), papers, experiments, audit, Ollama, system health
- IPC channel `system:self-test` → preload `window.asrp.system.selfTest()`
- Settings page: "Run Self-Test" button + results modal (pass/fail per test)

#### T-088 — VPS / Headless Compatibility
- `system:is-headless` IPC: detects headless Linux (missing `$DISPLAY`)
- Settings page: "Deployment Mode" section — Desktop vs Headless/VPS with guidance

#### T-089 — Error Boundary & Edge Cases
- `src/renderer/js/error-handler.js`: `window.onerror` + `unhandledrejection`
  → friendly error toast + `system:log-error` IPC (writes to `userData/logs/error.log`)
- `window.startLoadTimeout` / `window.clearLoadTimeout` helpers (10-second timeout)
- `window.showRetryBanner` / `window.showEmptyState` helpers used across pages
- `system:log-error` IPC handler in `ipc-handlers.ts`

#### T-090 — Performance Polish
- Router: 150ms fade-in transition on page load (CSS opacity animation)
- Router: adjacent-page preloading (background `fetch` after route render)
- Router: "Retry" button on page load error
- `mint-apple.css`: `.skeleton` shimmer animation for loading placeholders,
  `.skeleton-card` / `.skeleton-line` helpers
- `mint-apple.css`: `:focus-visible` accessibility outlines (mint accent)
- `mint-apple.css`: thin mint scrollbar (5px, accent on hover)

#### T-091 — UI Final Polish
- `mint-apple.css`: `[data-tooltip]` CSS-only tooltips, `.tooltip` class,
  `.card.clickable` hover lift + shadow, `@media print` styles
- `app.css`: sidebar collapse transition, stronger active-state left-border,
  modal overlay with backdrop blur, `.modal-box` slide-up animation,
  `.shortcut-row` + `<kbd>` styling
- `sidebar.js`: collapse/expand animation (Ctrl/Cmd+B), icon-only narrow mode,
  section labels hidden when collapsed, tooltip on nav items
- `index.html`: global keyboard shortcuts modal (Cmd/Ctrl+/) listing all shortcuts;
  G-chord navigation (G→A agents, G→E experiments, G→F files, G→P papers, G→L audit);
  Escape to dismiss modals

#### Versioning
- `package.json` bumped to `1.0.0`
- Sidebar version label updated to `v1.0.0`
- `CHANGELOG.md` created

---

## [0.1.0] — 2026-03-28 (internal)

Initial development snapshot. Phases 0-8 complete (85/91 tasks).
Zero TypeScript compile errors.

---

_ASRP Desktop is maintained by the ASRP Contributors._
_License: Apache-2.0_
