---
adr: "0025"
title: "Guardrail-corpus candidate injection via full-plugin sandbox + --plugin-dir override"
status: accepted
date: "2026-06-25"
build: "build-the-mutator-candidate-generation-for-trace-driven-evolution-phase"
supersedes: "0022 (eval-surface-only limitation only; ADR-0022's temp-dir-not-worktree decision stands)"
---

# ADR-0025: Guardrail-corpus candidate injection via a full-plugin sandbox + `--plugin-dir` override

## Context

`evaluate_candidate` (the §7 fitness gate, ADR-0022) instantiates a candidate artifact in isolation,
runs `skills/canon/evals/run-evals.sh`, and compares holdout pass-counts to baseline. ADR-0022 chose a
**throwaway temp-dir copy of `skills/canon/evals/` only**, and explicitly recorded the limitation:
"Targets whose eval-effect requires a full project checkout are not coverable by an eval-surface-only
copy" with a **Revisit-If** for "agent-definition bodies scored via a live orchestrator run."

The mutator (deliverable 5) consumes `attribute_failure`, whose attributions point at the **guardrail
corpus** — `rules/`, `primers/`, `agents/`, `templates/`, `principles/`, `skills/` — NOT the eval
surface. Under the ADR-0022 mode, a rewritten guardrail artifact is never the file the eval harness
loads: `run-evals.sh` runs `claude -p` against the **installed** plugin (`canon@canon-marketplace`), so a
candidate rewrite in the temp copy has zero eval effect and can never move the holdout. This blocks the
evidence→validated-proposal loop for exactly the artifacts the program targets. The plan-approval gate
expanded scope to fix this now (this build), invoking ADR-0022's Revisit-If.

**Probe evidence (PROBE-FINDINGS P0, invoke-backed):** `claude -p --plugin-dir <dir>` loads plugin
artifacts (skills/rules/agents/principles/…) from an arbitrary directory and the model acts on them
(sentinel `SENTINEL_A7F3Q9` round-tripped). P1: `run-evals.sh` activating cases run `cd "$PROJECT_DIR"
&& claude -p` with no `--plugin-dir`. P3: the plugin markdown footprint is ~1.8MB (sub-second copy).

## Options Considered

### Option A: Full-plugin sandbox + `--plugin-dir` override (chosen)

When `target_path` is a guardrail-corpus path, copy the plugin's markdown artifact roots
(`.claude-plugin/`, `skills/`, `agents/`, `rules/`, `principles/`, `templates/`, `references/`,
`primers/`) **plus** the eval surface into a fresh temp dir, write `candidate_text` at `target_path`
inside it, and have `run-evals.sh` invoke its activating `claude -p` runs with
`--plugin-dir "$EVAL_PLUGIN_DIR" --setting-sources project` so the harness loads the **sandbox**
(rewritten) artifact instead of the installed plugin.

**Pros:** the rewritten guardrail artifact is genuinely the one loaded → its eval effect is real and the
holdout can move; reuses the existing temp-dir-copy mechanism and its `rm -rf` crash-safety; preserves
`evaluate_candidate`'s public input/output `ToolResult` shape (mode is auto-selected internally from
`target_path`); excludes `mcp-server/`/`node_modules/`/`.git/`/`.canon/` so the copy stays small and no
MCP server boots (eval cases use only Read/Grep/Glob).
**Cons:** larger copy than the 36K eval surface (~1.8MB, still sub-second); requires threading an
optional flag through `run-evals.sh` + `eval-runner.ts`; plugin-name collision with the ambient
marketplace canon must be suppressed (`--setting-sources project`).
**Canon-principle alignment:** honors isolation (fresh dir, real evals never mutated), preserves the
ADR-0022 temp-dir decision, and define-errors-out-of-existence (per-call fresh dir).

### Option B: `git worktree add` per call

**Pros:** full repo fidelity. **Cons:** materializes the whole repo, mutates shared `.git/worktrees`,
branch-per-call, concurrency races, destructive teardown — the exact cons ADR-0022 already rejected.

### Option C: Change `evaluate_candidate`'s public input to take a pre-built sandbox / injection mode

**Pros:** explicit. **Cons:** breaks the public contract the brief asks to preserve where feasible; the
mode is fully derivable from `target_path`, so a public-shape change is unnecessary.

### Option D: Leave eval-surface-only; keep guardrail targets gate-ineligible

The prior design. **Cons:** the loop never closes for the artifacts the program targets — rejected by
the scope expansion.

## Decision

Chosen: **Option A.** `evaluate_candidate` keeps its public `ToolResult` contract; internally it selects
the injection mode from `target_path` — eval-surface paths use the existing ADR-0022 copy, guardrail-
corpus paths use the full-plugin sandbox + `--plugin-dir` override. Tool-descriptions (in
`register-*.ts`, TypeScript) are **not** plugin-loaded artifacts and remain gate-ineligible — an honest
sub-gap noted for a future, different eval surface.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| isolation (§7 / PRD non-negotiable) | honors | Fresh temp dir per call; real plugin tree never mutated; `rm -rf` in `finally` |
| evolution-hard-gate | honors | The gate still decides on holdout strictly; making targets loadable does not weaken the gate |
| simplicity-first | tensions (mildly) | Adds a second injection mode + a harness flag; bounded by auto-selection from `target_path` |
| ADR-002 (subprocess isolation) | honors | The copy still runs via `process-adapter.runShell`; no `node:child_process` added |
| public-contract stability | honors | `evaluate_candidate` input/output `ToolResult` shape unchanged |

## Consequences

- `candidate-injection.ts` gains a guardrail injection mode (full-plugin sandbox + candidate written at
  `target_path`); `withInjectedCandidate` (eval-surface mode) is unchanged for eval-surface paths.
- `run-evals.sh` learns an optional `EVAL_PLUGIN_DIR` env/flag, applied ONLY to the activating
  `PROJECT_DIR`-run `claude -p` invocations (lines 158, 168), default unset = current behavior.
- `eval-runner.ts` threads the plugin-dir through `runSplit`.
- `isGateEligible` admits guardrail-corpus paths that resolve to real on-disk plugin artifacts; keeps a
  fail-closed predicate for non-existent paths, traversal, `run-evals.sh`, and tool-descriptions (.ts).
- **Revisit if** the plugin-collision suppression (`--setting-sources project`) proves insufficient, or a
  future target needs the MCP server live in the sandbox (then copy a server subset or boot a scoped
  daemon).

## Relationship to ADR-0022

ADR-0022's core decision — **temp-dir copy, not a git worktree** — STANDS and is reused. This ADR
supersedes only ADR-0022's *eval-surface-only* scope limitation, exercising its documented Revisit-If by
copying the plugin artifact tree (still a temp-dir copy, still no git worktree).
