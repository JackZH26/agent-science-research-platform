# ASRP Architecture

## Overview

ASRP is designed as a multi-agent scientific research framework with built-in quality controls. This document describes the system architecture, deployment options, and communication patterns.

## Agent Roles

| Role | Responsibility | Access Level | Model Tier |
|------|---------------|-------------|------------|
| **Theorist** | Hypothesis generation, reasoning, paper writing | Read/write workspace | Opus (deep reasoning) |
| **Engineer** | Code, computation, data pipelines | Read/write workspace + code execution | Sonnet (speed/quality) |
| **Reviewer** | Independent peer review, cross-validation | **Read-only** workspace | Opus (critical analysis) |
| **Librarian** | Literature search, reference management | Read workspace + web access | Flash (speed + search) |
| **ITDoctor** | System monitoring, backups, agent lifecycle | System-level, no research data access | Flash (lightweight) |

### Key Design Principle: Reviewer Isolation

The Reviewer agent has **read-only access** to the workspace. It cannot modify experimental data or influence ongoing experiments. This ensures independent evaluation — the same principle as double-blind peer review.

## Deployment Options

### Option A: Single Environment (Development / Solo Researcher)

```
┌─────────────────────────────────────┐
│           Host Machine              │
│  ┌──────────┐ ┌──────────┐        │
│  │ Theorist │ │ Engineer │        │
│  └──────────┘ └──────────┘        │
│  ┌──────────┐ ┌──────────┐        │
│  │ Reviewer │ │Librarian │        │
│  └──────────┘ └──────────┘        │
│  ┌──────────┐                      │
│  │ITDoctor  │ ← watchdog process   │
│  └──────────┘                      │
│       ↕ shared filesystem          │
│  /asrp/workspace/                  │
└─────────────────────────────────────┘
```

- All agents run as separate processes on one machine
- File-based communication via shared workspace
- ITDoctor runs as a systemd service or cron job
- **Best for:** Individual researchers, development, testing

### Option B: Docker Multi-Container (Production / Team)

```
┌────────────────────────────────────────────┐
│              Docker Compose                 │
│  ┌────────────┐  ┌────────────┐           │
│  │ theorist   │  │ engineer   │           │
│  │ container  │  │ container  │           │
│  └─────┬──────┘  └─────┬──────┘           │
│        │               │                   │
│  ┌─────┴───────────────┴──────┐           │
│  │    Shared Volume           │           │
│  │    /asrp/workspace/        │           │
│  └─────┬───────────────┬──────┘           │
│        │               │                   │
│  ┌─────┴──────┐  ┌─────┴──────┐           │
│  │ reviewer   │  │ librarian  │           │
│  │ container  │  │ container  │           │
│  │ (read-only)│  │            │           │
│  └────────────┘  └────────────┘           │
└──────────────────────┬─────────────────────┘
                       │
┌──────────────────────┴─────────────────────┐
│  ITDoctor (host-level, monitors containers) │
│  - docker healthcheck integration           │
│  - restart policy: unless-stopped           │
│  - volume backup cron                       │
└────────────────────────────────────────────┘
```

- Each agent in its own container
- Shared Docker volume for workspace
- Redis/NATS for real-time messaging (optional)
- ITDoctor runs on the host, monitors all containers
- **Best for:** Teams, production deployments, multi-project

### Option C: Hybrid (Recommended)

- Core agents (Theorist + Engineer) share a container
- Reviewer in a separate container (isolation guarantee)
- ITDoctor on the host
- Scales up by adding containers

## Communication Patterns

### File-Based (Default)

```
Agent A writes → /workspace/messages/to-reviewer-001.json
Agent B polls  → /workspace/messages/to-reviewer-*.json
```

Simple, debuggable, works everywhere. Recommended for solo use.

### Message Queue (Scaling)

```
Agent A publishes → Redis channel "asrp:theorist:results"
Agent B subscribes → Redis channel "asrp:theorist:results"
```

Real-time, decoupled. Recommended for team/Docker deployments.

## Research Orchestration

### Serial Pipeline (within a research line)

```
Hypothesis → Design → Implement → Execute → Validate → Analyze → Write
```

Each step depends on the previous. Managed by a pipeline controller.

### Parallel Execution (across research lines)

```
Line A (Superconductivity): ═══════════════►
Line B (Riemann Hypothesis): ═══════════════►
Line C (Fine Structure):     ═══════════════►
```

Independent research lines run in parallel. Join points at:
- Cross-validation (results compared across agents)
- Paper writing (may reference multiple lines)

### Fork-Join (cross-validation)

```
               ┌─ Agent 1 runs experiment ─┐
Hypothesis ────┤                           ├── Compare → Accept/Reject
               └─ Agent 2 runs experiment ─┘
```

## Security

- **No hardcoded keys/tokens** — all credentials via environment variables or encrypted config
- `config.example.yaml` provided as template; actual `config.yaml` in `.gitignore`
- `asrp init` wizard guides credential setup
- Reviewer agent has no write access to prevent contamination
- Audit logs are append-only (ITDoctor enforces)

## Data Layout

```
/asrp/workspace/
├── config.yaml          # User config (gitignored)
├── .env                 # API keys (gitignored)
├── data/                # Experimental data (versioned)
├── registry/            # Pre-registered experiments
├── papers/              # Paper drafts
├── audit/               # Decision audit logs (append-only)
├── messages/            # Inter-agent communication
├── backups/             # ITDoctor managed backups
└── logs/                # Agent logs
```
