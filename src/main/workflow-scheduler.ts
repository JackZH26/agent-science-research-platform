// ============================================================
// Workflow Scheduler — SRW-v2 Phase 1–7 orchestrator
// ============================================================
// Runs on a periodic tick (every 2 min). For every active workflow:
//
//   1. Self-heal: if the current phase has no deliverables AND no
//      Discord kickoff has been stamped recently, re-dispatch the
//      kickoff so the user is never stuck watching a silent channel.
//
//   2. Deliverable detection: if the current phase's files have
//      landed on disk, advance to the next phase and dispatch the
//      next kickoff via dispatchPhaseKickoff (which posts a Discord
//      @mention for the owning agent and writes an audit inbox).
//
//   3. Intake (Phase 1) timeout: 12h → write default intake.json.
//   4. Direction (Phase 4) timeout: 48h → auto-pick Theorist's top.
//   5. Per-phase stall detection with phase-specific thresholds.
//   6. Daily standup: first fires 24h after research creation, then
//      once per local day on/after 08:00 local.
//
// The scheduler NEVER does research itself — its only outputs are
// state.json updates, Discord kickoff messages, and audit inboxes.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJSON } from './ipc-handlers';
import {
  WorkflowPhase,
  WorkflowState,
  InboxMessage,
  PHASE_DELIVERABLES,
  listWorkflows,
  readWorkflowState,
  writeWorkflowState,
  getWorkflowDir,
  writeInboxMessage,
  dispatchPhaseKickoff,
} from './research-workflow';
import { loadResearches, ResearchRecord } from './experiment-handlers';
import {
  drain as drainColdStart,
  enqueue as enqueueColdStart,
} from './workflow-throttle';

const TICK_INTERVAL_MS = 2 * 60 * 1000;          // 2 minutes — tighter than v1's 5min
const STANDUP_HOUR = 8;                           // 08:00 local — earliest a standup may fire
const STANDUP_FIRST_DELAY_MS = 24 * 60 * 60 * 1000; // First standup: 24h after research creation

// Phase-1 Intake user-timeout: if user hasn't answered within 12h, auto-fill defaults
const INTAKE_USER_TIMEOUT_MS = 12 * 60 * 60 * 1000;
// Phase-4 Direction user-timeout: 48h → auto-pick top recommendation
const DIRECTION_USER_TIMEOUT_MS = 48 * 60 * 60 * 1000;

// Self-heal: if current phase has no deliverable AND no recent kickoff stamp,
// re-dispatch the kickoff.
const SELF_HEAL_AFTER_MS = 10 * 60 * 1000; // 10 minutes
// Cap re-dispatches so a genuinely broken agent doesn't get spammed
const MAX_SELF_HEAL_PER_PHASE = 3;

// Per-phase stall thresholds — "this phase has been sitting too long, nudge".
// Phases that depend on user input have longer thresholds.
const STALL_THRESHOLDS: Record<WorkflowPhase, number> = {
  'phase-0-bootstrap': 0, // instant
  'phase-1-intake':          2 * 60 * 60 * 1000,  // 2h user-wait
  'phase-2-reconnaissance': 30 * 60 * 1000,       // 30 min agent-work
  'phase-3-synthesis':      20 * 60 * 1000,       // 20 min agent-work
  'phase-4-direction':      24 * 60 * 60 * 1000,  // 24h user-wait
  'phase-5-plan':           30 * 60 * 1000,       // 30 min agent-work
  'phase-6-schedule':       15 * 60 * 1000,       // 15 min agent-work
  'phase-7-active':         24 * 60 * 60 * 1000,  // 24h (standup catches daily issues)
  'completed': 0,
  'stopped': 0,
  'legacy': 0,
};

let tickTimer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

// ============================================================
// Small helpers
// ============================================================

// SRW-v3: 'assistant' → 'reviewer'. See discord-api.ts SrwAgentRole.
type AgentName = 'theorist' | 'engineer' | 'reviewer';

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function dispatchInbox(msg: InboxMessage): void {
  writeInboxMessage(msg);
}

function nowIso(): string { return new Date().toISOString(); }

// ============================================================
// Scheduler ledger (per-workflow dispatch de-duplication + heal counters)
// ============================================================

