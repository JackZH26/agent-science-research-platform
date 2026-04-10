# Standard Research Workflow — SRW-v2

This is the canonical research workflow all ASRP researches start with.
The Theorist is the primary owner of every research after Phase 1; Assistant
hosts the opening Q&A, and Engineer reviews feasibility.

> **Time convention** — Phases 1–6 are **bootstrap phases** and run on AI
> *minutes*, not AI hours. The goal is to reach the first Direction Menu in
> the Discord channel in **≤20 minutes of wall-clock time**, so the user can
> immediately steer the research. Only Phase 7 (Active Loop) uses the "1 human
> day = 1 AI hour" convention for long-running work.

---

## Team roles (3-agent configuration)

### Theorist (Opus) — Lead scientist
- Owns literature reconnaissance, opportunity synthesis, plan, final papers
- **Literature search is your own job** — use web, arxiv, and any tools in
  your SOUL. Do NOT delegate literature search to anyone else.
- **Self red-team pass**: After any draft (opportunities, plan, paper), switch
  into "critic hat" and re-read it as if you were a hostile reviewer. Produce
  `critique.md` listing weaknesses before declaring a deliverable done.
- In Phases 2–3 you are on a **tight minute budget** — deep dives happen in
  Phase 7, not in bootstrap.

### Engineer (Sonnet) — Execution + numerical reviewer
- Implement code, run experiments, process data
- **Independently recompute** any numerical result Theorist produces. Use a
  different implementation path (different library, different algorithm, or
  at least different parameterization).
- In Phase 5 you review feasibility of the draft plan against compute budget.

### Assistant (Haiku) — Coordinator + scribe
- **Phase 1 owner**: host the 3-question intake Q&A with the researcher
- Draft the daily standup at 08:00 local time during Phase 7
- Format Theorist's opportunity list into a Direction Menu on Discord (Phase 4)
- Send reminders when a phase stalls
- You do NOT do research yourself — your job is to make the other two agents
  and the human researcher move smoothly together.

---

## The seven phases

### Phase 0 — Bootstrap (system, instant)

System creates:
- Research record in `system/researches.json`
- Directory tree under `researches/{id}/`
- Discord channel named after the research
- `workflows/{id}/state.json` with `currentPhase: "phase-1-intake"`
- Immediately dispatches Phase 1 kickoff to the **Assistant** via Discord
  `@mention` in the new channel.

### Phase 1 — Researcher Intake (Assistant, ≤2 AI min + user wait)

**Assistant** asks the researcher 3 core questions in the Discord channel,
one at a time, and may ask 0–4 follow-ups as needed:

1. **Goal** — In one sentence, what do you want this research to achieve?
2. **Deadline / venue** — Any hard deadline or target venue (paper, thesis,
   lab deliverable, personal exploration)?
3. **Background depth + constraints** — How deep should we go (survey,
   practitioner, expert-level), and any constraints on compute, tools,
   ethics, IP?

**Output**: `workflows/{id}/intake.json` with fields:
`{ goal, outputType, targetVenue, deadline, backgroundDepth, constraints, notes, _auto? }`

**Auto-continue**: If the user does not respond within **12 hours**, the
scheduler writes a default intake (`outputType: "personal"`,
`backgroundDepth: "practitioner"`, `_auto: true`) and advances. The user can
still edit this at any time afterwards.

### Phase 2 — Reconnaissance (Theorist, ≤8 AI min)

**Theorist**
- Tight scan of 5–10 key papers on the topic
- Output: `workflows/{id}/literature/papers.json` — 5–10 entries with
  `{ title, authors, year, venue, keyClaim, relevance }`
- Output: `workflows/{id}/background.md` — ≤300 words on domain state,
  open questions, common pitfalls

This is the first **minute-budgeted** phase — the point is to get enough
context to frame directions, not to write an exhaustive survey.

### Phase 3 — Synthesis (Theorist, ≤5 AI min)

**Theorist**
- Read intake.json, papers.json, background.md
- Identify **3 to 5 concrete directions** tailored to the user's intake
- Each direction: title (1 line), why interesting (2 sentences), why now
  (what makes it tractable), difficulty, risk
- Output: `workflows/{id}/opportunities.md`

### Phase 4 — Direction Pick (Assistant + user, ≤48h)

**Assistant**
- Format `opportunities.md` into a numbered Discord post — the **Direction
  Menu** — and ask the user to pick 1.
- When the user replies, write `workflows/{id}/direction.json` with the
  chosen direction.

This is the ~20-minute checkpoint: the user sees a concrete menu shaped by
their own intake answers.

**Auto-continue**: If the user does not pick within **48 hours**, the
scheduler picks direction #1 (`_auto: true`) and advances.

### Phase 5 — Plan (Theorist + Engineer, ≤10 AI min total)

**Theorist (draft, ~7 min)**
- Task DAG in `workflows/{id}/plan.json` — each task: id, title, owner,
  description, estimateAiHours, dependsOn, deliverable, successCriteria
- Target: <50 total AI hours for most researches

**Engineer (feasibility, ~3 min)**
- Flag infeasible tasks, propose splits
- Write `workflows/{id}/plan-feasibility.md`

### Phase 6 — Schedule (Theorist, ≤2 AI min)

- Generate the first 7 nights of work into `workflows/{id}/schedule.json`
- Each night: `{ date, tasks: [{ agent, taskId, kickoffMessage }] }`
- Respect dependencies; compute-heavy tasks prioritized for 00:00–06:00 local

### Phase 7 — Active Loop (continuous)

- Scheduler dispatches tonight's tasks at 00:00 local
- Numerical deliverables independently recomputed by Engineer
- Each morning at 08:00 (starting 24h after Phase 7 entry), Assistant writes
  the **Daily Standup** to Discord:
  - What we did last night
  - What we found
  - What we will do tonight
  - Blockers / human input needed
- Loop continues until `confirmed`, `refuted`, or manually marked
  `completed` / `stopped`.

---

## Discord trigger mechanism

Agents are OpenClaw bots that respond to Discord `@mention`s in the research
channel. Every phase kickoff is both:
1. Written to `workflows/{id}/inbox/` as an audit trail, AND
2. Posted into the Discord channel with an `@mention` of the owning agent's
   bot ID (Theorist / Engineer / Assistant).

If an agent fails to produce a deliverable within the phase's stall window,
the scheduler **self-heals** by re-dispatching the kickoff (up to 3× per
phase). The user can also click **Re-kick** in the Workflow tab at any time
to force a redispatch.

---

## Stall thresholds (per phase)

| Phase | Threshold | Notes |
|---|---|---|
| 1 Intake | 2h | user-wait; auto-default after 12h |
| 2 Reconnaissance | 30 min | agent work |
| 3 Synthesis | 20 min | agent work |
| 4 Direction | 24h | user-wait; auto-pick after 48h |
| 5 Plan | 30 min | agent work |
| 6 Schedule | 15 min | agent work |
| 7 Active | 24h | long-running |

---

## Stop conditions

A research reaches a terminal state when **any** of:
1. Theorist confirms with reviewer-grade evidence → `confirmed`
2. Engineer's independent recompute contradicts → `refuted`
3. User clicks "Mark Complete" → `completed`
4. User clicks "Stop" → `stopped`

---

## Editing the plan mid-flight

The user can edit `intake.json`, `direction.json`, `plan.json` and
`schedule.json` at any time through the Workflow tab. On the next scheduler
tick, Theorist reads the new files and adjusts dispatch. Edits are
non-destructive — previous versions go to `workflows/{id}/history/`.
