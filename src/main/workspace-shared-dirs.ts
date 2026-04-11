// ============================================================
// Workspace shared-dirs — SRW cross-agent file access
// ============================================================
//
// Problem this module solves:
//   Each OpenClaw agent runs with its own workspace dir. Historically
//   this was `{wsRoot}/agent-{nickname}/` (e.g. `agent-wall-e`), then
//   `{wsRoot}/system/agent-{nickname}/` — both keyed on the user's
//   Discord bot nickname, which varies per install. Two bugs:
//     1. When Theorist writes `workflows/{id}/intake.json` relative to
//        her CWD it lands inside her private silo, invisible to
//        Engineer, Reviewer, and the desktop app's scheduler.
//     2. Code that needs to find "the Theorist" has to know the
//        nickname — but every install picks a different one.
//
// Fix (SRW-v3.1):
//   (a) Canonicalize per-agent workspace paths to role-based names:
//       `{wsRoot}/system/agent-{role}/` where role ∈ {theorist,
//       engineer, reviewer}. Legacy name-based dirs are auto-migrated.
//   (b) Promote `workflows/`, `literature/`, `messages/` to real shared
//       directories at the workspace root, and replace each agent's
//       per-agent subdir with a symlink (Windows: junction). All three
//       agents + the desktop app now read/write the same physical tree,
//       while per-agent SOUL.md / IDENTITY.md / state/ stay isolated.
//
// Cross-platform:
//   - macOS / Linux: fs.symlinkSync(target, link, 'dir')
//   - Windows:       fs.symlinkSync(target, link, 'junction')  ← no admin/Dev Mode needed
//
// Self-heal:
//   `selfHealAgentWorkspaces()` is called on app/gateway startup. It
//   scans every `~/.openclaw-asrp-*` profile, reads its `openclaw.json`
//   to find the agent's actual workspace path, merges any pre-existing
//   real subdir content into the shared root (newest file wins), then
//   replaces the real subdir with a symlink. Safe to run repeatedly.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';

/** Subdirs that must be shared across all agents + the desktop scheduler. */
export const SHARED_SUBDIRS = ['workflows', 'literature', 'messages'] as const;

/** Ensure the shared dirs exist at the workspace root as real directories. */
export function ensureSharedRootDirs(wsRoot: string): void {
  for (const name of SHARED_SUBDIRS) {
    try {
      fs.mkdirSync(path.join(wsRoot, name), { recursive: true });
    } catch {
      /* ignore */
    }
  }
}

/**
 * Recursively merge contents of `src` into `dst`. When the same file exists
 * in both, the one with the newer mtime wins. Does NOT delete `src`; callers
 * do that separately after the merge so we never destroy data on a failure.
 */
function mergeDir(src: string, dst: string): void {
  if (!fs.existsSync(src)) return;
  try {
    fs.mkdirSync(dst, { recursive: true });
  } catch {
    /* ignore */
  }
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const sp = path.join(src, e.name);
    const dp = path.join(dst, e.name);
    try {
      if (e.isSymbolicLink()) {
        // Skip — we never want to chase the link and duplicate a tree.
        continue;
      }
      if (e.isDirectory()) {
        mergeDir(sp, dp);
      } else if (e.isFile()) {
        if (!fs.existsSync(dp)) {
          fs.copyFileSync(sp, dp);
        } else {
          const ss = fs.statSync(sp);
          const ds = fs.statSync(dp);
          if (ss.mtimeMs > ds.mtimeMs) fs.copyFileSync(sp, dp);
        }
      }
    } catch {
      /* ignore per-entry errors */
    }
  }
}