interface SchedulerLedger {
  researchId: string;
  /** Phases we've already dispatched a kickoff for (at least once). */
  dispatchedPhases: WorkflowPhase[];
  /** How many self-heal re-dispatches we've done for each phase. */
  selfHealCount: Partial<Record<WorkflowPhase, number>>;
  /** ISO dates (YYYY-MM-DD) we've already sent the standup for. */
  standupDates: string[];
  /** Last time we nudged about a stall. */
  lastStallNudgeAt: string | null;
}

function getLedgerFile(researchId: string): string {
  return path.join(getWorkflowDir(researchId), 'scheduler-ledger.json');
}

function readLedger(researchId: string): SchedulerLedger {
  const file = getLedgerFile(researchId);
  const empty: SchedulerLedger = {
    researchId, dispatchedPhases: [], selfHealCount: {}, standupDates: [], lastStallNudgeAt: null,
  };
  if (!fs.existsSync(file)) return empty;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<SchedulerLedger>;
    return {
      researchId,
      dispatchedPhases: Array.isArray(raw.dispatchedPhases) ? raw.dispatchedPhases : [],
      selfHealCount: (raw.selfHealCount && typeof raw.selfHealCount === 'object') ? raw.selfHealCount as SchedulerLedger['selfHealCount'] : {},
      standupDates: Array.isArray(raw.standupDates) ? raw.standupDates : [],
      lastStallNudgeAt: raw.lastStallNudgeAt || null,
    };
  } catch {
    return empty;
  }
}

function writeLedger(l: SchedulerLedger): void {
  ensureDir(getWorkflowDir(l.researchId));
  atomicWriteJSON(getLedgerFile(l.researchId), l);
}

// ============================================================
// Phase deliverable detection
// ============================================================

function workflowFileExists(researchId: string, relPath: string): boolean {
  return fs.existsSync(path.join(getWorkflowDir(researchId), relPath));
}

/** Returns true if the current phase's "done" conditions are satisfied. */
function phaseDeliverablesReady(state: WorkflowState): boolean {
  const deliverables = PHASE_DELIVERABLES[state.currentPhase];
  if (!deliverables || deliverables.length === 0) return false;
  return deliverables.every(rel => workflowFileExists(state.researchId, rel));
}

const PHASE_ORDER: WorkflowPhase[] = [
  'phase-0-bootstrap',
  'phase-1-intake',
  'phase-2-reconnaissance',
  'phase-3-synthesis',
  'phase-4-direction',
  'phase-5-plan',
  'phase-6-schedule',
  'phase-7-active',
];

function nextPhase(p: WorkflowPhase): WorkflowPhase | null {
  const idx = PHASE_ORDER.indexOf(p);
  if (idx < 0 || idx >= PHASE_ORDER.length - 1) return null;
  return PHASE_ORDER[idx + 1];
}

function isActivePhase(p: WorkflowPhase): boolean {
  return p.startsWith('phase-') && p !== 'phase-0-bootstrap';
}

// ============================================================
// Advance a workflow by exactly one phase
// ============================================================

function advancePhase(state: WorkflowState, reason: string): WorkflowState | null {
  const next = nextPhase(state.currentPhase);
  if (!next) return null;

  const last = state.phaseHistory[state.phaseHistory.length - 1];
  const now = nowIso();
  if (last && !last.completedAt) last.completedAt = now;
  state.phaseHistory.push({ phase: next, startedAt: now, completedAt: null });
  state.currentPhase = next;
  // Reset lastKickoffAt — the new phase will stamp its own on dispatch
  state.lastKickoffAt = null;
  writeWorkflowState(state);

  console.log(`[workflow-scheduler] ${state.researchId}: advanced → ${next} (${reason})`);
  return state;
}

// ============================================================
// Phase-1 Intake user-timeout handler
// ============================================================

function handleIntakeTimeout(state: WorkflowState, record: ResearchRecord): boolean {
  if (state.currentPhase !== 'phase-1-intake') return false;
  const phaseEntry = state.phaseHistory[state.phaseHistory.length - 1];
  if (!phaseEntry || phaseEntry.phase !== 'phase-1-intake') return false;

  const startedAt = Date.parse(phaseEntry.startedAt);
  if (isNaN(startedAt)) return false;
  if (Date.now() - startedAt < INTAKE_USER_TIMEOUT_MS) return false;

  const intakePath = path.join(getWorkflowDir(record.id), 'intake.json');
  if (!fs.existsSync(intakePath)) {
    const defaults = {
      outputType: 'personal',
      targetVenue: null,
      deadline: 'none',
      backgroundDepth: 'practitioner',
      constraints: 'none',
      additionalNotes: '',
      _auto: true,
      _reason: 'Phase 1 intake timed out after 12h — defaults applied',
      _timestamp: nowIso(),
    };
    atomicWriteJSON(intakePath, defaults);
    console.log(`[workflow-scheduler] ${record.id}: intake timeout → wrote defaults`);
  }
  return true;
}

