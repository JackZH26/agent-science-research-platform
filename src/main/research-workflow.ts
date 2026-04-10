// ============================================================
// Research Workflow Orchestrator — SRW-v3
// ============================================================
// Owns the full lifecycle of a research:
//
//   Phase 0  Bootstrap       — create channel + welcome post
//   Phase 1  Intake          — Theorist Q&A with user (3 core + follow-ups)
//   Phase 2  Reconnaissance  — Theorist scans ~10 papers, writes background.md
//   Phase 3  Synthesis       — Theorist produces 3–5 opportunities
//   Phase 4  Direction Pick  — Theorist + user select direction
//   Phase 5  Plan            — Theorist plan.json + Engineer feasibility
//   Phase 6  Schedule        — Theorist schedules next 7 nights
//   Phase 7  Active Loop     — nightly execution + daily standup
//
// SRW-v3 architectural changes vs v2:
//   • Theorist owns every user-facing phase (was split Assistant/Theorist).
//   • Reviewer (formerly "Assistant") is the dispatcher / standup / critic —
//     it posts kickoff messages but never to itself.
//   • Kickoff messages are SLIM: `<@theorist> 初始化研究 R002` + a 2-line
//     pointer. The full procedure lives in the agent's SOUL / skill files,
//     not in every Discord post, so the user's channel stays readable.
//
// Sender / Mention invariant:
//   Discord bots never receive their own @mention events. Every dispatch
//   MUST use senderRole !== mentionRole. dispatchPhaseKickoff asserts this
//   at runtime; buildPhaseDispatch picks Reviewer as sender by default and
//   Theorist as the fallback sender when the mention target is Reviewer.
//
// Phase advancement: scheduler detects deliverable files the agents
// write and calls advancePhase → dispatchPhaseKickoff(next).
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceBase, atomicWriteJSON, RESOURCES_PATH } from './ipc-handlers';
import {
  createResearchChannel,
  postMessageToChannel,
  readBotToken,
  readGuildId,
  getAgentDiscordBotId,
  getAgentDiscordDisplayName,
  SrwAgentRole,
} from './discord-api';
// Note: cold-start throttling (workflow-throttle.ts) is now owned by
// workflow-scheduler.ts. Bootstrap calls dispatchPhaseKickoff directly
// because Phase 1 (Intake) is user-facing and must not be throttled.

// SRW-v3: slim-dispatch + sender/mention split. State schema is still v2
// — no state.json migration is required; the change is confined to role
// labels (assistant→reviewer, auto-migrated on read) and dispatch text.
export const WORKFLOW_VERSION = 'SRW-v3';
export const WORKFLOW_SCHEMA_VERSION = 2;

export type WorkflowPhase =
  | 'phase-0-bootstrap'
  | 'phase-1-intake'
  | 'phase-2-reconnaissance'
  | 'phase-3-synthesis'
  | 'phase-4-direction'
  | 'phase-5-plan'
  | 'phase-6-schedule'
  | 'phase-7-active'
  | 'completed'
  | 'stopped'
  | 'legacy';

export interface WorkflowState {
  researchId: string;
  workflowVersion: string;
  /** Schema version of this state.json file (for future migrations). */
  schemaVersion: number;
  currentPhase: WorkflowPhase;
  paused: boolean;
  manuallyCompleted: boolean;
  phaseHistory: Array<{ phase: WorkflowPhase; startedAt: string; completedAt: string | null }>;
  discordChannelId: string | null;
  discordChannelName: string | null;
  /** Guild the Discord channel was created in — needed to build canonical guild channel URLs. */
  discordGuildId: string | null;
  createdAt: string;
  lastUpdatedAt: string;
  /** Set when the research was retrofitted by the migrator (not started via Start Research) */
  migratedFromLegacy?: boolean;
  /** Last time dispatchPhaseKickoff successfully posted to Discord for the current phase.
   * Used by the scheduler to detect stuck phases and self-heal. */
  lastKickoffAt?: string | null;
}

/** Minimal research fields the workflow needs. Keeps this module decoupled from experiment-handlers. */
export interface ResearchRef {
  id: string;
  code: string;
  title: string;
  abstract: string;
  tags?: string[];
  status?: string;
}

// ============================================================
// Path helpers
// ============================================================

export function getWorkflowsRoot(): string {
  return path.join(getWorkspaceBase(), 'workflows');
}

export function getWorkflowDir(researchId: string): string {
  return path.join(getWorkflowsRoot(), researchId);
}