function rmrfSafe(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Convert `p` to its canonical realpath, or return `p` unchanged on failure. */
function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** Create (or repair) a symlink for one shared subdir inside one agent workspace. */
function linkOneSharedDir(wsRoot: string, agentWorkspace: string, name: string): void {
  const sharedTarget = path.join(wsRoot, name);
  const linkPath = path.join(agentWorkspace, name);

  // Shared target must exist as a real directory.
  try {
    fs.mkdirSync(sharedTarget, { recursive: true });
  } catch {
    /* ignore */
  }

  // Inspect whatever is currently at linkPath.
  let exists = false;
  let isSymlink = false;
  let isDir = false;
  try {
    const lst = fs.lstatSync(linkPath);
    exists = true;
    isSymlink = lst.isSymbolicLink();
    isDir = !isSymlink && lst.isDirectory();
  } catch {
    /* does not exist */
  }

  if (exists && isSymlink) {
    // Already a symlink — verify it points at our shared target; if so, done.
    if (safeRealpath(linkPath) === safeRealpath(sharedTarget)) return;
    try {
      fs.unlinkSync(linkPath);
    } catch {
      /* ignore */
    }
  } else if (exists && isDir) {
    // Real directory — migrate its contents into shared root, then remove.
    mergeDir(linkPath, sharedTarget);
    rmrfSafe(linkPath);
  } else if (exists) {
    // Regular file or other weirdness — back up and remove.
    try {
      fs.renameSync(linkPath, `${linkPath}.bak-${Date.now()}`);
    } catch {
      try {
        fs.unlinkSync(linkPath);
      } catch {
        /* ignore */
      }
    }
  }

  // Ensure parent exists, then create the symlink.
  try {
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  } catch {
    /* ignore */
  }
  try {
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    fs.symlinkSync(sharedTarget, linkPath, type);
  } catch (err) {
    console.warn(`[shared-dirs] symlink failed for ${linkPath}: ${String(err)}`);
  }
}

/**
 * Ensure shared dirs exist at `wsRoot` and are symlinked into `agentWorkspace`.
 * Called from `openclaw-config-generator.generateAllConfigs` during setup.
 */
export function linkSharedDirsForAgent(wsRoot: string, agentWorkspace: string): void {
  try {
    fs.mkdirSync(agentWorkspace, { recursive: true });
  } catch {
    /* ignore */
  }
  ensureSharedRootDirs(wsRoot);
  for (const name of SHARED_SUBDIRS) {
    linkOneSharedDir(wsRoot, agentWorkspace, name);
  }
}

/**
 * Heuristically derive the shared workspace root from one agent's CWD and the
 * configured `settings.workspace`. Handles both layouts we've shipped:
 *  - Legacy:  `{wsRoot}/agent-{name}/`
 *  - New:     `{wsRoot}/system/agent-{role}/`
 */
function deriveSharedRoot(agentWs: string, settingsWorkspace: string | null): string {
  if (settingsWorkspace) {
    const abs = path.resolve(settingsWorkspace);
    const a = path.resolve(agentWs);
    if (a === abs || a.startsWith(abs + path.sep)) return abs;
  }
  let root = path.dirname(agentWs);
  if (path.basename(root) === 'system') root = path.dirname(root);
  return root;
}

/** Roles that ASRP recognizes. Order matches SRW-v3 dispatch layout. */
export const CANONICAL_ROLES = ['theorist', 'engineer', 'reviewer'] as const;
export type CanonicalRole = (typeof CANONICAL_ROLES)[number];

function normalizeRole(raw: unknown): CanonicalRole | null {
  const s = String(raw ?? '').toLowerCase().trim();
  // Legacy SRW-v2 alias.
  const normalized = s === 'assistant' ? 'reviewer' : s;
  return (CANONICAL_ROLES as readonly string[]).includes(normalized)
    ? (normalized as CanonicalRole)
    : null;
}

/**
 * Build a map of profile-safe name → role by reading settings.json.
 * The profile dir is `~/.openclaw-asrp-{profileSafe}` where
 * `profileSafe = agentId.toLowerCase().replace(/[^a-z0-9]/g, '')`
 * (see openclaw-config-generator + openclaw-manager for the same rule).
 */
function buildRoleMap(): Map<string, CanonicalRole> {
  const map = new Map<string, CanonicalRole>();
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    if (!fs.existsSync(settingsPath)) return map;
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const configs = settings?.agentConfigs;
    if (!Array.isArray(configs)) return map;
    for (const c of configs) {
      if (!c || typeof c !== 'object') continue;
      const agentId = (c as Record<string, unknown>).agentId;
      const role = normalizeRole((c as Record<string, unknown>).role);
      if (typeof agentId !== 'string' || !role) continue;
      const profileSafe = agentId.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (profileSafe) map.set(profileSafe, role);
    }
  } catch {
    /* ignore */
  }
  return map;
}

