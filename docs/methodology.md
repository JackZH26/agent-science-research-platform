# ASRP Scientific Methodology

## The Research Cycle

```
Pre-register → Execute → Cross-validate → Analyze → Report → Archive
     ↑                                                          |
     └──────────────── Iterate ────────────────────────────────┘
```

## Pre-registration
Before running any experiment:
1. State the hypothesis clearly
2. Define the method (code, parameters, models)
3. Define success/failure criteria
4. Estimate required resources (compute, tokens)

## Cross-validation
Every significant result must be independently verified:
- Different agent instance
- Different initial conditions or parameters
- Same expected outcome

## Error Taxonomy
Common AI agent errors in scientific research:
- **Conceptual:** Using wrong definitions (e.g., approximate vs exact KS gap)
- **Numerical:** Insufficient convergence, wrong grid size
- **Logical:** Over-claiming from limited data
- **Design:** Uncontrolled variables in experiments
- **Citation:** Attributing results to wrong sources

## Quality Checkpoints
- [ ] Hypothesis pre-registered?
- [ ] Code deterministic (fixed seeds)?
- [ ] Results saved to files?
- [ ] Cross-validated by independent agent?
- [ ] Convergence tested?
- [ ] Literature checked for prior art?
- [ ] Error bars / uncertainty quantified?
