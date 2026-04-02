# Quick Start

## Prerequisites
- An LLM agent platform (OpenClaw recommended)
- At least 2 agent instances (for cross-validation)
- A computational domain with known ground truth (for benchmarking)

## Getting Started

1. Clone this repository
2. Read `docs/methodology.md` for the scientific workflow
3. Choose a benchmark from `benchmarks/` or create your own
4. Configure your agents using templates from `agents/`
5. Run your first registered experiment

## Your First Experiment

```bash
# 1. Register your hypothesis
cp core/registry/template.json my_experiment.json
# Edit: fill in hypothesis, method, expected results, success criteria

# 2. Run the experiment
# (using your agent platform)

# 3. Cross-validate
# Have a different agent reproduce the key result

# 4. Log the outcome
# Record: hypothesis confirmed/refuted, errors found, lessons learned
```
