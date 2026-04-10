// ============================================================
// Research Workflow Orchestrator — SRW-v2
// ============================================================
// Owns the full lifecycle of a research:
//
//   Phase 0  Bootstrap       — create channel + welcome post
//   Phase 1  Intake          — Assistant Q&A with user (3 core + follow-ups)
//   Phase 2  Reconnaissance  — Theorist scans ~10 papers, writes background.md
//   Phase 3  Synthesis       — Theorist produces 3–5 opportunities
//   Phase 4  Direction Pick  — Assistant + user select direction
//   Phase 5  Plan            — Theorist plan.json + Engineer feasibility
//   Phase 6  Schedule        — Theorist schedules next 7 nights
//   Phase 7  Active Loop     — nightly execution + daily standup
//
// Triggering: every phase transition posts a Discord message to the
// research's channel with an explicit @mention of the responsible agent's
// bot user ID. This is what actually kicks the agent into action; the
// inbox JSON files are kept only as an audit trail.
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

export const WORKFLOW_VERSION = 'SRW-v2';
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

/** Which agent role owns each phase. */
export const PHASE_OWNER: Record<WorkflowPhase, SrwAgentRole | null> = {
  'phase-0-bootstrap': null,
  'phase-1-intake': 'assistant',
  'phase-2-reconnaissance': 'theorist',
  'phase-3-synthesis': 'theorist',
  'phase-4-direction': 'assistant',
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

/** Per-phase kickoff content. Short, role-specific, budget-aware. */
export interface PhaseKickoffSpec {
  role: SrwAgentRole;
  taskId: string;
  subject: string;
  body: string;
  deliverable: string | null;
}

export function buildPhaseKickoff(phase: WorkflowPhase, research: ResearchRef): PhaseKickoffSpec | null {
  const id = research.id;
  const code = research.code || id;
  const title = research.title || id;

  switch (phase) {
    case 'phase-1-intake':
      return {
        role: 'assistant',
        taskId: 'SRW-P1-INTAKE',
        subject: `[${code}] Phase 1 — Researcher Intake (start now)`,
        deliverable: `workflows/${id}/intake.json`,
        body: [
          `**Research**: ${code} — ${title}`,
          research.abstract ? `> ${research.abstract}` : '',
          '',
          'Your job: **start a friendly Q&A with the user right now, in this channel**, to understand what they actually want before Theorist wastes cycles on the wrong framing.',
          '',
          '## How to run Intake',
          '',
          '1. **Greet + ask the first of THREE core questions**. Wait for the user to answer before asking the next.',
          '   - Q1: "What outcome would make this research a win for you — a published paper, a thesis chapter, a working prototype, or personal understanding?"',
          '   - Q2: "Is there a deadline or target venue I should plan around, or is this open-ended?"',
          '   - Q3: "What\'s your background depth here — beginner, practitioner, or domain expert? And are there any constraints (tools, budget, ethical limits) I should know?"',
          '2. **Follow up 0–4 extra questions** if anything is unclear. Be surgical, don\'t interrogate.',
          '3. When you\'re confident you have enough, write the structured result to',
          `   \`workflows/${id}/intake.json\` with this shape:`,
          '   ```json',
          '   {',
          '     "outputType": "paper|thesis|prototype|personal|other",',
          '     "targetVenue": "string or null",',
          '     "deadline": "ISO date or \\"none\\"",',
          '     "backgroundDepth": "beginner|practitioner|expert",',
          '     "constraints": "free-form string",',
          '     "additionalNotes": "anything extra from follow-ups"',
          '   }',
          '   ```',
          '4. **Post a 1-line confirmation** to the channel ("Thanks! Sending this to Albert now.") and you\'re done — the scheduler will detect `intake.json` and advance to Phase 2.',
          '',
          '**Budget**: ≤ 10 AI minutes of your own time (the clock that matters is the user answering — be patient).',
          '**Timeout**: if no reply within 2h, gently nudge. If no reply within 12h, write `intake.json` with sensible defaults (outputType=personal, deadline=none, depth=practitioner) and include `"_auto": true` so we know it was auto-filled.',
        ].filter(Boolean).join('\n'),
      };

    case 'phase-2-reconnaissance':
      return {
        role: 'theorist',
        taskId: 'SRW-P2-RECON',
        subject: `[${code}] Phase 2 — Reconnaissance`,
        deliverable: `workflows/${id}/background.md`,
        body: [
          `**Research**: ${code} — ${title}`,
          `User intake is in \`workflows/${id}/intake.json\`. Read it first — it tells you their background depth and target.`,
          '',
          '## Your task (~8 AI minutes, solo)',
          '',
          `1. Search the literature. Find the **10 most relevant papers** using your own tools.`,
          `2. Write \`workflows/${id}/literature/papers.json\`:`,
          '   `[{title, authors, year, venue, url, keyClaim, keyMethod, keyResult, relevance}, ...]`',
          `3. Write \`workflows/${id}/background.md\` — **200–400 words** covering:`,
          '   - The state of the field in plain terms (calibrate to the user\'s declared depth)',
          '   - 3–5 open questions that make this research interesting NOW',
          '   - 2–3 common pitfalls / failure modes',
          '',
          '**Budget**: ≤ 8 AI minutes. Prioritize signal over completeness — you\'re giving Phase 3 a launch pad, not a PhD lit review.',
        ].join('\n'),
      };

    case 'phase-3-synthesis':
      return {
        role: 'theorist',
        taskId: 'SRW-P3-SYNTHESIS',
        subject: `[${code}] Phase 3 — Synthesis: 3–5 directions`,
        deliverable: `workflows/${id}/opportunities.md`,
        body: [
          `**Research**: ${code} — ${title}`,
          `Literature + background are in \`workflows/${id}/literature/papers.json\` and \`workflows/${id}/background.md\`.`,
          `The user's intake is in \`workflows/${id}/intake.json\` — align your directions with their outputType and constraints.`,
          '',
          '## Your task (~5 AI minutes)',
          '',
          `Produce \`workflows/${id}/opportunities.md\` with **3 to 5 concrete breakthrough directions**. For each:`,
          '',
          '- **Title** (one line)',
          '- **Why interesting** (2 sentences)',
          '- **Why now** (what makes it tractable today)',
          '- **Difficulty**: easy / medium / hard / moonshot',
          '- **Rough cost**: how many AI hours you\'d expect Phase 7 execution to burn',
          '- **Key risks** (2 bullets)',
          '',
          `Then self-critique: drop a 5-line "critic hat" section at the bottom pointing out which direction has the weakest argument. Don\'t hide weaknesses — surface them.`,
          '',
          '**Budget**: ≤ 5 AI minutes. Assistant will format this into a Discord menu for the user.',
        ].join('\n'),
      };

    case 'phase-4-direction':
      return {
        role: 'assistant',
        taskId: 'SRW-P4-DIRECTION',
        subject: `[${code}] Phase 4 — Direction pick`,
        deliverable: `workflows/${id}/direction.json`,
        body: [
          `**Research**: ${code} — ${title}`,
          `Theorist just wrote \`workflows/${id}/opportunities.md\`.`,
          '',
          '## Your task',
          '',
          `1. **Read** \`workflows/${id}/opportunities.md\` and format it into a clean, numbered Discord post. Keep it tight — title + 1-sentence why + difficulty per direction.`,
          '2. Ask the user: *"Which direction excites you most? Reply with 1/2/3/… or tell me if none of these hit."*',
          '3. Wait for their pick. Ask at most **one follow-up question** if you need to refine (e.g. "You picked #2 — want the fast/cheap variant or the ambitious variant?").',
          `4. Write \`workflows/${id}/direction.json\`:`,
          '   ```json',
          '   {',
          '     "pick": 1,',
          '     "pickTitle": "string from opportunities.md",',
          '     "variant": "string or null",',
          '     "userRationale": "what they said, paraphrased"',
          '   }',
          '   ```',
          '',
          '**Timeout**: 24h → friendly nudge. 48h → pick Theorist\'s top recommendation automatically and note `"_auto": true`.',
        ].join('\n'),
      };

    case 'phase-5-plan':
      return {
        role: 'theorist',
        taskId: 'SRW-P5-PLAN',
        subject: `[${code}] Phase 5 — Plan construction`,
        deliverable: `workflows/${id}/plan.json`,
        body: [
          `**Research**: ${code} — ${title}`,
          `User picked their direction: see \`workflows/${id}/direction.json\`.`,
          '',
          '## Your task (~10 AI minutes total)',
          '',
          `1. **Draft** (~6 min): write \`workflows/${id}/plan.json\` with a task DAG.`,
          '   Each task: `{id, title, owner, phase, description, estimateAiHours, dependsOn, deliverable, successCriteria}`.',
          '   Owners are `theorist`, `engineer`, or `assistant`.',
          '2. **Feasibility review** (~3 min): drop a message in',
          `   \`workspace/messages/theorist-to-engineer-*.json\` asking Engineer to independently`,
          `   review the plan and write \`workflows/${id}/plan-feasibility.md\`. Wait for it.`,
          `3. **Revise + human summary** (~1 min): incorporate Engineer\'s flags, then produce`,
          `   \`workflows/${id}/plan.md\` — a Discord-ready markdown summary (Assistant will post it).`,
          '',
          '**Budget guideline**: total Phase 7 execution should fit in ≤ 50 AI hours. If you blow past that, trim scope in `plan.md` and explain why.',
          '',
          '**Time convention**: 1 human day = 1 AI hour (used for Phase 7 nightly task sizing only, not for this planning phase).',
        ].join('\n'),
      };

    case 'phase-6-schedule':
      return {
        role: 'theorist',
        taskId: 'SRW-P6-SCHEDULE',
        subject: `[${code}] Phase 6 — Schedule next 7 nights`,
        deliverable: `workflows/${id}/schedule.json`,
        body: [
          `**Research**: ${code} — ${title}`,
          `Plan is locked in \`workflows/${id}/plan.json\`.`,
          '',
          '## Your task (~2 AI minutes)',
          '',
          `1. Write \`workflows/${id}/schedule.json\`:`,
          '   `{ nights: [{ date, tasks: [{ agent, taskId, kickoffMessage }] }] }`',
          '2. Respect `dependsOn` from `plan.json`.',
          '3. Compute-heavy tasks → **00:00–06:00 local** window. Light tasks (standups, formatting, intake) can run any time.',
          '4. Leave night 7 lighter — it\'s the weekly review slot.',
        ].join('\n'),
      };

    case 'phase-7-active':
      return {
        role: 'theorist',
        taskId: 'SRW-P7-ACTIVE',
        subject: `[${code}] Phase 7 — Active Loop`,
        deliverable: null,
        body: [
          `**Research**: ${code} — ${title}`,
          `Schedule is live in \`workflows/${id}/schedule.json\`.`,
          '',
          '## Ongoing responsibilities',
          '',
          '- **Each night at 00:00 local**, dispatch that night\'s tasks (inbox messages per the schedule).',
          '- For any numerical result, ask Engineer to **independently recompute** before marking done.',
          '- Each morning Assistant writes the Daily Standup automatically — proactively flag anything broken from last night.',
          '- Update status → `confirmed` / `refuted` / `completed` when stop conditions fire.',
          '',
          '## Stop conditions',
          '1. Reviewer-grade evidence confirms hypothesis → `confirmed`',
          '2. Engineer\'s independent recompute contradicts it → `refuted`',
          '3. User marks complete / stops from the Workflow tab',
        ].join('\n'),
      };

    default:
      return null;
  }
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
  const spec = buildPhaseKickoff(phase, research);
  if (!spec) {
    return { success: false, discordPosted: false, discordError: `No kickoff defined for phase ${phase}` };
  }

  const now = nowIso();

  // 1) Audit trail — inbox JSON file
  writeInboxMessage({
    from: 'system',
    to: spec.role,
    researchId: research.id,
    researchCode: research.code || '',
    researchTitle: research.title || '',
    phase,
    taskId: spec.taskId,
    subject: spec.subject,
    body: spec.body,
    deadline: null,
    deliverable: spec.deliverable,
    createdAt: now,
  });

  // 2) Discord kickoff — the actual trigger the agent sees
  if (!state.discordChannelId) {
    return { success: false, discordPosted: false, discordError: 'No Discord channel for this workflow' };
  }

  let mentionText = '';
  let botId: string | null = null;
  try {
    botId = await getAgentDiscordBotId(spec.role);
    if (botId) {
      mentionText = `<@${botId}> `;
    } else {
      // Fallback: plain text tag — not as reliable as @mention but better than nothing
      const displayName = getAgentDiscordDisplayName(spec.role);
      mentionText = `**@${displayName}** `;
    }
  } catch (err) {
    console.warn(`[research-workflow] getAgentDiscordBotId(${spec.role}) failed:`, err);
  }

  const content = [
    `${mentionText}${spec.subject}`,
    '',
    spec.body,
    '',
    `— Scheduler (task=\`${spec.taskId}\`)`,
  ].join('\n');

  try {
    // Post AS the owning role so the message appears from that bot's identity
    // when possible. The @mention still correctly pings whichever bot we're
    // addressing (which is itself — harmless but makes the agent's message
    // loop definitely see the task).
    const posted = await postMessageToChannel(state.discordChannelId, content, { asRole: spec.role });
    if (!posted.success) {
      return { success: false, discordPosted: false, discordError: posted.error, agentMentioned: botId };
    }
  } catch (err) {
    return { success: false, discordPosted: false, discordError: String(err), agentMentioned: botId };
  }

  // Stamp lastKickoffAt on state so scheduler can measure stall
  try {
    state.lastKickoffAt = now;
    writeWorkflowState(state);
  } catch { /* non-fatal */ }

  return { success: true, discordPosted: true, agentMentioned: botId };
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
  // the research exists before Akira @-pings itself with the intake task).
  if (channelId) {
    const human = [
      `# 🚀 Research started — ${research.code || research.id}`,
      '',
      `**Title**: ${research.title || research.id}`,
      '',
      research.abstract ? `> ${research.abstract}` : '',
      '',
      '**Standard Research Workflow (SRW-v2)** is now running. Here\'s the flow:',
      '',
      '1. **Phase 1 — Intake** (Assistant): a quick Q&A with you right now so we understand what you actually want',
      '2. **Phase 2 — Reconnaissance** (Theorist): scan ~10 relevant papers + a 200-word background',
      '3. **Phase 3 — Synthesis** (Theorist): 3–5 concrete research directions',
      '4. **Phase 4 — Direction Pick** (Assistant): you pick one',
      '5. **Phase 5 — Plan** (Theorist + Engineer): detailed task DAG + feasibility review',
      '6. **Phase 6 — Schedule**: next 7 nights of work',
      '7. **Phase 7 — Active Loop**: nightly execution + daily standups',
      '',
      '⏱ **Assistant will start asking you a few quick questions right now** — expect your first direction menu in ~20 minutes after that.',
    ].filter(Boolean).join('\n');

    try {
      const posted = await postMessageToChannel(channelId, human);
      if (!posted.success) {
        warnings.push(`Failed to post Discord welcome message: ${posted.error}`);
      }
    } catch (err) {
      warnings.push(`Discord welcome post threw: ${String(err)}`);
    }
  }

  // Kick off Phase 1 — Intake. Assistant (Akira) is the owner. User interaction
  // phases are NOT cold-start throttled because the user expects an immediate
  // response, but we still write the audit inbox.
  if (!options.skipInbox) {
    // For Theorist-owned phases we keep the cold-start throttle on Phase 2,
    // not on Phase 1. Phase 1 is Assistant-owned and must not be throttled.
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