export function getWorkflowStateFile(researchId: string): string {
  return path.join(getWorkflowDir(researchId), 'state.json');
}

export function getWorkflowInboxDir(researchId: string): string {
  return path.join(getWorkflowDir(researchId), 'inbox');
}

/** Legacy messages directory agents poll for instructions. */
export function getGlobalMessagesDir(): string {
  return path.join(getWorkspaceBase(), 'messages');
}

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function nowIso(): string {
  return new Date().toISOString();
}

// ============================================================
// State I/O
// ============================================================

export function hasWorkflow(researchId: string): boolean {
  return fs.existsSync(getWorkflowStateFile(researchId));
}

/** Map SRW-v1 phase names to SRW-v2. */
const LEGACY_PHASE_MAP: Record<string, WorkflowPhase> = {
  'phase-1-reconnaissance': 'phase-2-reconnaissance',
  'phase-2-synthesis': 'phase-3-synthesis',
  'phase-3-intake': 'phase-1-intake',
  'phase-4-plan': 'phase-5-plan',
  'phase-5-schedule': 'phase-6-schedule',
  'phase-6-active': 'phase-7-active',
};

/**
 * Migrate an SRW-v1 state blob to SRW-v2 in-place. Called by readWorkflowState
 * on load so legacy files are self-healing without a one-shot migrator.
 */
function migrateStateToV2(raw: WorkflowState & { schemaVersion?: number }): {
  state: WorkflowState;
  changed: boolean;
  reason: string | null;
} {
  if (raw.schemaVersion === WORKFLOW_SCHEMA_VERSION) {
    return { state: raw, changed: false, reason: null };
  }

  // Remap phaseHistory
  const newHistory = (raw.phaseHistory || []).map(entry => {
    const mapped = LEGACY_PHASE_MAP[entry.phase as string] || entry.phase;
    return { ...entry, phase: mapped };
  });

  // Remap currentPhase
  const oldCurrent = raw.currentPhase as string;
  const mappedCurrent = (LEGACY_PHASE_MAP[oldCurrent] || oldCurrent) as WorkflowPhase;

  // If the legacy workflow was stuck at phase-1-reconnaissance with no
  // deliverables (the common "never actually started" case), reset to
  // phase-1-intake so the scheduler will Q&A the user and re-run the pipeline.
  let finalCurrent: WorkflowPhase = mappedCurrent;
  let reason = `schema-migrate v1→v2: ${oldCurrent} → ${mappedCurrent}`;
  if (oldCurrent === 'phase-1-reconnaissance') {
    const recon = path.join(getWorkflowDir(raw.researchId), 'literature', 'papers.json');
    const bg = path.join(getWorkflowDir(raw.researchId), 'background.md');
    if (!fs.existsSync(recon) && !fs.existsSync(bg)) {
      finalCurrent = 'phase-1-intake';
      // Rewrite history: replace the old reconnaissance entry with a fresh intake
      const lastIdx = newHistory.length - 1;
      if (lastIdx >= 0) {
        newHistory[lastIdx] = { phase: 'phase-1-intake', startedAt: nowIso(), completedAt: null };
      } else {
        newHistory.push({ phase: 'phase-1-intake', startedAt: nowIso(), completedAt: null });
      }
      reason = 'schema-migrate v1→v2: reset stuck reconnaissance → phase-1-intake';
    }
  }

  const migrated: WorkflowState = {
    ...raw,
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    workflowVersion: WORKFLOW_VERSION,
    currentPhase: finalCurrent,
    phaseHistory: newHistory,
    lastKickoffAt: raw.lastKickoffAt ?? null,
    discordGuildId: raw.discordGuildId ?? null,
  };
  return { state: migrated, changed: true, reason };
}

export function readWorkflowState(researchId: string): WorkflowState | null {
  const file = getWorkflowStateFile(researchId);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as WorkflowState & { schemaVersion?: number };
    const { state, changed, reason } = migrateStateToV2(raw);
    if (changed) {
      console.log(`[research-workflow] ${researchId}: ${reason}`);
      // Persist the migration so we don't repeat work next read
      try {
        atomicWriteJSON(file, state);
      } catch (err) {
        console.warn(`[research-workflow] ${researchId}: failed to persist migration:`, err);
      }
    }
    return state;
  } catch {
    return null;
  }
}

export function writeWorkflowState(state: WorkflowState): void {
  ensureDir(getWorkflowDir(state.researchId));
  state.lastUpdatedAt = nowIso();
  atomicWriteJSON(getWorkflowStateFile(state.researchId), state);
}

