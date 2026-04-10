# Standard Research Workflow — SRW-v3

This is the canonical research workflow all ASRP researches start with.
**Theorist** is the primary owner of every active phase (1–7) and is the
single user-facing voice in the research channel. **Engineer** reviews
feasibility and independently recomputes numerical results. **Reviewer**
dispatches phase kickoffs, writes daily standups, and applies independent
red-team critique.

> **Time convention** — Phases 1–6 are **bootstrap phases** and run on AI
> *minutes*, not AI hours. The goal is to reach the first Direction Menu in
> the Discord channel in **≤20 minutes of wall-clock time**, so the user can
> immediately steer the research. Only Phase 7 (Active Loop) uses the "1 human
> day = 1 AI hour" convention for long-running work.

> **SRW-v3 change** — In v2 the third-agent role was called "Assistant" and
> owned Phase 1 (Intake) + Phase 4 (Direction Pick). That caused a
> self-mention deadlock: the dispatcher posted as Assistant and @mentioned
> Assistant, which Discord silently dropped. In v3 the role is **Reviewer**
> (dispatcher + standup + critic), and Theorist owns all user-facing phases.
> Sender ≠ mention target is now a runtime invariant.

---

## Team roles (3-agent configuration)

### Theorist (Opus) — Lead scientist & user-facing voice
- Owns Phase 1 Intake Q&A with the researcher
- Owns literature reconnaissance, opportunity synthesis, direction
  selection, plan construction, scheduling, and the active loop
- **Literature search is your own job** — use web, arxiv, and any tools
  in your SOUL. Do NOT delegate literature search to anyone else.
- **Self red-team pass**: After any draft (opportunities, plan, paper),
  switch into "critic hat" and re-read it as if you were a hostile
  reviewer. Produce `*-critique.md` listing weaknesses before declaring
  a deliverable done.
- In Phases 2–3 you are on a **tight minute budget** — deep dives happen
  in Phase 7, not in bootstrap.

### Engineer (Sonnet) — Execution + numerical reviewer
- Implement code, run experiments, process data
- **Independently recompute** any numerical result Theorist produces.
  Use a different implementation path (different library, different
  algorithm, or at least different parameterization).
- In Phase 5 you review feasibility of the draft plan against compute budget.

### Reviewer (Haiku/Sonnet) — Dispatcher + standup + critic
- **Dispatcher**: post phase-kickoff messages in each research channel
  that @mention Theorist (or Engineer). Never @mention yourself — bots
  don't receive self-mention events.
- **Daily standup author**: at 08:00 local, write an honest standup for
  every Phase 7 research.
- **Independent critic**: apply red-team scrutiny to Theorist's
  `opportunities.md`, `plan.json`, and final results. Write sibling
  `*-critique.md` files.
- **Workflow hygiene**: on 12h Phase 1 silence, auto-fill defaults;
  on 48h Phase 4 silence, auto-pick Theorist's top recommendation.
- You do NOT do science and you do NOT host user Q&A.

---

## The seven phases

### Phase 0 — Bootstrap (system, instant)

System creates:
- Research record in `system/researches.json`
- Directory tree under `researches/{id}/`
- Discord channel named after the research
- `workflows/{id}/state.json` with `currentPhase: "phase-1-intake"`
- Posts a human-readable welcome to the channel as **Reviewer**.
- Immediately dispatches Phase 1 kickoff: Reviewer posts
  `<@Theorist> 初始化研究 {code}` in the new channel.

### Phase 1 — Researcher Intake (Theorist, ≤10 AI min + user wait)

**Theorist** greets the user and asks 3 core questions in the Discord
channel, one at a time, with 0–4 follow-ups as needed:

1. **Goal / output type** — paper, thesis, prototype, personal, or other?
2. **Deadline / target venue** — any hard deadline, or open-ended?
3. **Background depth + constraints** — beginner, practitioner, or
   expert? Any compute, tools, or ethics constraints?

**Output**: `workflows/{id}/intake.json` with fields:
`{ outputType, targetVenue, deadline, backgroundDepth, constraints, additionalNotes, _auto? }`

