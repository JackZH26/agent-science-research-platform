// ============================================================
// Workflow Scheduler — SRW-v1 Phase 1–6 orchestrator
// ============================================================
// Runs on a periodic tick. For every active workflow state:
//   1. Detect whether the deliverables of the CURRENT phase have
//      landed on disk (written by the agents). If so, advance to
//      the next phase and dispatch the next kickoff inbox.
//   2. Handle Phase 3 intake timeout (12h) by auto-proceeding
//      with defaults.
//   3. At 08:00 local, dispatch a daily-standup inbox to
//      Assistant for every active workflow.
//   4. Stall detection: if a phase has been in progress for
//      >24h without any advance, nudge the responsible agent.
//
// The scheduler NEVER does research itself — its only output is
// state.json updates + inbox messages to agents. Agents still
// pick up work through their normal message-polling loop.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJSON } from './ipc-handlers';
import {
  WorkflowPhase,
  WorkflowState,
  InboxMessage,
  listWorkflows,
  readWorkflowState,
  writeWorkflowState,
  getWorkflowDir,
  writeInboxMessage,
  writePhase1KickoffInbox,
  inboxHasTask,
} from './research-workflow';
import { loadResearches, ResearchRecord } from './experiment-handlers';
import {
  drain as drainColdStart,
  markDispatched as markColdStartDispatched,
  enqueue as enqueueColdStart,
} from './workflow-throttle';

const TICK_INTERVAL_MS = 5 * 60 * 1000;       // 5 minutes
const INTAKE_TIMEOUT_MS = 12 * 60 * 60 * 1000; // 12 hours
const STALL_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const STANDUP_HOUR = 8;                         // 08:00 local — earliest time a standup may fire

let tickTimer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

// ============================================================
// Inbox dispatch — delegates to the shared writer in
// research-workflow.ts so bootstrap and scheduler produce
// byte-identical filenames.
// ============================================================

type AgentName = 'theorist' | 'engineer' | 'assistant';