/**
 * Rename a legacy per-agent workspace to the canonical role-based path.
 *   src: {wsRoot}/agent-wall-e       (or {wsRoot}/system/agent-wall-e)
 *   dst: {wsRoot}/system/agent-theorist
 *
 * If `dst` already exists, merges src into dst (newest mtime wins) and
 * removes src. If `src` doesn't exist, just creates dst. Returns true if
 * any filesystem change was made. Never throws — errors are logged.
 */
function canonicalizeAgentWorkspace(src: string, dst: string): boolean {
  if (path.resolve(src) === path.resolve(dst)) return false;
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
  } catch {
    /* ignore */
  }
  const srcExists = fs.existsSync(src);
  const dstExists = fs.existsSync(dst);
  try {
    if (!srcExists && !dstExists) {
      fs.mkdirSync(dst, { recursive: true });
      return true;
    }
    if (srcExists && !dstExists) {
      fs.renameSync(src, dst);
      return true;
    }
    if (srcExists && dstExists) {
      // Both exist — merge src → dst (newest wins) then remove src.
      mergeDir(src, dst);
      rmrfSafe(src);
      return true;
    }
    // !srcExists && dstExists — nothing to do.
    return false;
  } catch (err) {
    console.warn(`[shared-dirs] canonicalize failed ${src} → ${dst}: ${String(err)}`);
    return false;
  }
}

/** Update the `agents.defaults.workspace` field in one openclaw.json atomically. */
function updateOpenclawWorkspaceField(configPath: string, newWs: string): void {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    if (!cfg.agents) cfg.agents = {};
    if (!cfg.agents.defaults) cfg.agents.defaults = {};
    if (cfg.agents.defaults.workspace === newWs) return;
    cfg.agents.defaults.workspace = newWs;
    const tmp = configPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, configPath);
  } catch (err) {
    console.warn(`[shared-dirs] failed to update ${configPath}: ${String(err)}`);
  }
}

/**
 * SRW-v3.1: ensure existing openclaw.json files have `allowBots: 'mentions'`
 * on the discord channel. Old configs default to OpenClaw's `allowBots=off`,
 * which silently drops every bot-to-bot @mention — including the Reviewer →
 * Theorist Phase 1 kickoff that drives the entire SRW. Self-loop protection
 * remains in place at the message-handler `botUserId` layer regardless of
 * this setting. Returns true if the file was modified.
 */
function ensureAllowBotsField(configPath: string): boolean {
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    if (!cfg.channels || !cfg.channels.discord) return false;
    const cur = cfg.channels.discord.allowBots;
    // Already permissive enough to receive bot @mentions — leave alone.
    if (cur === 'mentions' || cur === true || cur === 'all') return false;
    cfg.channels.discord.allowBots = 'mentions';
    const tmp = configPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmp, configPath);
    return true;
  } catch (err) {
    console.warn(`[shared-dirs] failed to update allowBots in ${configPath}: ${String(err)}`);
    return false;
  }
}

export interface SelfHealReport {
  linked: number;
  migrated: number;
  renamed: number;
  allowBotsPatched: number;
  errors: string[];
}

