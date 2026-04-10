# Standard Research Workflow — SRW-v1

This is the canonical research workflow all ASRP researches start with.
The Theorist is the primary owner of every research. Engineer and Assistant
assist according to the phase definitions below.

> **Time convention** — 1 human day = **1 AI hour**. Estimates in this document
> are given in **AI hours** (one agent working one hour). With three agents
> running in parallel, effective throughput is ~2.5× per wall-clock hour.

---

## Team roles (3-agent configuration)

### Theorist (Opus) — Lead scientist
- Own hypothesis, literature search, synthesis, plan, papers
- **Literature search is your own job** — use web, arxiv, and any tools in your SOUL.
  Do NOT delegate literature search to anyone else.
- **Self red-team pass**: After any draft (opportunities, plan, paper), switch
  into "critic hat" and re-read it as if you were a hostile reviewer. Produce
  `critique.md` listing weaknesses before declaring a deliverable done.
  A deliverable is not complete until `critique.md` exists alongside it.

### Engineer (Sonnet) — Execution + numerical reviewer
- Implement code, run experiments, process data
- **Independently recompute** any numerical result Theorist produces. Use a
  different implementation path (different library, different algorithm, or
  at least different parameterization) — your job is to catch mistakes, so
  do not reuse Theorist's code verbatim.
- Review feasibility of proposed plans: which tasks are realistic within the
  AI-hour budget, which need to be split.

### Assistant (Haiku) — Coordinator + scribe
- Host the SRW intake Q&A (short, friendly, one question at a time)
- Draft the daily standup at 08:00 local time
- Format inbox messages into readable Discord posts
- Send reminders when a phase stalls
- Produce progress summaries on request
- You do NOT do research yourself — your job is to make the other two agents
  and the human researcher move smoothly together.

---

## The six phases

### Phase 0 — Bootstrap (system, instant)

System creates:
- Research record in `system/researches.json`
- Directory tree under `researches/{id}/`
- Discord channel named after the research
- `workflows/{id}/state.json` with `currentPhase: "phase-1-reconnaissance"`
- A kickoff `inbox/` message addressed to the Theorist

### Phase 1 — Reconnaissance (~3 AI hours, parallel)

**Theorist (primary, ~3 hours)**
- Search for the **10 most relevant papers** to this research
- Read each carefully — extract: key claim, key method, key result, relevance
- Output: `workflows/{id}/literature/papers.json` with 10 entries
- Output: `workflows/{id}/background.md` — 200–400 words on domain, open
  questions, and common pitfalls, written from first principles

**Engineer (parallel, ~1 hour)**
- Scan workspace for related code, data, and available compute resources
- Output: `workflows/{id}/resources.md`

### Phase 2 — Synthesis (~1 AI hour, Theorist solo)

**Theorist**
- Read all 10 paper notes + background
- Identify **3 to 5 concrete breakthrough opportunities** for this research.
  Each must include: title (1 line), why interesting (2 sentences),
  why now (what makes it tractable today), difficulty estimate, risk factors
- Output: `workflows/{id}/opportunities.md`
- Switch to critic hat, produce `workflows/{id}/opportunities-critique.md`

**Assistant**
- As soon as `opportunities.md` exists, format it into a Discord post and
  publish it to the research channel with a prompt asking the user which
  direction excites them most

**→ This is the first proactive output to the user, delivered ~1.5 wall-clock
hours after Start Research.**

### Phase 3 — Researcher Intake (≤12 hours, blocks on user)

**Assistant** hosts a structured Q&A in the Discord channel:
1. Which opportunity (1–5) excites you most, or do you want a different angle?
2. What is the desired output of this research?
   - (a) Journal paper
   - (b) Thesis chapter
   - (c) Institute/lab deliverable
   - (d) Personal exploration
   - (e) Other
3. If paper: target venue?
4. Hard deadline (date or "none")?
5. Any constraints on compute, tools, ethics, IP?

**Assistant** writes answers to `workflows/{id}/intake.json` as they come in.

**Timeout**: If the user does not answer within **12 hours**, Theorist picks
the highest-confidence opportunity and proceeds with these defaults:
- output: `personal exploration`
- deadline: none
- constraints: none
The user can still edit the plan at any time afterwards.

### Phase 4 — Plan Construction (~3 AI hours)

**Theorist (draft, ~2 hours)**
- Create a task DAG in `workflows/{id}/plan.json`
- Each task: id, title, owner (theorist/engineer/assistant), phase, description,
  estimateAiHours, dependsOn, deliverable, successCriteria
- Target: <50 total AI hours for most researches. If more, flag scope issues.

**Engineer (feasibility review, ~30 min)**
- Read the plan, flag tasks that cannot be completed in their estimate,
  propose splits. Write `workflows/{id}/plan-feasibility.md`.

**Theorist (red team, ~30 min)**
- Re-read the plan with critic hat, produce `workflows/{id}/plan-critique.md`
- Revise plan.json if needed
- Also produce `plan.md` (human-readable markdown summary)

**Assistant** posts the final `plan.md` to Discord.

### Phase 5 — Schedule (~0.5 AI hours)

**Theorist**
- Generate the first 7 nights of work into `workflows/{id}/schedule.json`
- Each night is a list of `{agent, taskId, kickoffMessage}` tuples
- Dependencies must be respected
- Night window: local 00:00–06:00 → prioritize compute-heavy tasks here;
  light tasks (standup, format, intake) run any time

### Phase 6 — Active Loop (continuous)

- Scheduler dispatches tonight's tasks at 00:00 local time
- Each task delivery is independently recomputed by Engineer when numerical
- Each morning at 08:00, Assistant writes a Daily Standup to Discord:
  - What we did last night
  - What we found
  - What we will do tonight
  - Blockers / human input needed
- Loop continues until status transitions to `confirmed`, `refuted`, or is
  manually marked `completed` / `stopped` by the user.

---

## Stop conditions

A research reaches a terminal state when **any** of the following happens:
1. Theorist confirms the hypothesis with reviewer-grade evidence → `confirmed`
2. Engineer's independent recompute contradicts the hypothesis → `refuted`
3. User clicks "Mark Complete" in the Workflow tab → `completed`
4. User clicks "Stop" → `stopped` (no further dispatches; data preserved)

---

## Editing the plan mid-flight

The user can edit `plan.json` and `schedule.json` at any time through the
Workflow tab in the research detail page. On the next scheduler tick, Theorist
reads the new files and adjusts task dispatch accordingly. Edits are
non-destructive — the previous version is kept under `workflows/{id}/history/`.