function ensureDir(p: string): void {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function dispatchInbox(msg: InboxMessage): void {
  writeInboxMessage(msg);
}

// ============================================================
// Scheduler state (dispatch de-duplication + daily standup log)
// ============================================================
// We keep a small per-workflow scheduler ledger so we don't
// dispatch the same phase kickoff twice after a restart, and so
// the 08:00 standup fires at most once per local day.

interface SchedulerLedger {
  researchId: string;
  /** Phases we've already dispatched a kickoff for */
  dispatchedPhases: WorkflowPhase[];
  /** ISO dates (YYYY-MM-DD) we've already sent the standup for */
  standupDates: string[];
  /** Last time we nudged about a stall */
  lastStallNudgeAt: string | null;
}

function getLedgerFile(researchId: string): string {
  return path.join(getWorkflowDir(researchId), 'scheduler-ledger.json');
}

function readLedger(researchId: string): SchedulerLedger {
  const file = getLedgerFile(researchId);
  if (!fs.existsSync(file)) {
    return { researchId, dispatchedPhases: [], standupDates: [], lastStallNudgeAt: null };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<SchedulerLedger>;
    return {
      researchId,
      dispatchedPhases: Array.isArray(raw.dispatchedPhases) ? raw.dispatchedPhases : [],
      standupDates: Array.isArray(raw.standupDates) ? raw.standupDates : [],
      lastStallNudgeAt: raw.lastStallNudgeAt || null,
    };
  } catch {
    return { researchId, dispatchedPhases: [], standupDates: [], lastStallNudgeAt: null };
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
  const id = state.researchId;
  switch (state.currentPhase) {
    case 'phase-1-reconnaissance':
      return workflowFileExists(id, 'literature/papers.json') &&
             workflowFileExists(id, 'background.md');
    case 'phase-2-synthesis':
      return workflowFileExists(id, 'opportunities.md');
    case 'phase-3-intake':
      return workflowFileExists(id, 'intake.json');
    case 'phase-4-plan':
      return workflowFileExists(id, 'plan.json') &&
             workflowFileExists(id, 'plan-critique.md');
    case 'phase-5-schedule':
      return workflowFileExists(id, 'schedule.json');
    case 'phase-6-active':
    case 'phase-0-bootstrap':
    case 'completed':
    case 'stopped':
    case 'legacy':
      return false;
    default:
      return false;
  }
}

const PHASE_ORDER: WorkflowPhase[] = [
  'phase-0-bootstrap',
  'phase-1-reconnaissance',
  'phase-2-synthesis',
  'phase-3-intake',
  'phase-4-plan',
  'phase-5-schedule',
  'phase-6-active',
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
// Phase kickoff messages
// ============================================================
// Each phase transition generates a short, structured inbox
// message to the agent who owns the next phase. The agent's
// normal message-polling loop will read it and execute.

function nowIso(): string { return new Date().toISOString(); }

function buildKickoff(
  phase: WorkflowPhase,
  record: ResearchRecord,
): { to: AgentName; subject: string; body: string; deliverable: string | null; taskId: string } | null {
  const id = record.id;
  const code = record.code || id;
  const title = record.title || id;

  switch (phase) {
    case 'phase-2-synthesis':
      return {
        to: 'theorist',
        taskId: 'SRW-P2-SYNTHESIS',
        subject: `[${code}] Phase 2 — Synthesis: 3–5 breakthrough opportunities`,
        deliverable: `workflows/${id}/opportunities.md`,
        body: [
          `# Phase 2 — Synthesis (${code}: ${title})`,
          '',
          'Phase 1 deliverables have landed. Now synthesize.',
          '',
          '## Your task (~1 AI hour, solo)',
          '',
          `1. Re-read \`workflows/${id}/literature/papers.json\` and \`workflows/${id}/background.md\`.`,
          '2. Identify **3 to 5 concrete breakthrough opportunities** for this research.',
          '   Each opportunity must include:',
          '   - title (one line)',
          '   - why interesting (2 sentences)',
          '   - why now (what makes it tractable today)',
          '   - difficulty estimate (easy / medium / hard / moonshot)',
          '   - key risks',
          `3. Write \`workflows/${id}/opportunities.md\`.`,
          '4. Switch to critic hat and produce',
          `   \`workflows/${id}/opportunities-critique.md\`.`,
          '',
          'When opportunities.md exists, Assistant will automatically format',
          'it into a Discord post for the user.',
        ].join('\n'),
      };

    case 'phase-3-intake':
      return {
        to: 'assistant',
        taskId: 'SRW-P3-INTAKE',
        subject: `[${code}] Phase 3 — Researcher intake Q&A`,
        deliverable: `workflows/${id}/intake.json`,
        body: [
          `# Phase 3 — Researcher Intake (${code}: ${title})`,
          '',
          `Theorist has published \`workflows/${id}/opportunities.md\`.`,
          '',
          '## Your task',
          '',
          '1. Format `opportunities.md` into a concise Discord post and publish',
          '   it to this research\'s Discord channel with a prompt asking which',
          '   direction excites the user most.',
          '2. Then host a short, friendly Q&A in the same channel. **One question',
          '   at a time.** Capture answers into',
          `   \`workflows/${id}/intake.json\` as you go.`,
          '   Required fields:',
          '   - `opportunityPick`: 1–5 or "other"',
          '   - `outputType`: journal / thesis / institute / personal / other',
          '   - `targetVenue`: string or null',
          '   - `deadline`: ISO date or "none"',
          '   - `constraints`: free-form string',
          '',
          '**Timeout**: if the user doesn\'t respond within 12 hours, the',
          'scheduler will auto-advance with defaults (personal exploration,',
          'no deadline, no constraints). You don\'t need to enforce this',
          'yourself — just keep the conversation friendly.',
        ].join('\n'),
      };

    case 'phase-4-plan':
      return {
        to: 'theorist',
        taskId: 'SRW-P4-PLAN',
        subject: `[${code}] Phase 4 — Plan construction`,
        deliverable: `workflows/${id}/plan.json`,
        body: [
          `# Phase 4 — Plan Construction (${code}: ${title})`,
          '',
          `Intake is in \`workflows/${id}/intake.json\`. Build the task DAG.`,
          '',
          '## Your task (~3 AI hours total)',
          '',
          `1. **Draft** (~2 hours): write \`workflows/${id}/plan.json\` with a task DAG.`,
          '   Each task: `{id, title, owner, phase, description, estimateAiHours,`',
          '   `dependsOn, deliverable, successCriteria}`. Owners are',
          '   `theorist`, `engineer`, or `assistant`.',
          '2. **Feasibility review**: drop a message in',
          `   \`workspace/messages/theorist-to-engineer-*.json\` asking Engineer`,
          `   to read the plan and write \`workflows/${id}/plan-feasibility.md\`.`,
          '3. **Red team** (~30 min): re-read the plan with critic hat and',
          `   produce \`workflows/${id}/plan-critique.md\`. Revise plan.json if`,
          '   needed.',
          `4. Produce \`workflows/${id}/plan.md\` — a human-readable markdown`,
          '   summary. Assistant will post it to Discord.',
          '',
          '**Budget guideline**: <50 total AI hours. If you go over, flag scope',
          'issues in `plan-critique.md` and propose cuts.',
          '',
          '**Time convention**: 1 human day = 1 AI hour.',
        ].join('\n'),
      };

    case 'phase-5-schedule':
      return {
        to: 'theorist',
        taskId: 'SRW-P5-SCHEDULE',
        subject: `[${code}] Phase 5 — Schedule the first 7 nights`,
        deliverable: `workflows/${id}/schedule.json`,
        body: [
          `# Phase 5 — Schedule (${code}: ${title})`,
          '',
          `Plan is locked in \`workflows/${id}/plan.json\`. Schedule the work.`,
          '',
          '## Your task (~0.5 AI hours)',
          '',
          `1. Write \`workflows/${id}/schedule.json\` with the next 7 nights.`,
          '   Format: `{ nights: [{ date, tasks: [{ agent, taskId, kickoffMessage }] }] }`',
          '2. Respect task dependencies from `plan.json`.',
          '3. Put compute-heavy tasks in the **00:00–06:00 local** window.',
          '   Light tasks (standups, formatting, intake) can run any time.',
          '4. Leave the 7th night lighter — it\'s the weekly review slot.',
        ].join('\n'),
      };

    case 'phase-6-active':
      return {
        to: 'theorist',
        taskId: 'SRW-P6-ACTIVE-LOOP',
        subject: `[${code}] Phase 6 — Active loop`,
        deliverable: null,
        body: [
          `# Phase 6 — Active Loop (${code}: ${title})`,
          '',
          `Schedule is live in \`workflows/${id}/schedule.json\`.`,
          '',
          '## Ongoing responsibilities',
          '',
          '- Each night at 00:00 local, dispatch that night\'s tasks to the',
          '  owning agents (write inbox messages per the schedule).',
          '- For any numerical result you produce, ask Engineer to',
          '  **independently recompute** it before marking it done.',
          '- Each morning, Assistant will write the Daily Standup automatically',
          '  — but if something broke last night, proactively tell Assistant',
          '  what to highlight.',
          '- Update status → `confirmed` / `refuted` / `completed` when the',
          '  stop conditions fire.',
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
// Advance a workflow by exactly one phase
// ============================================================

function advancePhase(state: WorkflowState, reason: string): WorkflowState | null {
  const next = nextPhase(state.currentPhase);
  if (!next) return null;

  // Close out the current phase in history
  const last = state.phaseHistory[state.phaseHistory.length - 1];
  const now = nowIso();
  if (last && !last.completedAt) last.completedAt = now;
  state.phaseHistory.push({ phase: next, startedAt: now, completedAt: null });
  state.currentPhase = next;
  writeWorkflowState(state);

  console.log(`[workflow-scheduler] ${state.researchId}: advanced → ${next} (${reason})`);
  return state;
}

// ============================================================
// Phase-3 intake timeout handler
// ============================================================

function handleIntakeTimeout(state: WorkflowState, record: ResearchRecord): boolean {
  if (state.currentPhase !== 'phase-3-intake') return false;
  const phaseEntry = state.phaseHistory[state.phaseHistory.length - 1];
  if (!phaseEntry || phaseEntry.phase !== 'phase-3-intake') return false;

  const startedAt = Date.parse(phaseEntry.startedAt);
  if (isNaN(startedAt)) return false;
  if (Date.now() - startedAt < INTAKE_TIMEOUT_MS) return false;

  // Write a default intake.json on the user's behalf
  const intakePath = path.join(getWorkflowDir(record.id), 'intake.json');
  if (!fs.existsSync(intakePath)) {
    const defaults = {
      opportunityPick: 'theorist-choice',
      outputType: 'personal',
      targetVenue: null,
      deadline: 'none',
      constraints: 'none',
      _auto: true,
      _reason: 'Phase 3 intake timed out after 12h — defaults applied',
      _timestamp: nowIso(),
    };
    atomicWriteJSON(intakePath, defaults);
    console.log(`[workflow-scheduler] ${record.id}: intake timeout — wrote defaults`);
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

function shouldFireStandup(ledger: SchedulerLedger): boolean {
  const now = new Date();
  // Fire any time on/after 08:00 local, as long as today's standup hasn't
  // already been dispatched. This is the first tick on/after 08:00 each day
  // (or the first tick of the day at all, if the app was off at 08:00).
  if (now.getHours() < STANDUP_HOUR) return false;
  return !ledger.standupDates.includes(todayLocal());
}

function dispatchStandup(state: WorkflowState, record: ResearchRecord, ledger: SchedulerLedger): void {
  const today = todayLocal();
  dispatchInbox({
    from: 'system',
    to: 'assistant',
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
      '1. **Last night** — what we did (check `workflows/{id}/inbox/` and recent',
      '   agent outputs in `workspace/messages/` addressed to/from theorist/engineer)',
      '2. **Findings** — any concrete results or pivots (if none, say so honestly)',
      '3. **Tonight** — what we\'re planning (look at `workflows/{id}/schedule.json`',
      '   if it exists)',
      '4. **Blockers / human input needed** — list anything waiting on the user',
      '',
      'Keep it under 10 lines. Use emoji sparingly. Honesty over hype.',
    ].join('\n'),
  });
  ledger.standupDates.push(today);
  // Keep ledger compact — only last 14 days
  if (ledger.standupDates.length > 14) {
    ledger.standupDates = ledger.standupDates.slice(-14);
  }
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
  if (Date.now() - startedAt < STALL_THRESHOLD_MS) return;

  // Don't nudge more than once per 24h
  if (ledger.lastStallNudgeAt) {
    const lastNudge = Date.parse(ledger.lastStallNudgeAt);
    if (!isNaN(lastNudge) && Date.now() - lastNudge < STALL_THRESHOLD_MS) return;
  }

  // Figure out who owns the current phase
  const owner: AgentName = (state.currentPhase === 'phase-3-intake') ? 'assistant' : 'theorist';

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
      `This research has been in \`${state.currentPhase}\` for more than 24`,
      `hours without advancing. The scheduler is pinging you.`,
      '',
      '## What to check',
      '1. Have you already produced the phase deliverable? If yes, make sure',
      '   it was written to the expected path inside `workflows/{id}/`.',
      '2. If the task is genuinely blocked, post a message to Assistant so',
      '   the user sees it in the Daily Standup.',
      '3. If the task is too large, split it or escalate.',
      '',
      'If everything is fine and you just need more time, write a short note',
      `in \`workflows/${record.id}/status-notes.md\` so the user knows.`,
    ].join('\n'),
  });
  ledger.lastStallNudgeAt = nowIso();
  writeLedger(ledger);
  console.log(`[workflow-scheduler] ${record.id}: stall nudge sent (phase=${state.currentPhase})`);
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
    // Anything that was queued because an agent hit its daily cap can now
    // be dispatched if slots have opened up (new day rollover, or other
    // dispatches finished without consuming quota).
    try {
      const drained = drainColdStart();
      for (const entry of drained) {
        const rec = byId.get(entry.researchId);
        if (!rec) {
          // Research no longer exists — drop silently (already removed from queue by drain)
          continue;
        }
        if (entry.agent === 'theorist' && entry.taskId === 'SRW-P1-KICKOFF') {
          writePhase1KickoffInbox({
            id: rec.id,
            code: rec.code,
            title: rec.title,
            abstract: rec.abstract,
            tags: rec.tags,
            status: rec.status,
          });
          markColdStartDispatched('theorist', rec.id);
          console.log(`[workflow-scheduler] drained cold-start kickoff for ${rec.id}`);
        } else {
          // Unknown (agent, taskId) combo — not something this scheduler knows
          // how to re-build. Put it back in the queue so a future, smarter
          // drainer can handle it instead of silently dropping the dispatch.
          console.warn(`[workflow-scheduler] drained unknown cold-start entry (agent=${entry.agent}, task=${entry.taskId}) for ${entry.researchId} — re-queuing`);
          enqueueColdStart(entry);
        }
      }
    } catch (err) {
      console.error('[workflow-scheduler] cold-start drain failed:', err);
    }

    for (const wf of workflows) {
      try {
        // Skip terminal / paused / legacy / migrated-not-started workflows
        if (wf.paused) continue;
        if (wf.currentPhase === 'completed' || wf.currentPhase === 'stopped' || wf.currentPhase === 'legacy') continue;
        if (wf.migratedFromLegacy) continue; // user must click "Properly Start" first

        const record = byId.get(wf.researchId);
        if (!record) continue; // dangling workflow

        // Re-read state fresh each iteration (may have been mutated by another pass)
        let state = readWorkflowState(wf.researchId);
        if (!state) continue;

        const ledger = readLedger(state.researchId);

        // --- Phase 3 intake timeout ---
        if (state.currentPhase === 'phase-3-intake') {
          handleIntakeTimeout(state, record);
        }

        // --- Phase advancement via deliverable detection ---
        if (phaseDeliverablesReady(state) && isActivePhase(state.currentPhase)) {
          const advanced = advancePhase(state, 'deliverables-ready');
          if (advanced) {
            state = advanced;
            // Dispatch kickoff for the new phase (once)
            if (!ledger.dispatchedPhases.includes(state.currentPhase)) {
              const kick = buildKickoff(state.currentPhase, record);
              if (kick) {
                dispatchInbox({
                  from: 'system',
                  to: kick.to,
                  researchId: record.id,
                  researchCode: record.code || '',
                  researchTitle: record.title || '',
                  phase: state.currentPhase,
                  taskId: kick.taskId,
                  subject: kick.subject,
                  body: kick.body,
                  deadline: null,
                  deliverable: kick.deliverable,
                  createdAt: nowIso(),
                });
                ledger.dispatchedPhases.push(state.currentPhase);
                writeLedger(ledger);
              }
            }
          }
        } else if (isActivePhase(state.currentPhase)) {
          // Current phase still running — ensure its kickoff was dispatched.
          // (Phase 1's kickoff was already sent by bootstrap; everything from
          // Phase 2 onward is our responsibility.) Double-check the inbox
          // folder too, in case the ledger failed to persist after a crash.
          if (state.currentPhase !== 'phase-1-reconnaissance' &&
              !ledger.dispatchedPhases.includes(state.currentPhase)) {
            const kick = buildKickoff(state.currentPhase, record);
            if (kick && inboxHasTask(record.id, kick.taskId)) {
              // A prior tick already wrote the file, ledger just didn't catch it.
              ledger.dispatchedPhases.push(state.currentPhase);
              writeLedger(ledger);
            } else if (kick) {
              dispatchInbox({
                from: 'system',
                to: kick.to,
                researchId: record.id,
                researchCode: record.code || '',
                researchTitle: record.title || '',
                phase: state.currentPhase,
                taskId: kick.taskId,
                subject: kick.subject,
                body: kick.body,
                deadline: null,
                deliverable: kick.deliverable,
                createdAt: nowIso(),
              });
              ledger.dispatchedPhases.push(state.currentPhase);
              writeLedger(ledger);
            }
          }

          // --- Stall detection ---
          checkStall(state, record, ledger);
        }

        // --- Daily standup (fires once per local day at 08:00) ---
        if (isActivePhase(state.currentPhase) && shouldFireStandup(ledger)) {
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
  console.log('[workflow-scheduler] started (tick every 5 min)');
  // Fire once shortly after boot so the UI doesn't have to wait 5 min
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

/** Manually trigger a single tick (used by tests / "force refresh" button). */
export async function runWorkflowSchedulerOnce(): Promise<void> {
  await runTick();
}
