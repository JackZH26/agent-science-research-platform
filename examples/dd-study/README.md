# Case Study: Derivative Discontinuity in Multi-Well Potentials

## Timeline

| Time | Event |
|------|-------|
| T+0h | Literature review of DFT benchmarks; iDEA code installed and benchmarked |
| T+1h | Atom experiment: exact vs LDA vs HF comparison + KS potential inversion |
| T+2h | Hypothesis: "Prime-spaced wells produce anomalous negative DD" |
| T+3h | V1 experiment: 4-well system, 4 lattice types. Result: DD < 0 for prime lattice |
| T+4h | V1 paper drafted (PRL format) |
| T+4.5h | **Peer review (Reviewer agent)**: identified fatal flaw — lattice spans not equal |
| T+5h | Control experiment confirms: negative DD from spacing asymmetry, not primes |
| T+5.5h | Hypothesis corrected: "Spacing asymmetry → negative DD" |
| T+6h | V2 experiment: 3-well system, systematic d-scan. W-shaped DD curve discovered |
| T+8h | V2 paper drafted with corrected claims |
| T+9h | **Second review**: identified KS gap definition error (LDA vs exact) |
| T+10h | Exact KS gap computation: d=1.0 DD flips from -0.041 to +0.084 |
| T+11h | **Conclusion**: "negative DD" was an artifact of approximate KS gap |

## Key Lessons

1. **Independent review caught a design flaw** that would have invalidated the paper
2. **Exact vs approximate definitions matter** — a seemingly small methodological choice flipped the sign of the core result
3. **Self-correction speed**: errors discovered and corrected within hours, not months
4. **Honesty over speed**: two hypotheses abandoned when data contradicted them

## Error Taxonomy

| Error | Type | Detection Method | Latency |
|-------|------|-----------------|---------|
| Unequal lattice spans | Design | Reviewer agent peer review | 4.5 hours |
| "Prime" attribution | Logical | Control experiment | 5 hours |
| LDA KS gap vs exact KS gap | Conceptual | Literature cross-check | 9 hours |

## Files

- `exp001_atom_dissociation.py` — Atom experiment (exact vs LDA vs HF + KS inversion)
- `exp001_results.json` — Atom experiment results
- `EXPERIMENT_REGISTRY.json` — Pre-registration records

## Reproducing

```bash
pip install iDEA-latest
python exp001_atom_dissociation.py
```

Requires: Python 3.8+, numpy, scipy, matplotlib