// ============================================================
// Phase-4 Direction user-timeout handler
// ============================================================

function handleDirectionTimeout(state: WorkflowState, record: ResearchRecord): boolean {
  if (state.currentPhase !== 'phase-4-direction') return false;
  const phaseEntry = state.phaseHistory[state.phaseHistory.length - 1];
  if (!phaseEntry || phaseEntry.phase !== 'phase-4-direction') return false;

  const startedAt = Date.parse(phaseEntry.startedAt);
  if (isNaN(startedAt)) return false;
  if (Date.now() - startedAt < DIRECTION_USER_TIMEOUT_MS) return false;

  const directionPath = path.join(getWorkflowDir(record.id), 'direction.json');
  if (!fs.existsSync(directionPath)) {
    // Pick Theorist's top recommendation — we can't actually parse
    // opportunities.md reliably, so defer to pick=1 (first listed).
    const defaults = {
      pick: 1,
      pickTitle: 'Top recommendation (auto-selected)',
      variant: null,
      userRationale: 'No response within 48h — auto-selected Theorist\'s top recommendation',
      _auto: true,
      _timestamp: nowIso(),
    };
    atomicWriteJSON(directionPath, defaults);
    console.log(`[workflow-scheduler] ${record.id}: direction timeout → auto-picked #1`);
  }
  return true;
}

// ============================================================
// Daily standup dispatcher
// ============================================================

function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shouldFireStandup(state: WorkflowState, ledger: SchedulerLedger): boolean {
  const now = new Date();
  // First standup fires 24h after the research was created
  const createdAt = Date.parse(state.createdAt);
  if (!isNaN(createdAt) && Date.now() - createdAt < STANDUP_FIRST_DELAY_MS) return false;
  // Must be on/after 08:00 local
  if (now.getHours() < STANDUP_HOUR) return false;
  // Only Phase 7 gets standups — earlier phases have their own kickoff cadence
  if (state.currentPhase !== 'phase-7-active') return false;
  return !ledger.standupDates.includes(todayLocal());
}

function dispatchStandup(state: WorkflowState, record: ResearchRecord, ledger: SchedulerLedger): void {
  const today = todayLocal();
  dispatchInbox({
    from: 'system',
    to: 'reviewer',
    researchId: record.id,
    researchCode: record.code || '',
    researchTitle: record.title || '',
    phase: state.currentPhase,
    taskId: `SRW-STANDUP-${today}`,
    subject: `[${record.code || record.id}] Daily Standup — ${today}`,
    deliverable: null,
    deadline: null,
    createdAt: nowIso(),
    body: [
      `# Daily Standup — ${today}`,
      '',
      `Research: **${record.title || record.id}** (${record.code || record.id})`,
      `Current phase: \`${state.currentPhase}\``,
      '',
      '## Your task',
      '',
      'Write a short, friendly standup post for this research\'s Discord channel.',
      'Structure:',
      '',
      '1. **Last night** — what we did (check `workflows/{id}/inbox/` and recent agent outputs in `workspace/messages/`)',
      '2. **Findings** — concrete results or pivots (if none, say so honestly)',
      '3. **Tonight** — what we\'re planning (look at `workflows/{id}/schedule.json`)',
      '4. **Blockers / human input needed** — anything waiting on the user',
      '',
      'Keep it under 10 lines. Use emoji sparingly. Honesty over hype.',
    ].join('\n'),
  });
  ledger.standupDates.push(today);
  if (ledger.standupDates.length > 14) ledger.standupDates = ledger.standupDates.slice(-14);
  writeLedger(ledger);
  console.log(`[workflow-scheduler] ${record.id}: dispatched standup for ${today}`);
}

// ============================================================
// Stall detection
// ============================================================