/**
 * Startup self-heal. Idempotent & cheap — safe to call on every gateway
 * start. For every `~/.openclaw-asrp-*` profile:
 *   1. Read the agent's openclaw.json `workspace` field + settings.json
 *      to derive the shared root and the agent's role.
 *   2. If the workspace path is a legacy nickname-based path
 *      (`…/agent-wall-e` or `…/system/agent-wall-e`), rename it to the
 *      canonical `…/system/agent-{role}/` and update the openclaw.json.
 *   3. Promote/link shared `workflows/literature/messages` subdirs into
 *      the (now canonical) agent workspace.
 *
 * Safe to run repeatedly — all operations short-circuit when the layout
 * already matches the target.
 */
export function selfHealAgentWorkspaces(): SelfHealReport {
  const report: SelfHealReport = { linked: 0, migrated: 0, renamed: 0, allowBotsPatched: 0, errors: [] };

  // Read settings.workspace (preferred shared root) + role map.
  let settingsWorkspace: string | null = null;
  try {
    const settingsPath = path.join(app.getPath('userData'), 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (typeof settings.workspace === 'string' && settings.workspace) {
        settingsWorkspace = settings.workspace;
      }
    }
  } catch {
    /* ignore */
  }
  const roleMap = buildRoleMap();

  // Scan profile dirs.
  let homeEntries: string[] = [];
  try {
    homeEntries = fs.readdirSync(os.homedir());
  } catch {
    return report;
  }
  const profiles = homeEntries.filter(e => e.startsWith('.openclaw-asrp-'));

  for (const prof of profiles) {
    const profileSafe = prof.substring('.openclaw-asrp-'.length);
    const configPath = path.join(os.homedir(), prof, 'openclaw.json');
    if (!fs.existsSync(configPath)) continue;
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const currentWs: string | undefined = cfg?.agents?.defaults?.workspace;
      if (!currentWs) continue;

      const root = deriveSharedRoot(currentWs, settingsWorkspace);
      const role = roleMap.get(profileSafe);

      // Canonical role-based path (only if we know the role).
      let effectiveWs = currentWs;
      if (role) {
        const canonical = path.join(root, 'system', `agent-${role}`);
        if (path.resolve(canonical) !== path.resolve(currentWs)) {
          if (canonicalizeAgentWorkspace(currentWs, canonical)) {
            report.renamed++;
            console.log(`[shared-dirs] canonicalized ${currentWs} → ${canonical}`);
          }
          effectiveWs = canonical;
          updateOpenclawWorkspaceField(configPath, canonical);
        }
      }

      // Ensure the (now canonical) dir exists.
      try {
        fs.mkdirSync(effectiveWs, { recursive: true });
      } catch {
        /* ignore */
      }

      // Count real (non-symlink) subdirs before linking for reporting.
      for (const name of SHARED_SUBDIRS) {
        const p = path.join(effectiveWs, name);
        try {
          const lst = fs.lstatSync(p);
          if (!lst.isSymbolicLink() && lst.isDirectory()) report.migrated++;
        } catch {
          /* ignore */
        }
      }

      linkSharedDirsForAgent(root, effectiveWs);
      report.linked++;

      // SRW-v3.1: ensure existing configs accept bot @mentions so the
      // Reviewer→Theorist Phase 1 dispatch is not silently dropped.
      if (ensureAllowBotsField(configPath)) {
        report.allowBotsPatched++;
        console.log(`[shared-dirs] patched allowBots → 'mentions' in ${configPath}`);
      }
    } catch (err) {
      report.errors.push(`${prof}: ${String(err)}`);
    }
  }

  if (report.linked > 0 || report.migrated > 0 || report.renamed > 0 || report.allowBotsPatched > 0) {
    console.log(
      `[shared-dirs] self-heal: linked=${report.linked} renamed=${report.renamed} migrated=${report.migrated} allowBotsPatched=${report.allowBotsPatched} errors=${report.errors.length}`,
    );
  }
  return report;
}