/** List all workflow states in the workspace. */
export function listWorkflows(): WorkflowState[] {
  const root = getWorkflowsRoot();
  if (!fs.existsSync(root)) return [];
  const result: WorkflowState[] = [];
  for (const entry of fs.readdirSync(root)) {
    if (entry.startsWith('_')) continue; // reserved for queues/global
    const s = readWorkflowState(entry);
    if (s) result.push(s);
  }
  return result;
}

// ============================================================
// SRW template loading
// ============================================================

function resolveTemplatePath(): string | null {
  const candidates = [
    path.join(RESOURCES_PATH, 'workflow-templates', 'standard-research-workflow.md'),
    path.join(__dirname, '..', '..', 'resources', 'workflow-templates', 'standard-research-workflow.md'),
    path.join(process.resourcesPath || '', 'resources', 'workflow-templates', 'standard-research-workflow.md'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

let srwTemplateWarningLogged = false;

export function loadSrwTemplate(): string {
  const p = resolveTemplatePath();
  if (!p) {
    if (!srwTemplateWarningLogged) {
      console.warn('[research-workflow] SRW template not found at any candidate path — kickoffs will be shallow.');
      srwTemplateWarningLogged = true;
    }
    return '# Standard Research Workflow\n(Template not found — see resources/workflow-templates/)';
  }
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch (err) {
    if (!srwTemplateWarningLogged) {
      console.warn('[research-workflow] SRW template could not be read:', err);
      srwTemplateWarningLogged = true;
    }
    return '# Standard Research Workflow\n(Template could not be read)';
  }
}

// ============================================================
// Agent inbox — write a system→agent instruction file that
// agents pick up via their normal message-polling behavior.
// Mirrors both into workspace/messages/ (legacy agent path)
// and into workflows/{id}/inbox/ (per-research view).
// ============================================================

export interface InboxMessage {
  from: 'system';
  to: string;           // agent name
  researchId: string;
  researchCode: string;
  researchTitle: string;
  phase: WorkflowPhase;
  taskId: string;
  subject: string;
  body: string;
  deadline: string | null;
  deliverable: string | null;
  createdAt: string;
}

/**
 * Canonical inbox filename format used by BOTH bootstrap and scheduler.
 * Includes taskId so we never collide between e.g. a kickoff and a stall nudge
 * written in the same millisecond, and so agents can dedupe by filename.
 */
export function buildInboxFilename(msg: Pick<InboxMessage, 'to' | 'researchId' | 'taskId' | 'createdAt'>): string {
  const ts = msg.createdAt.replace(/[:.]/g, '-');
  return `system-to-${msg.to}-${msg.researchId}-${msg.taskId}-${ts}.json`;
}

/**
 * Write an inbox message to both the global messages dir (where agents poll)
 * and the per-research mirror (for UI display). Exported so the scheduler
 * can share the exact same code path.
 */
export function writeInboxMessage(msg: InboxMessage): string {
  const filename = buildInboxFilename(msg);

  // 1) Global messages dir (agents poll here today)
  const globalDir = getGlobalMessagesDir();
  ensureDir(globalDir);
  const globalPath = path.join(globalDir, filename);
  atomicWriteJSON(globalPath, msg);

  // 2) Per-research inbox mirror (for UI display by research)
  const inboxDir = getWorkflowInboxDir(msg.researchId);
  ensureDir(inboxDir);
  atomicWriteJSON(path.join(inboxDir, filename), msg);

  return globalPath;
}

/**
 * Check whether an inbox message with the given taskId already exists for this
 * research (used to avoid double-dispatching after a crash before the ledger
 * was persisted).
 */
export function inboxHasTask(researchId: string, taskId: string): boolean {
  const dir = getWorkflowInboxDir(researchId);
  if (!fs.existsSync(dir)) return false;
  try {
    const entries = fs.readdirSync(dir);
    const needle = `-${taskId}-`;
    return entries.some(e => e.includes(needle));
  } catch {
    return false;
  }
}

// ============================================================
// Phase ownership + kickoff content
// ============================================================

/**
 * Which agent role owns each phase (the "actor" — who actually does the work
 * and who gets @mentioned by the dispatcher).
 *
 * SRW-v3: Theorist owns every active phase because it is the single
 * user-facing interlocutor. Reviewer never appears here — it only dispatches.
 */
export const PHASE_OWNER: Record<WorkflowPhase, SrwAgentRole | null> = {
  'phase-0-bootstrap': null,
  'phase-1-intake': 'theorist',
  'phase-2-reconnaissance': 'theorist',
  'phase-3-synthesis': 'theorist',
  'phase-4-direction': 'theorist',
  'phase-5-plan': 'theorist',
  'phase-6-schedule': 'theorist',
  'phase-7-active': 'theorist',
  'completed': null,
  'stopped': null,
  'legacy': null,
};

/** Deliverable file (relative to workflows/{id}/) the scheduler watches to detect completion. */
export const PHASE_DELIVERABLES: Record<WorkflowPhase, string[] | null> = {
  'phase-0-bootstrap': null,
  'phase-1-intake': ['intake.json'],
  'phase-2-reconnaissance': ['literature/papers.json', 'background.md'],
  'phase-3-synthesis': ['opportunities.md'],
  'phase-4-direction': ['direction.json'],
  'phase-5-plan': ['plan.json', 'plan-feasibility.md'],
  'phase-6-schedule': ['schedule.json'],
  'phase-7-active': null,
  'completed': null,
  'stopped': null,
  'legacy': null,
};

/**
 * Slim Discord dispatch spec for a phase kickoff.
 *
 * SRW-v3 design: the Discord message the user sees is short and command-like
 * (≤ ~6 lines). The agent's full procedure for each command lives in its
 * SOUL file (see resources/agents/theorist-soul.md §"Discord 命令响应表"),
 * so we don't spam the channel with 40-line instruction walls.
 *
 * Sender / Mention split is mandatory: senderRole posts the message, and
 * mentionRole is the actor that gets @pinged. They MUST differ, otherwise
 * Discord silently drops the self-mention event and the agent never wakes.
 */
export interface PhaseDispatchSpec {
  /** Which bot token posts the message. Never equal to mentionRole. */
  senderRole: SrwAgentRole;
  /** Which role to @mention — this is the phase actor. */
  mentionRole: SrwAgentRole;
  taskId: string;
  /** Short command the agent looks up in its SOUL response table. */
  command: string;
  /** One-line human-readable subject for the inbox audit entry. */
  subject: string;
  /** Up to 3 context lines shown in Discord. No procedural bodies. */
  contextLines: string[];
  /** File the scheduler watches to detect completion. */
  deliverable: string | null;
}

/** Pick a sender role that is guaranteed not to equal the mention target. */
function pickSender(mention: SrwAgentRole): SrwAgentRole {
  // Reviewer is the dispatcher for every phase owned by Theorist/Engineer.
  // If the phase actor is Reviewer itself (currently never, but future-proof),
  // fall back to Theorist as the sender so the invariant still holds.
  return mention === 'reviewer' ? 'theorist' : 'reviewer';
}

export function buildPhaseDispatch(phase: WorkflowPhase, research: ResearchRef): PhaseDispatchSpec | null {
  const id = research.id;
  const code = research.code || id;
  const title = research.title || id;

  // SRW-v3 dispatch: every phase that touches science or the user is
  // owned by Theorist. Reviewer is the dispatcher. The agent's procedural
  // "how" lives in resources/agents/theorist-soul.md §"Discord 命令响应表",
  // keyed by the `command` field below.
  switch (phase) {
    case 'phase-1-intake':
      return {
        senderRole: pickSender('theorist'),
        mentionRole: 'theorist',
        taskId: 'SRW-P1-INTAKE',
        command: `初始化研究 ${code}`,
        subject: `[${code}] Phase 1 — Intake (Theorist hosts user Q&A)`,
        deliverable: `workflows/${id}/intake.json`,
        contextLines: [
          `**${code} — ${title}**`,
          research.abstract ? `> ${research.abstract}` : '',
          `Deliverable: \`workflows/${id}/intake.json\``,
        ].filter(Boolean),
      };

    case 'phase-2-reconnaissance':
      return {
        senderRole: pickSender('theorist'),
        mentionRole: 'theorist',
        taskId: 'SRW-P2-RECON',
        command: `文献侦察 ${code}`,
        subject: `[${code}] Phase 2 — Reconnaissance`,
        deliverable: `workflows/${id}/background.md`,
        contextLines: [
          `**${code} — ${title}**`,
          `Input: \`workflows/${id}/intake.json\``,
          `Deliverable: \`workflows/${id}/background.md\` + \`literature/papers.json\``,
        ],
      };

    case 'phase-3-synthesis':
      return {
        senderRole: pickSender('theorist'),
        mentionRole: 'theorist',
        taskId: 'SRW-P3-SYNTHESIS',
        command: `综合方向 ${code}`,
        subject: `[${code}] Phase 3 — Synthesis`,
        deliverable: `workflows/${id}/opportunities.md`,
        contextLines: [
          `**${code} — ${title}**`,
          `Input: \`background.md\` + \`literature/papers.json\` + \`intake.json\``,
          `Deliverable: \`workflows/${id}/opportunities.md\` (3–5 directions)`,
        ],
      };

    case 'phase-4-direction':
      return {
        senderRole: pickSender('theorist'),
        mentionRole: 'theorist',
        taskId: 'SRW-P4-DIRECTION',
        command: `方向选择 ${code}`,
        subject: `[${code}] Phase 4 — Direction pick`,
        deliverable: `workflows/${id}/direction.json`,
        contextLines: [
          `**${code} — ${title}**`,
          `Input: \`workflows/${id}/opportunities.md\``,
          `Deliverable: \`workflows/${id}/direction.json\``,
        ],
      };

    case 'phase-5-plan':
      return {
        senderRole: pickSender('theorist'),
        mentionRole: 'theorist',
        taskId: 'SRW-P5-PLAN',
        command: `制定计划 ${code}`,
        subject: `[${code}] Phase 5 — Plan construction`,
        deliverable: `workflows/${id}/plan.json`,
        contextLines: [
          `**${code} — ${title}**`,
          `Input: \`workflows/${id}/direction.json\``,
          `Deliverable: \`plan.json\` + \`plan-feasibility.md\` (request from Engineer)`,
        ],
      };

    case 'phase-6-schedule':
      return {
        senderRole: pickSender('theorist'),
        mentionRole: 'theorist',
        taskId: 'SRW-P6-SCHEDULE',
        command: `排期 ${code}`,
        subject: `[${code}] Phase 6 — Schedule next 7 nights`,
        deliverable: `workflows/${id}/schedule.json`,
        contextLines: [
          `**${code} — ${title}**`,
          `Input: \`workflows/${id}/plan.json\``,
          `Deliverable: \`workflows/${id}/schedule.json\``,
        ],
      };

    case 'phase-7-active':
      return {
        senderRole: pickSender('theorist'),
        mentionRole: 'theorist',
        taskId: 'SRW-P7-ACTIVE',
        command: `夜间执行 ${code}`,
        subject: `[${code}] Phase 7 — Active Loop`,
        deliverable: null,
        contextLines: [
          `**${code} — ${title}**`,
          `Schedule: \`workflows/${id}/schedule.json\``,
          `Active loop — nightly dispatch + daily standup (Reviewer).`,
        ],
      };

    default:
      return null;
  }
}

/** @deprecated Use buildPhaseDispatch. Kept as a thin shim for callers that
 *  only need the actor role + deliverable. */
export function buildPhaseKickoff(phase: WorkflowPhase, research: ResearchRef): {
  role: SrwAgentRole; taskId: string; subject: string; body: string; deliverable: string | null;
} | null {
  const spec = buildPhaseDispatch(phase, research);
  if (!spec) return null;
  return {
    role: spec.mentionRole,
    taskId: spec.taskId,
    subject: spec.subject,
    body: spec.contextLines.join('\n'),
    deliverable: spec.deliverable,
  };
}

// ============================================================
// Kickoff dispatch — writes inbox audit trail AND posts a
// Discord @mention so the agent actually starts working.
// ============================================================

export interface DispatchResult {
  success: boolean;
  discordPosted: boolean;
  discordError?: string;
  agentMentioned?: string | null;
}

/**
 * Dispatch a phase kickoff:
 *   1. Write an inbox JSON file for audit
 *   2. Post a Discord message to the research channel that @mentions
 *      the responsible agent's bot user ID
 *
 * Returns whether the Discord post succeeded. Caller should decide whether
 * to treat a failed post as fatal (bootstrap: warn) or retryable (scheduler: retry next tick).
 */
export async function dispatchPhaseKickoff(
  phase: WorkflowPhase,
  research: ResearchRef,
  state: WorkflowState,
): Promise<DispatchResult> {
  const spec = buildPhaseDispatch(phase, research);
  if (!spec) {
    return { success: false, discordPosted: false, discordError: `No kickoff defined for phase ${phase}` };
  }

  // --- Invariant (role-label layer) -----------------------------------
  // Discord bots never receive their own @mention events. Any code path
  // that posts as bot X and @mentions bot X is silently dead. The label
  // check catches the obvious case; the bot-ID check below catches the
  // subtler case where two role labels silently resolve to the same bot
  // (e.g. a 2-bot install where Reviewer isn't configured and the sender
  // token falls through to Theorist's).
  if (spec.senderRole === spec.mentionRole) {
    const msg = `[research-workflow] sender===mention invariant violated for ${phase} (role=${spec.senderRole}) — refusing to dispatch`;
    console.error(msg);
    return { success: false, discordPosted: false, discordError: msg };
  }

  const now = nowIso();

  // 1) Audit trail — inbox JSON file addressed to the *actor* (mentionRole).
  //    Include a pointer to the SOUL response table so a human browsing the
  //    inbox can see where the procedure lives.
  writeInboxMessage({
    from: 'system',
    to: spec.mentionRole,
    researchId: research.id,
    researchCode: research.code || '',
    researchTitle: research.title || '',
    phase,
    taskId: spec.taskId,
    subject: spec.subject,
    body: [
      spec.command,
      ...spec.contextLines,
      '',
      `(Procedure: see §"Discord 命令响应表" in resources/agents/${spec.mentionRole}-soul.md)`,
    ].join('\n'),
    deadline: null,
    deliverable: spec.deliverable,
    createdAt: now,
  });

  // 2) Discord kickoff — the actual trigger the agent sees
  if (!state.discordChannelId) {
    return { success: false, discordPosted: false, discordError: 'No Discord channel for this workflow' };
  }

  // --- Resolve bot IDs for BOTH sender and mention target -------------
  // We need the mention target's snowflake to build a real `<@id>` ping,
  // and we need the sender's snowflake to enforce the invariant at the
  // bot-ID layer. If either resolution fails, fail the dispatch loudly
  // rather than silently degrading to a plain-text tag that no bot will
  // ever receive as a mention event.
  let mentionBotId: string | null = null;
  let senderBotId: string | null = null;
  try {
    [mentionBotId, senderBotId] = await Promise.all([
      getAgentDiscordBotId(spec.mentionRole),
      getAgentDiscordBotId(spec.senderRole),
    ]);
  } catch (err) {
    console.warn(`[research-workflow] bot ID resolution failed for ${phase}:`, err);
  }

  if (!mentionBotId) {
    const displayName = getAgentDiscordDisplayName(spec.mentionRole);
    const msg = `Cannot dispatch ${phase}: no Discord bot ID for mention target '${spec.mentionRole}' (${displayName}). ` +
      `Check that this role is configured in Settings → Agents with a valid bot token.`;
    console.error('[research-workflow]', msg);
    return { success: false, discordPosted: false, discordError: msg };
  }
  if (!senderBotId) {
    const displayName = getAgentDiscordDisplayName(spec.senderRole);
    const msg = `Cannot dispatch ${phase}: no Discord bot ID for sender role '${spec.senderRole}' (${displayName}). ` +
      `The SRW dispatcher role is not configured — add a bot for this role in Settings → Agents.`;
    console.error('[research-workflow]', msg);
    return { success: false, discordPosted: false, discordError: msg };
  }

  // --- Invariant (bot-ID layer) ---------------------------------------
  // The original self-mention deadlock was that the sender bot === mention
  // bot. Catch it here even if the role labels differ — this happens when
  // `readAgentBotToken` falls back to the first configured token because
  // the requested role isn't set up (e.g. only 2 of 3 agents configured).
  // Strict token resolution in step 3 below also blocks this, but we
  // double-check at the ID layer so the error message is actionable.
  if (senderBotId === mentionBotId) {
    const msg = `Cannot dispatch ${phase}: sender role '${spec.senderRole}' and mention role '${spec.mentionRole}' ` +
      `resolve to the same Discord bot (id=${senderBotId}). Discord drops self-mention events, so this ` +
      `dispatch would be silently dead. Configure a distinct bot for '${spec.senderRole}'.`;
    console.error('[research-workflow]', msg);
    return { success: false, discordPosted: false, discordError: msg, agentMentioned: mentionBotId };
  }

  // Slim Discord body — just the command + up to 3 context lines. The
  // full procedure lives in the agent's SOUL file (see "Discord 命令响应表").
  const content = [
    `<@${mentionBotId}> ${spec.command}`,
    ...spec.contextLines,
    `— task \`${spec.taskId}\``,
  ].join('\n');

  try {
    // 3) Post from the dispatcher role (Reviewer by default), NEVER from
    //    the mention target. strictRole:true means `readAgentBotToken`
    //    will return null rather than fall back to some other bot if
    //    `senderRole` isn't configured — belt-and-suspenders with the
    //    bot-ID check above.
    const posted = await postMessageToChannel(
      state.discordChannelId,
      content,
      { asRole: spec.senderRole, strictRole: true },
    );
    if (!posted.success) {
      return { success: false, discordPosted: false, discordError: posted.error, agentMentioned: mentionBotId };
    }
  } catch (err) {
    return { success: false, discordPosted: false, discordError: String(err), agentMentioned: mentionBotId };
  }

  // Stamp lastKickoffAt on state so scheduler can measure stall
  try {
    state.lastKickoffAt = now;
    writeWorkflowState(state);
  } catch { /* non-fatal */ }

  return { success: true, discordPosted: true, agentMentioned: mentionBotId };
}

// ============================================================
// Bootstrap — Phase 0
// ============================================================

export interface BootstrapOptions {
  /** Skip Discord channel creation (e.g. bulk backfill) */
  skipDiscord?: boolean;
  /** Skip writing the kickoff inbox to the Theorist (e.g. bulk backfill) */
  skipInbox?: boolean;
  /** Marks this workflow as migrated from legacy data */
  migrated?: boolean;
}

export interface BootstrapResult {
  success: boolean;
  state: WorkflowState | null;
  discordChannelId: string | null;
  discordChannelName: string | null;
  discordGuildId: string | null;
  /** True if bootstrap was a no-op because a workflow already existed. */
  alreadyExisted?: boolean;
  warnings: string[];
}

/**
 * Phase 0: create workflow state, Discord channel, initial inbox message.
 * Idempotent: if a workflow state already exists, this is a no-op and
 * returns the existing state with success=true.
 */
export async function bootstrapWorkflow(
  research: ResearchRef,
  options: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const warnings: string[] = [];

  // Idempotency: existing workflow → return it
  const existing = readWorkflowState(research.id);
  if (existing) {
    return {
      success: true,
      state: existing,
      discordChannelId: existing.discordChannelId,
      discordChannelName: existing.discordChannelName,
      discordGuildId: existing.discordGuildId,
      alreadyExisted: true,
      warnings: [],
    };
  }

  ensureDir(getWorkflowDir(research.id));

  // Attempt Discord channel creation
  let channelId: string | null = null;
  let channelName: string | null = null;
  let guildId: string | null = null;
  if (!options.skipDiscord) {
    const token = readBotToken();
    if (!token) {
      warnings.push('Discord bot token not configured — skipping channel creation');
    } else {
      guildId = readGuildId();
      const ch = await createResearchChannel(research.title || research.id);
      if (ch.success) {
        channelId = ch.channelId;
        channelName = ch.channelName;
      } else {
        warnings.push(`Discord channel creation failed: ${ch.error}`);
        guildId = null;
      }
    }
  }

  const now = nowIso();
  const state: WorkflowState = {
    researchId: research.id,
    workflowVersion: WORKFLOW_VERSION,
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    currentPhase: 'phase-1-intake', // Bootstrap is instant; first real phase is Intake Q&A
    paused: false,
    manuallyCompleted: false,
    phaseHistory: [
      { phase: 'phase-0-bootstrap', startedAt: now, completedAt: now },
      { phase: 'phase-1-intake', startedAt: now, completedAt: null },
    ],
    discordChannelId: channelId,
    discordChannelName: channelName,
    discordGuildId: guildId,
    createdAt: now,
    lastUpdatedAt: now,
    migratedFromLegacy: options.migrated === true,
    lastKickoffAt: null,
  };
  writeWorkflowState(state);

  // Write a README into the workflow directory so users browsing the FS can
  // understand what they're looking at
  try {
    const readme = [
      `# Workflow: ${research.code || research.id} — ${research.title || ''}`,
      '',
      `Version: ${WORKFLOW_VERSION}`,
      `Created: ${now}`,
      '',
      'See `state.json` for current phase.',
      'See the SRW template in `resources/workflow-templates/standard-research-workflow.md`.',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(getWorkflowDir(research.id), 'README.md'), readme, 'utf-8');
  } catch { /* non-fatal */ }

  // Post a human-visible welcome message to Discord FIRST (so the user sees
  // the research exists before the first agent @mention lands). We post as
  // the Reviewer role so that the *next* message — a Reviewer-posted
  // `<@theorist> 初始化研究 …` — can still safely reach Theorist.
  if (channelId) {
    const human = [
      `# 🚀 Research started — ${research.code || research.id}`,
      '',
      `**Title**: ${research.title || research.id}`,
      '',
      research.abstract ? `> ${research.abstract}` : '',
      '',
      '**Standard Research Workflow (SRW-v3)** is now running:',
      '',
      '1. **Phase 1 — Intake** (Theorist): a quick Q&A with you to understand what you actually want',
      '2. **Phase 2 — Reconnaissance** (Theorist): scan ~10 relevant papers + 200-word background',
      '3. **Phase 3 — Synthesis** (Theorist): 3–5 concrete research directions',
      '4. **Phase 4 — Direction Pick** (Theorist + you): pick one',
      '5. **Phase 5 — Plan** (Theorist + Engineer): task DAG + feasibility review',
      '6. **Phase 6 — Schedule**: next 7 nights of work',
      '7. **Phase 7 — Active Loop**: nightly execution + daily standups (Reviewer)',
      '',
      '⏱ **Theorist will start asking you a few quick questions in a moment.**',
    ].filter(Boolean).join('\n');

    try {
      // Post the welcome as Reviewer (the dispatcher role) — strict, because
      // we want the next message (the Phase 1 `<@Theorist> 初始化研究 …`
      // kickoff) to come from a DIFFERENT bot than Theorist. If Reviewer
      // isn't configured we still post the welcome (cosmetic, non-strict)
      // and add a warning — dispatchPhaseKickoff will then fail the Phase 1
      // dispatch explicitly with an actionable error message.
      let posted = await postMessageToChannel(channelId, human, { asRole: 'reviewer', strictRole: true });
      if (!posted.success) {
        console.warn(`[research-workflow] welcome strict post as reviewer failed (${posted.error}); retrying cosmetic`);
        posted = await postMessageToChannel(channelId, human);
        warnings.push(
          'Reviewer bot is not configured — welcome message was posted by the fallback bot and ' +
          'SRW Phase 1 dispatch will fail until a Reviewer bot is added in Settings → Agents.',
        );
      }
      if (!posted.success) {
        warnings.push(`Failed to post Discord welcome message: ${posted.error}`);
      }
    } catch (err) {
      warnings.push(`Discord welcome post threw: ${String(err)}`);
    }
  }

  // Kick off Phase 1 — Intake. Theorist (SRW-v3) is the owner and is
  // @mentioned by Reviewer. User-interaction phases are NOT cold-start
  // throttled because the user expects an immediate response.
  if (!options.skipInbox) {
    try {
      const kickResult = await dispatchPhaseKickoff('phase-1-intake', research, state);
      if (!kickResult.discordPosted) {
        warnings.push(`Phase 1 Intake kickoff failed: ${kickResult.discordError || 'unknown'}`);
      }
    } catch (err) {
      warnings.push(`Phase 1 Intake kickoff threw: ${String(err)}`);
    }
  }

  return {
    success: true,
    state,
    discordChannelId: channelId,
    discordChannelName: channelName,
    discordGuildId: guildId,
    warnings,
  };
}

// ============================================================
// State transitions — exposed for IPC handlers
// ============================================================

export function pauseWorkflow(researchId: string): WorkflowState | null {
  const s = readWorkflowState(researchId);
  if (!s) return null;
  s.paused = true;
  writeWorkflowState(s);
  return s;
}

export function resumeWorkflow(researchId: string): WorkflowState | null {
  const s = readWorkflowState(researchId);
  if (!s) return null;
  s.paused = false;
  writeWorkflowState(s);
  return s;
}

export function stopWorkflow(researchId: string): WorkflowState | null {
  const s = readWorkflowState(researchId);
  if (!s) return null;
  const now = nowIso();
  // Close out the currently active phase (if any)
  const last = s.phaseHistory[s.phaseHistory.length - 1];
  if (last && !last.completedAt) last.completedAt = now;
  // Append an explicit 'stopped' marker so history has no gaps
  s.phaseHistory.push({ phase: 'stopped', startedAt: now, completedAt: now });
  s.currentPhase = 'stopped';
  s.paused = true;
  writeWorkflowState(s);
  return s;
}

export function markWorkflowComplete(researchId: string): WorkflowState | null {
  const s = readWorkflowState(researchId);
  if (!s) return null;
  const now = nowIso();
  const last = s.phaseHistory[s.phaseHistory.length - 1];
  if (last && !last.completedAt) last.completedAt = now;
  // Append an explicit 'completed' marker so history has no gaps
  s.phaseHistory.push({ phase: 'completed', startedAt: now, completedAt: now });
  s.currentPhase = 'completed';
  s.manuallyCompleted = true;
  writeWorkflowState(s);
  return s;
}