function checkStall(state: WorkflowState, record: ResearchRecord, ledger: SchedulerLedger): void {
  const phaseEntry = state.phaseHistory[state.phaseHistory.length - 1];
  if (!phaseEntry) return;
  const startedAt = Date.parse(phaseEntry.startedAt);
  if (isNaN(startedAt)) return;

  const threshold = STALL_THRESHOLDS[state.currentPhase] || 0;
  if (threshold === 0) return;
  if (Date.now() - startedAt < threshold) return;

  // One nudge per phase-threshold interval
  if (ledger.lastStallNudgeAt) {
    const lastNudge = Date.parse(ledger.lastStallNudgeAt);
    if (!isNaN(lastNudge) && Date.now() - lastNudge < threshold) return;
  }

  // Owner of the current phase. SRW-v3: every active phase is owned by
  // Theorist (including Phase 1 Intake and Phase 4 Direction, which were
  // previously assigned to Assistant/Reviewer).
  const owner: AgentName = 'theorist';

  dispatchInbox({
    from: 'system',
    to: owner,
    researchId: record.id,
    researchCode: record.code || '',
    researchTitle: record.title || '',
    phase: state.currentPhase,
    taskId: `SRW-STALL-${state.currentPhase}`,
    subject: `[${record.code || record.id}] Stall nudge — ${state.currentPhase}`,
    deliverable: null,
    deadline: null,
    createdAt: nowIso(),
    body: [
      `# Phase stall nudge`,
      '',
      `This research has been in \`${state.currentPhase}\` for longer than its stall threshold`,
      `(${Math.round(threshold / 60000)} min). The scheduler is pinging you.`,
      '',
      '## What to check',
      '1. Have you already produced the phase deliverable? If yes, confirm it was written to the expected path in `workflows/{id}/`.',
      '2. If the task is blocked on the user, post a friendly reminder in the Discord channel.',
      '3. If the task is genuinely too large, split it or escalate.',
      '',
      `If you need more time, drop a note in \`workflows/${record.id}/status-notes.md\`.`,
    ].join('\n'),
  });
  ledger.lastStallNudgeAt = nowIso();
  writeLedger(ledger);
  console.log(`[workflow-scheduler] ${record.id}: stall nudge sent (phase=${state.currentPhase})`);
}

// ============================================================
// Self-heal: if no deliverables + no recent kickoff, re-dispatch
// ============================================================

async function selfHealCurrentPhase(
  state: WorkflowState,
  record: ResearchRecord,
  ledger: SchedulerLedger,
): Promise<boolean> {
  if (!isActivePhase(state.currentPhase)) return false;
  if (PHASE_DELIVERABLES[state.currentPhase] == null) return false;
  if (phaseDeliverablesReady(state)) return false;

  // How long has this phase been sitting without a kickoff stamp?
  const phaseEntry = state.phaseHistory[state.phaseHistory.length - 1];
  if (!phaseEntry) return false;
  const phaseStarted = Date.parse(phaseEntry.startedAt);
  if (isNaN(phaseStarted)) return false;

  const lastKickoff = state.lastKickoffAt ? Date.parse(state.lastKickoffAt) : 0;
  const reference = Math.max(phaseStarted, isNaN(lastKickoff) ? 0 : lastKickoff);
  if (Date.now() - reference < SELF_HEAL_AFTER_MS) return false;

  const count = ledger.selfHealCount[state.currentPhase] || 0;
  if (count >= MAX_SELF_HEAL_PER_PHASE) {
    // Already tried N times — leave it to stall detection / user re-kick
    return false;
  }

  console.log(`[workflow-scheduler] ${record.id}: self-heal re-dispatch phase=${state.currentPhase} (attempt ${count + 1}/${MAX_SELF_HEAL_PER_PHASE})`);
  try {
    const result = await dispatchPhaseKickoff(
      state.currentPhase,
      { id: record.id, code: record.code, title: record.title, abstract: record.abstract, tags: record.tags, status: record.status },
      state,
    );
    if (result.discordPosted) {
      ledger.selfHealCount[state.currentPhase] = count + 1;
      if (!ledger.dispatchedPhases.includes(state.currentPhase)) {
        ledger.dispatchedPhases.push(state.currentPhase);
      }
      writeLedger(ledger);
      return true;
    } else {
      console.warn(`[workflow-scheduler] ${record.id}: self-heal failed — ${result.discordError || 'unknown'}`);
    }
  } catch (err) {
    console.error(`[workflow-scheduler] ${record.id}: self-heal threw:`, err);
  }
  return false;
}

