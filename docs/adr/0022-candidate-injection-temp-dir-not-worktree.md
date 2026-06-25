---
adr: "0019"
title: "Candidate injection for the fitness gate uses a throwaway temp-dir copy, not a git worktree"
status: accepted
date: "2026-06-24"
build: "phase-1-deliverables-23-trace-driven-evolution-the-fitness-hard-gate-2"
---

# ADR-0019: Candidate injection for the fitness gate uses a throwaway temp-dir copy, not a git worktree

## Context

The `evaluate_candidate` MCP tool (trace-driven-evolution Phase-1 fitness gate, brief §3.2/§7) must instantiate a candidate artifact (a mutated rule/principle/eval artifact) in isolation, run `skills/canon/evals/run-evals.sh` against it, and compare to baseline — without ever mutating the build worktree, `main`, or the real `skills/canon/evals/` artifacts. The PRD/brief describe this as running "inside the `evolve/<target>` worktree," leaving the concrete mechanism for the architect.

This is the durable injection contract: every future evolve-loop call (and the later candidate-generation deliverable) will instantiate candidates through whatever this build chooses. Getting it wrong is hard to reverse — the contract is consumed by code not yet written.

Probe evidence (PROBE-FINDINGS P1, P5): `run-evals.sh` reads its eval-set and fixtures relative to its own `SCRIPT_DIR`; the entire `skills/canon/evals/` surface is 36K and copies in ~8ms; a `git worktree add` instead materializes the whole repo and mutates shared `.git/worktrees` state.

## Options Considered

### Option A: `git worktree add evolve/<target>` per call

**Pros:**
- Full repo fidelity; candidate sees the whole tree.

**Cons:**
- Materializes the entire repo (orders of magnitude larger than the 36K eval surface).
- Mutates shared `.git/worktrees` global git state and creates a branch per call; concurrent calls race on git state; teardown is destructive git ops.
- Overkill for an offline gate that only needs the eval surface plus one swapped file.

**Canon-principle alignment:** tensions simplicity and isolation (touches shared git state).

### Option B: Throwaway temp-dir copy

`mkdtemp` under `os.tmpdir()` → copy the eval surface → write `candidate_text` to the resolved `target_path` inside the copy → run baseline and candidate passes → `rm -rf` in a `finally`.

**Pros:**
- Because the script is `SCRIPT_DIR`-relative, a copy of `skills/canon/evals/` with the candidate swapped at `target_path` is fully self-contained and isolated.
- ~8ms copy (measured); zero shared git state; fresh dir per call (no concurrency race); created outside the repo so it can never be committed.
- Crash-safety is structural: a fresh dir each call plus `rm -rf` on completion and on error.

**Cons:**
- Targets whose eval-effect requires a full project checkout are not coverable by an eval-surface-only copy; Phase-1 scope keeps targets to eval-scoreable artifacts, so this does not bite now.

**Canon-principle alignment:** honors simplicity, isolation, and define-errors-out-of-existence (no cross-call contamination).

### Option C: Overlay / in-place swap-and-restore

**Pros:** No copy.

**Cons:** Mutates the real artifacts in place and restores after; a crash mid-run corrupts the real tree — a direct violation of the non-mutation invariant.

**Canon-principle alignment:** hard violation of the isolation invariant.

## Decision

Chosen: **Option B — throwaway temp-dir copy.**

The eval surface is tiny and the harness is `SCRIPT_DIR`-relative, so a temp-dir copy delivers full isolation at roughly three orders of magnitude lower cost than a worktree and touches zero shared git state. The "isolated `evolve/<target>` worktree" language in the brief expresses the *intent* (isolation), not a mandate for the git-worktree *mechanism*; Option B satisfies the intent more cheaply and more safely. Option C is disqualified by the non-mutation invariant.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| isolation (§7 / PRD non-negotiable) | honors | No shared git state; real evals never mutated; fresh dir per call |
| simplicity-first | honors | `mkdtemp` + `cp -R` + `rm -rf` vs git-worktree lifecycle |
| define-errors-out-of-existence | honors | Per-call fresh dir makes cross-call contamination structurally impossible |
| ADR-002 (subprocess isolation) | honors | The copy run shells out via `process-adapter.runShell`, never `node:child_process` |

## Consequences

- A candidate-injection service does `mkdtemp` → `cp -R` eval surface → write candidate at `target_path` → return temp paths → caller runs via `runShell` → `rm -rf` in `finally`.
- Baseline is scored from the unmodified copied surface (or a cached `baseline.json`); candidate from the surface with the file swapped.
- The temp dir lives under `os.tmpdir()`, never inside the repo.
- **Revisit** if a future phase must evolve targets whose eval-effect needs a full project checkout (e.g. agent-definition bodies scored via a live orchestrator run) — then a copied project subset, or only then a worktree, may be warranted. Phase-1 eval-scoreable targets do not require it.
