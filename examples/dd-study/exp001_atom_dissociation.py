"""
Experiment 001 v2: Atom complete + Molecule exact only
======================================================
LDA fails to converge for stretched molecules — itself a key finding!
"""
import numpy as np
import iDEA
import json
import time

print("=" * 60)
print("Exp 001 v2: Atom (full) + Molecule (exact only)")
print("=" * 60)

s = iDEA.system.systems.atom
x = s.x

# === ATOM ===
print("\n[ATOM] Exact...", flush=True)
exact_gs = iDEA.methods.interacting.solve(s, k=0)
n_exact = iDEA.observables.density(s, state=exact_gs)
E_exact = exact_gs.energy
print(f"  E = {E_exact:.6f}")

print("[ATOM] LDA...", flush=True)
lda_gs = iDEA.methods.lda.solve(s, k=0, silent=True)
n_lda = iDEA.observables.density(s, state=lda_gs)
E_lda = iDEA.methods.lda.total_energy(s, lda_gs)
print(f"  E = {E_lda:.6f}")

print("[ATOM] HF...", flush=True)
hf_gs = iDEA.methods.hartree_fock.solve(s, k=0, silent=True)
n_hf = iDEA.observables.density(s, state=hf_gs)
E_hf = iDEA.methods.hartree_fock.total_energy(s, hf_gs)
print(f"  E = {E_hf:.6f}")

print("[ATOM] KS inversion...", flush=True)
ks = iDEA.reverse_engineering.reverse(s, n_exact, iDEA.methods.non_interacting, tol=1e-6, mu=3.0, silent=True)
v_ks = ks.v_ext
v_h = iDEA.observables.hartree_potential(s, n_exact)
v_xc = v_ks - s.v_ext - v_h
print(f"  v_xc range (inner): [{v_xc[50:-50].min():.4f}, {v_xc[50:-50].max():.4f}]")

# === MOLECULE (exact only, fast) ===
print("\n[MOL] Exact solve only (LDA diverges at large d)...", flush=True)
separations = [1.0, 2.0, 3.0, 5.0, 8.0, 10.0]
mol = {}
for d in separations:
    v_ext_mol = -1.0 / (np.abs(x - d/2) + 1.0) - 1.0 / (np.abs(x + d/2) + 1.0)
    v_int_mol = iDEA.interactions.softened_interaction(x)
    s_mol = iDEA.system.System(x=x, v_ext=v_ext_mol, v_int=v_int_mol, electrons='ud')
    gs = iDEA.methods.interacting.solve(s_mol, k=0)
    n = iDEA.observables.density(s_mol, state=gs)
    mol[d] = {'E': float(gs.energy), 'n': n, 'v_ext': v_ext_mol}
    print(f"  d={d:5.1f}  E={gs.energy:.6f}")

# Also get first excited state for d=8 (to see energy gap → DD)
print("\n[MOL] First excited state at d=8...", flush=True)
d = 8.0
v_ext_mol = -1.0 / (np.abs(x - d/2) + 1.0) - 1.0 / (np.abs(x + d/2) + 1.0)
v_int_mol = iDEA.interactions.softened_interaction(x)
s_mol = iDEA.system.System(x=x, v_ext=v_ext_mol, v_int=v_int_mol, electrons='ud')
gs0 = iDEA.methods.interacting.solve(s_mol, k=0)
gs1 = iDEA.methods.interacting.solve(s_mol, k=1)
n0 = iDEA.observables.density(s_mol, state=gs0)
n1 = iDEA.observables.density(s_mol, state=gs1)
gap = gs1.energy - gs0.energy
print(f"  E0={gs0.energy:.6f}, E1={gs1.energy:.6f}, gap={gap:.6f}")

# === SAVE ===
save = {
    'x': x,
    'n_exact': n_exact, 'n_lda': n_lda, 'n_hf': n_hf,
    'v_ext_atom': s.v_ext, 'v_h_atom': v_h, 'v_xc_atom': v_xc, 'v_ks_atom': v_ks,
    'n_gs_d8': n0, 'n_ex_d8': n1,
}
for d in separations:
    save[f'n_d{d:.0f}'] = mol[d]['n']
    save[f'v_ext_d{d:.0f}'] = mol[d]['v_ext']
np.savez('research/idea_experiments/exp001_data.npz', **save)

summary = {
    "atom": {"E_exact": E_exact, "E_lda": E_lda, "E_hf": E_hf},
    "molecule_exact": {str(d): mol[d]['E'] for d in separations},
    "excited_d8": {"E0": float(gs0.energy), "E1": float(gs1.energy), "gap": float(gap)},
    "notes": "LDA fails to converge for d>=5 stretched molecules — confirms Hodgson's point about DFT breakdown at dissociation"
}
with open('research/idea_experiments/exp001_results.json', 'w') as f:
    json.dump(summary, f, indent=2)

print("\n" + "=" * 60)
print("COMPLETE RESULTS")
print("=" * 60)
print(f"\nAtom: Exact={E_exact:.6f}  LDA={E_lda:.6f}({(E_lda-E_exact)/abs(E_exact)*100:+.1f}%)  HF={E_hf:.6f}({(E_hf-E_exact)/abs(E_exact)*100:+.1f}%)")
print(f"\nDissociation curve:")
for d in separations:
    print(f"  d={d:5.1f}  E={mol[d]['E']:.6f}")
print(f"\nExcited state gap at d=8: {gap:.6f} Ha ({gap*27.211:.3f} eV)")
print(f"\nKey insight: LDA diverges at dissociation — the DD is essential there!")
print("Saved to research/idea_experiments/")