// ============================================================
// Main tick
// ============================================================

async function runTick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const workflows = listWorkflows();
    if (workflows.length === 0) return;

    const records = loadResearches();
    const byId = new Map<string, ResearchRecord>();
    for (const r of records) byId.set(r.id, r);

    // --- Drain cold-start throttle queue ---
    // In SRW-v2 only Theorist-owned Phase 2 Reconnaissance is throttled
    // (user-interaction phases are never throttled). Nothing enqueues today,
    // but we keep the drain loop for forward compatibility.
    try {
      const drained = drainColdStart();
      for (const entry of drained) {
        const rec = byId.get(entry.researchId);
        if (!rec) continue;
        // No SRW-v2 bootstrap path currently enqueues — anything in the queue
        // is from a previous build. Re-queue unknown entries rather than drop.
        console.warn(`[workflow-scheduler] drained unknown cold-start entry (agent=${entry.agent}, task=${entry.taskId}) for ${entry.researchId} — re-queuing`);
        enqueueColdStart(entry);
      }
    } catch (err) {
      console.error('[workflow-scheduler] cold-start drain failed:', err);
    }

    for (const wf of workflows) {
      try {
        if (wf.paused) continue;
        if (wf.currentPhase === 'completed' || wf.currentPhase === 'stopped' || wf.currentPhase === 'legacy') continue;
        if (wf.migratedFromLegacy) continue;

        const record = byId.get(wf.researchId);
        if (!record) continue;

        let state = readWorkflowState(wf.researchId);
        if (!state) continue;

        const ledger = readLedger(state.researchId);

        // --- User-timeout handlers (Phase 1 + Phase 4) ---
        if (state.currentPhase === 'phase-1-intake') handleIntakeTimeout(state, record);
        if (state.currentPhase === 'phase-4-direction') handleDirectionTimeout(state, record);

        // --- Phase advancement via deliverable detection ---
        if (phaseDeliverablesReady(state) && isActivePhase(state.currentPhase)) {
          const advanced = advancePhase(state, 'deliverables-ready');
          if (advanced) {
            state = advanced;
            // Dispatch kickoff for the new phase
            if (!ledger.dispatchedPhases.includes(state.currentPhase)) {
              try {
                const result = await dispatchPhaseKickoff(
                  state.currentPhase,
                  { id: record.id, code: record.code, title: record.title, abstract: record.abstract, tags: record.tags, status: record.status },
                  state,
                );
                if (result.discordPosted) {
                  ledger.dispatchedPhases.push(state.currentPhase);
                  writeLedger(ledger);
                } else {
                  console.warn(`[workflow-scheduler] ${record.id}: advance-kickoff failed — ${result.discordError}`);
                }
              } catch (err) {
                console.error(`[workflow-scheduler] ${record.id}: advance-kickoff threw:`, err);
              }
            }
          }
        } else if (isActivePhase(state.currentPhase)) {
          // Self-heal: current phase is sitting idle
          await selfHealCurrentPhase(state, record, ledger);
          // Stall nudge (only for phases that have been stuck past their threshold)
          checkStall(state, record, ledger);
        }

        // --- Daily standup (Phase 7 only, 24h+ after creation, at/after 08:00 local) ---
        if (shouldFireStandup(state, ledger)) {
          dispatchStandup(state, record, ledger);
        }
      } catch (err) {
        console.error(`[workflow-scheduler] tick error for ${wf.researchId}:`, err);
      }
    }
  } finally {
    ticking = false;
  }
}

// ============================================================
// Public API
// ============================================================

export function startWorkflowScheduler(): void {
  if (tickTimer) return;
  console.log('[workflow-scheduler] started (tick every 2 min)');
  // Fire once shortly after boot so the UI doesn't have to wait 2 min
  setTimeout(() => { void runTick(); }, 15 * 1000);
  tickTimer = setInterval(() => { void runTick(); }, TICK_INTERVAL_MS);
}

export function stopWorkflowScheduler(): void {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
    console.log('[workflow-scheduler] stopped');
  }
}

/** Manually trigger a single tick (used by the "Force refresh" button and the Re-kick flow). */
export async function runWorkflowSchedulerOnce(): Promise<void> {
  await runTick();
}
