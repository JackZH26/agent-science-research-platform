# ASRP — Agent Science Research Platform

**English** | [中文](README.zh-CN.md) | [Deutsch](README.de.md)


> Encode scientific methodology into AI agent workflows.

**ASRP** is an open-source framework for AI-agent collaborative scientific research. It provides tools, protocols, and benchmarks to make human-agent research collaborations **reproducible, auditable, and self-correcting**.

## Why ASRP?

In March 2026, a single researcher with a bachelor's degree and two AI agents produced 20 theoretical physics papers in 16 days. Some were rejected. Some are under review. One critical experiment was self-corrected mid-process when agents discovered they had used an incorrect definition.

**Speed without rigor is noise. ASRP adds the rigor.**

## Core Principles

1. **Experiment Registration** — Pre-register hypotheses before running experiments. No post-hoc storytelling.
2. **Independent Cross-Validation** — Different agents (or the same agent with different parameters) must reproduce results before they enter a paper.
3. **Audit Trails** — Every decision, every data point, every error correction is logged.
4. **Token Budget Management** — Right model for the right task. Opus for reasoning, Sonnet for code, Flash for search.
5. **Separation of Discovery and Verification** — The agent that proposes a hypothesis is not the one that validates it.

## Project Structure

```
asrp/
├── core/                  # Core framework
│   ├── registry/          # Experiment pre-registration system
│   ├── validator/         # Independent cross-validation protocols
│   ├── audit/             # Decision audit trails
│   └── budget/            # Token & compute budget management
├── agents/                # Agent role templates
│   ├── theorist.md        # Hypothesis generation + reasoning
│   ├── engineer.md        # Code + computation
│   ├── reviewer.md        # Independent peer review
│   └── librarian.md       # Literature search + management
├── benchmarks/            # Standard test suites
│   ├── dft-idea/          # DFT benchmarks using iDEA code
│   └── template/          # Template for adding new domains
├── examples/              # Complete case studies
│   ├── dd-study/          # Derivative discontinuity study (with error→correction)
│   └── portfolio/         # 20-paper portfolio analysis
└── docs/                  # Documentation
    ├── quickstart.md
    ├── methodology.md     # Scientific methodology guide

```

## Relationship to OpenClaw

ASRP is not a general-purpose agent platform — it's a **science-specific skill layer** that can run on top of [OpenClaw](https://github.com/openclaw/openclaw) or any LLM agent framework. Think of it as:

| | OpenClaw | ASRP |
|---|---|---|
| **Scope** | General-purpose AI agent | Science research workflows |
| **Users** | Developers, power users | Researchers, students, labs |
| **Key Feature** | Tool orchestration | Scientific method enforcement |

## Status

🚧 **Early Development** — Framework design phase. Contributions welcome.

## Case Study: 20 Papers in 16 Days

See [`examples/portfolio/`](examples/portfolio/) for the complete analysis of our founding case study: a non-physicist researcher + 2 AI agents producing 20 theoretical physics papers across 5 subdisciplines, including:
- Fine-structure constant (10 papers)
- Riemann Hypothesis (2 papers)
- Superconductivity (3 papers)
- Membrane models (2 papers)
- Number theory & mathematical physics (3 papers)

Key metrics: 449 views, 364 downloads on figshare. 7 papers currently under peer review at journals including Physical Review D, SUST, Foundations of Physics, IJNT, and Experimental Mathematics.

## License

Apache 2.0

## Author

JZIS — JZ Institute of Science
