// ============================================================
// Per-agent cold-start throttle
// ============================================================
// When the user bulk-starts a pile of migrated researches (the
// 396-challenge scenario), we don't want to flood a single agent
// with hundreds of kickoff inboxes. This module enforces
// **max COLD_START_DAILY_LIMIT new research kickoffs per agent per
// local day**. Anything over the limit gets enqueued and drained
// by the scheduler on subsequent ticks / days.
//
// State is persisted to workflows/_queues/cold-start.json.
// Standup and phase-transition dispatches are NOT throttled —
// only brand-new "this agent has never heard of this research
// before" dispatches.
// ============================================================

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJSON } from './ipc-handlers';
import { getWorkflowsRoot } from './research-workflow';

export const COLD_START_DAILY_LIMIT = 5;

export type ThrottleAgent = 'theorist' | 'engineer' | 'assistant';

export interface ThrottleQueueEntry {
  researchId: string;
  agent: ThrottleAgent;
  taskId: string;
  enqueuedAt: string;
}

interface ThrottleState {
  /** Local date (YYYY-MM-DD) the counters reset on */
  date: string;
  /** How many new-research kickoffs we've dispatched to each agent today */
  counts: Record<ThrottleAgent, number>;
  /** Backlog of dispatches deferred because the daily cap was hit */
  queue: ThrottleQueueEntry[];
  /** researches already seen by each agent, so we don't double-count */
  seenByAgent: Record<ThrottleAgent, string[]>;
}

function stateFile(): string {
  const dir = path.join(getWorkflowsRoot(), '_queues');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'cold-start.json');
}

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function emptyState(): ThrottleState {
  return {
    date: todayLocal(),
    counts: { theorist: 0, engineer: 0, assistant: 0 },
    queue: [],
    seenByAgent: { theorist: [], engineer: [], assistant: [] },
  };
}

function readState(): ThrottleState {
  const file = stateFile();
  if (!fs.existsSync(file)) return emptyState();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<ThrottleState>;
    const st: ThrottleState = {
      date: raw.date || todayLocal(),
      counts: {
        theorist: raw.counts?.theorist ?? 0,
        engineer: raw.counts?.engineer ?? 0,
        assistant: raw.counts?.assistant ?? 0,
      },
      queue: Array.isArray(raw.queue) ? raw.queue : [],
      seenByAgent: {
        theorist: Array.isArray(raw.seenByAgent?.theorist) ? raw.seenByAgent!.theorist : [],
        engineer: Array.isArray(raw.seenByAgent?.engineer) ? raw.seenByAgent!.engineer : [],
        assistant: Array.isArray(raw.seenByAgent?.assistant) ? raw.seenByAgent!.assistant : [],
      },
    };
    // Roll over at midnight local
    if (st.date !== todayLocal()) {
      st.date = todayLocal();
      st.counts = { theorist: 0, engineer: 0, assistant: 0 };
      // seenByAgent persists — a research only counts as "new" to an agent once, ever
    }
    return st;
  } catch {
    return emptyState();
  }
}

function writeState(st: ThrottleState): void {
  atomicWriteJSON(stateFile(), st);
}

/**
 * Check whether a cold-start kickoff to `agent` for `researchId` can be
 * dispatched now, or should be queued. Returns true if OK to dispatch.
 *
 * Call this BEFORE writing the inbox message. If it returns true, the caller
 * must then call `markDispatched(agent, researchId)` after a successful write.
 * If it returns false, the caller must call `enqueue(...)` so the scheduler
 * can drain the backlog later.
 */
export function canDispatchColdStart(agent: ThrottleAgent, researchId: string): boolean {
  const st = readState();
  // Already dispatched to this agent for this research — not a cold start anymore
  if (st.seenByAgent[agent].includes(researchId)) return true;
  if (st.counts[agent] >= COLD_START_DAILY_LIMIT) return false;
  return true;
}

export function markDispatched(agent: ThrottleAgent, researchId: string): void {
  const st = readState();
  if (!st.seenByAgent[agent].includes(researchId)) {
    st.seenByAgent[agent].push(researchId);
    st.counts[agent] += 1;
  }
  writeState(st);
}

export function enqueue(entry: ThrottleQueueEntry): void {
  const st = readState();
  // De-dupe: don't enqueue the same (agent, researchId, taskId) twice
  if (st.queue.some(q => q.agent === entry.agent && q.researchId === entry.researchId && q.taskId === entry.taskId)) {
    return;
  }
  st.queue.push(entry);
  writeState(st);
}

/**
 * Drain as many queued entries as today's cap allows. Returns the entries
 * the caller should now dispatch (the counts are NOT incremented here —
 * the caller must call markDispatched after each successful write so that
 * a failure doesn't consume the quota).
 */
export function drain(): ThrottleQueueEntry[] {
  const st = readState();
  const out: ThrottleQueueEntry[] = [];
  const remaining: ThrottleQueueEntry[] = [];
  // Available slots per agent for the rest of today
  const slots: Record<ThrottleAgent, number> = {
    theorist: Math.max(0, COLD_START_DAILY_LIMIT - st.counts.theorist),
    engineer: Math.max(0, COLD_START_DAILY_LIMIT - st.counts.engineer),
    assistant: Math.max(0, COLD_START_DAILY_LIMIT - st.counts.assistant),
  };
  for (const e of st.queue) {
    if (slots[e.agent] > 0 && !st.seenByAgent[e.agent].includes(e.researchId)) {
      out.push(e);
      slots[e.agent] -= 1;
    } else if (st.seenByAgent[e.agent].includes(e.researchId)) {
      // Already delivered some other way — drop it
      continue;
    } else {
      remaining.push(e);
    }
  }
  st.queue = remaining;
  writeState(st);
  return out;
}

export function readThrottleSnapshot(): {
  date: string;
  counts: Record<ThrottleAgent, number>;
  queueLength: number;
} {
  const st = readState();
  return { date: st.date, counts: st.counts, queueLength: st.queue.length };
}