**Auto-continue**: If the user does not respond within **12 hours**,
**Reviewer** writes a default intake (`outputType: "personal"`,
`backgroundDepth: "practitioner"`, `_auto: true`) and advances. The user
can still edit afterwards.

### Phase 2 — Reconnaissance (Theorist, ≤8 AI min)

**Theorist**
- Tight scan of ~10 key papers on the topic
- Output: `workflows/{id}/literature/papers.json` with
  `{ title, authors, year, venue, url, keyClaim, keyMethod, keyResult, relevance }`
- Output: `workflows/{id}/background.md` — 200–400 words on domain state,
  open questions, and common pitfalls

First **minute-budgeted** phase — the point is to frame directions, not
to write an exhaustive survey.

### Phase 3 — Synthesis (Theorist, ≤5 AI min)

**Theorist**
- Read `intake.json`, `papers.json`, `background.md`
- Identify **3 to 5 concrete directions** tailored to the user's intake
- Each direction: title (1 line), why interesting (2 sentences), why now,
  difficulty, rough cost (AI hours), key risks
- End with a 5-line critic-hat section naming the weakest direction
- Output: `workflows/{id}/opportunities.md`

### Phase 4 — Direction Pick (Theorist + user, ≤48h)

**Theorist**
- Format `opportunities.md` into a numbered Discord post — the
  **Direction Menu** — and ask the user to pick 1.
- Ask at most one follow-up to refine the variant (e.g. fast vs
  ambitious), then write `workflows/{id}/direction.json`.

**Auto-continue**: If the user does not pick within **48 hours**,
**Reviewer** picks Theorist's top recommendation (`_auto: true`) and
advances.

### Phase 5 — Plan (Theorist + Engineer, ≤10 AI min total)

**Theorist (draft, ~6 min)**
- Task DAG in `workflows/{id}/plan.json` — each task:
  `{ id, title, owner, phase, description, estimateAiHours, dependsOn, deliverable, successCriteria }`
- Owners are `theorist`, `engineer`, or `reviewer`
- Target: <50 total AI hours for most researches

**Engineer (feasibility, ~3 min)**
- Flag infeasible tasks, propose splits
- Write `workflows/{id}/plan-feasibility.md`

**Theorist (revise, ~1 min)**
- Incorporate Engineer's flags into plan.json
- Produce `workflows/{id}/plan.md` as a Discord-ready summary

### Phase 6 — Schedule (Theorist, ≤2 AI min)

- Generate the first 7 nights of work into `workflows/{id}/schedule.json`
- Each night: `{ date, tasks: [{ agent, taskId, kickoffMessage }] }`
- Respect dependencies; compute-heavy tasks prioritized for 00:00–06:00 local
- Leave night 7 lighter (weekly review slot)

### Phase 7 — Active Loop (continuous)

- **Theorist**: dispatches tonight's tasks at 00:00 local per the schedule
- **Engineer**: independently recomputes any numerical deliverable
- **Reviewer**: each morning at 08:00 (starting 24h after Phase 7 entry),
  writes the **Daily Standup** to Discord:
  - What we did last night
  - What we found
  - What we will do tonight
  - Blockers / human input needed
- Loop continues until `confirmed`, `refuted`, or manually marked
  `completed` / `stopped`.

---

## Discord trigger mechanism

Agents are OpenClaw bots that respond to Discord `@mention`s in the
research channel. Every phase kickoff is both:
1. Written to `workflows/{id}/inbox/` as an audit trail, AND
2. Posted into the Discord channel by **Reviewer** with a `<@...>`
   mention of the owning agent's bot ID (Theorist or Engineer).

**Sender / Mention invariant**: the bot that posts the kickoff MUST NOT
be the same bot that is @mentioned. Discord silently drops bot
self-mention events. `dispatchPhaseKickoff` asserts this at runtime.

If the phase actor fails to produce a deliverable within the stall
window, the scheduler **self-heals** by re-dispatching the kickoff (up
to 3× per phase). The user can also click **Re-kick** in the Workflow
tab at any time to force a redispatch.

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
`schedule.json` at any time through the Workflow tab. On the next
scheduler tick, Theorist reads the new files and adjusts dispatch.
Edits are non-destructive — previous versions go to
`workflows/{id}/history/`.
