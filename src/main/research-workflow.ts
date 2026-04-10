// ============================================================
// Research Workflow Orchestrator — SRW-v1
// ============================================================
// Owns the lifecycle of a research from bootstrap through the
// six standard phases. Writes state/inbox files that agents
// pick up via their normal message-polling loop. Phase 1–6
// orchestration lives in workflow-scheduler.ts.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { getWorkspaceBase, atomicWriteJSON, RESOURCES_PATH } from './ipc-handlers';
import { createResearchChannel, postMessageToChannel, readBotToken, readGuildId } from './discord-api';
import { canDispatchColdStart, markDispatched, enqueue as enqueueColdStart } from './workflow-throttle';

export const WORKFLOW_VERSION = 'SRW-v1';

export type WorkflowPhase =
  | 'phase-0-bootstrap'
  | 'phase-1-reconnaissance'
  | 'phase-2-synthesis'
  | 'phase-3-intake'
  | 'phase-4-plan'
  | 'phase-5-schedule'
  | 'phase-6-active'
  | 'completed'
  | 'stopped'
  | 'legacy';

export interface WorkflowState {
  researchId: string;
  workflowVersion: string;
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

export function readWorkflowState(researchId: string): WorkflowState | null {
  const file = getWorkflowStateFile(researchId);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as WorkflowState;
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
 * Build and write the Phase 1 kickoff message to the Theorist's inbox.
 * Exposed so the scheduler can drain the cold-start throttle queue.
 * The caller is responsible for throttle accounting (markDispatched).
 */
export function writePhase1KickoffInbox(research: ResearchRef): void {
  const now = new Date().toISOString();
  const srw = loadSrwTemplate();
  const body = [
    `# Kickoff — ${research.code || research.id}: ${research.title || ''}`,
    '',
    `**Research ID**: ${research.id}`,
    `**Workflow**: ${WORKFLOW_VERSION}`,
    `**Current phase**: phase-1-reconnaissance`,
    '',
    '## Research abstract',
    '',
    research.abstract || '_(no abstract provided)_',
    '',
    research.tags && research.tags.length ? `**Tags**: ${research.tags.join(', ')}` : '',
    '',
    '## Your first task (Phase 1 — Reconnaissance)',
    '',
    '1. Search for the **10 most relevant papers** to this research topic.',
    '   Use your own tools (web, arxiv, google scholar, etc.).',
    '2. Read each carefully and extract: key claim, key method, key result, relevance.',
    `3. Write \`workflows/${research.id}/literature/papers.json\` with the 10 entries.`,
    `4. Write \`workflows/${research.id}/background.md\` — 200–400 words on the domain,`,
    '   open questions, and common pitfalls, from first principles.',
    '5. When done, move on to Phase 2 (Synthesis) and produce',
    `   \`workflows/${research.id}/opportunities.md\` with 3–5 breakthrough opportunities.`,
    '',
    '**Time budget**: ~3 AI hours. **Deadline**: flexible, but aim to finish Phase 1 + 2',
    'inside one work session so the researcher gets their first insights quickly.',
    '',
    '## The full standard workflow',
    '',
    srw,
  ].join('\n');

  writeInboxMessage({
    from: 'system',
    to: 'theorist',
    researchId: research.id,
    researchCode: research.code || '',
    researchTitle: research.title || '',
    phase: 'phase-1-reconnaissance',
    taskId: 'SRW-P1-KICKOFF',
    subject: `Kickoff: ${research.code || research.id} — ${research.title || 'Untitled'}`,
    body,
    deadline: null,
    deliverable: `workflows/${research.id}/opportunities.md`,
    createdAt: now,
  });
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
    currentPhase: 'phase-1-reconnaissance', // Bootstrap is instant; next phase is reconnaissance
    paused: false,
    manuallyCompleted: false,
    phaseHistory: [
      { phase: 'phase-0-bootstrap', startedAt: now, completedAt: now },
      { phase: 'phase-1-reconnaissance', startedAt: now, completedAt: null },
    ],
    discordChannelId: channelId,
    discordChannelName: channelName,
    discordGuildId: guildId,
    createdAt: now,
    lastUpdatedAt: now,
    migratedFromLegacy: options.migrated === true,
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

  // Write the initial kickoff message to the Theorist's inbox.
  // Gated by the cold-start throttle: if Theorist has already received
  // COLD_START_DAILY_LIMIT brand-new research kickoffs today, queue this
  // one instead. The scheduler will drain the queue on a later tick / day.
  if (!options.skipInbox) {
    if (!canDispatchColdStart('theorist', research.id)) {
      enqueueColdStart({
        researchId: research.id,
        agent: 'theorist',
        taskId: 'SRW-P1-KICKOFF',
        enqueuedAt: now,
      });
      warnings.push('Cold-start throttle hit — Phase 1 kickoff queued (will dispatch on a later scheduler tick/day)');
    } else {
      writePhase1KickoffInbox(research);
      markDispatched('theorist', research.id);
    }
  }

  // Post a human-visible kickoff message to Discord
  if (channelId) {
    const human = [
      `# 🚀 Research started — ${research.code || research.id}`,
      '',
      `**Title**: ${research.title || research.id}`,
      '',
      research.abstract ? `> ${research.abstract}` : '',
      '',
      '**Standard Research Workflow** is now running. Here\'s what happens next:',
      '',
      '1. **Phase 1 — Reconnaissance** (Theorist): Find 10 relevant papers and read them',
      '2. **Phase 2 — Synthesis** (Theorist): Identify 3–5 breakthrough opportunities',
      '3. **Phase 3 — Intake** (Assistant): Short Q&A with you to pick a direction',
      '4. **Phase 4 — Plan** (Theorist + Engineer): Detailed task plan',
      '5. **Phase 5 — Schedule**: Next 7 nights of work',
      '6. **Phase 6 — Active Loop**: Daily standups, nightly execution',
      '',
      '⏱ Expect your first batch of direction ideas in ~1.5 hours.',
    ].filter(Boolean).join('\n');

    try {
      const posted = await postMessageToChannel(channelId, human);
      if (!posted.success) {
        warnings.push(`Failed to post Discord kickoff message: ${posted.error}`);
      }
    } catch (err) {
      warnings.push(`Discord post threw: ${String(err)}`);
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
