---
adr: "0054"
title: "canon-waves compiler locus — args-as-data envelope + one generic runner, not generated code or a persistent engine"
status: accepted
date: "2026-07-11"
build: "scope-and-design-canon-waves-a-managedsaved-workflow-that-compiles (SYNTHESIS Inc-5, Increment 1)"
---

# ADR-0054: canon-waves compiler locus — args-as-data envelope + one generic runner

## Context

Canon's parallel multi-task build path (`references/dag-execution-protocol.md`) has been a
hand-run git checklist since PR #167/#180 removed its wave-lifecycle helpers
(`createWaveWorktrees`/`mergeWaveResults`/`cleanupWorktrees`). The Claude Code `Workflow`
tool now natively executes DAGs (`pipeline()`/`parallel()` + subagents + structured returns +
resume + budgets). SYNTHESIS (`docs/explore/workflow-integration/SYNTHESIS.md`, feature #12,
Increment 5) names `canon-waves` as the harness-native replacement, and PR #498's probe
proved the mechanism end-to-end (A3 GREEN: a workflow subagent commits into a Canon-owned
worktree via `git -C` without the tool's `isolation` key; `--no-ff` merge git-verified with 3
parents; deterministic Bash gate exit 0 at the boundary).

Three hard constraints bound the design:
- The `Workflow` script **body is sandboxed** — no filesystem, Node, or MCP access.
- SYNTHESIS settled-fact #1: **args-as-data, no generated code** — model-generated script text
  is never executed.
- PR #151/#167: **no persistent static state machine** — that engine was deliberately removed
  and must not be revived.

The decision: *where does "the compiler" live, and what shape does its output take?*

## Options Considered

### Option A: Generate an ephemeral per-build Workflow script

The orchestrator (or an agent) emits a bespoke `.js` Workflow script per build, encoding that
build's DAG directly, then runs it via `scriptPath`.

**Pros:**
- Maximum per-build flexibility; the script can hard-code the exact wave shape.

**Cons:**
- Directly violates settled-fact #1 (generated code is never executed).
- Un-lintable-once: every build's script would need auditing; loses trust-the-compiler-once.
- Invites per-flow branching to creep into the generated text.

**Canon-principle alignment:** tensions `fail-closed-by-default` (un-auditable generated text)
and the generic-compiler non-negotiable.

### Option B: Revive a persistent static flow/wave engine

Rebuild the #167-removed engine as the compilation target.

**Pros:**
- A single durable execution surface.

**Cons:**
- Explicitly reverses PR #151/#167; reintroduces the maintenance burden those PRs removed.
- Persistent state machine is the opposite of the harness-primitive direction.

**Canon-principle alignment:** violates the stated no-persistent-engine constraint.

### Option C (chosen): Pure orchestrator-side `compile_waves` emitting an args-as-data envelope, consumed by ONE static generic runner via `scriptPath`

A pure function `compileWaves` (reusing `dag-validator.ts`) groups a validated task-DAG into
dependency-ordered waves and emits a `WavesArgs` **data envelope**. ONE hand-written,
lint-passing `workflows/canon-waves.js` runner reads `args.waves` generically and fans out
engineer workers + a merge-agent node. All effects (worktree provisioning, journaling,
deterministic gates, merge-verification) live orchestrator-side at the segment boundary.

**Pros:**
- Honors all three constraints simultaneously — the only shape that does.
- "Trust-the-compiler-once": the single runner is lint-audited once; per-build variation is
  pure data (the envelope), unit-testable via the AC1 field-only-diff test.
- The sandboxed body forces effects to the edges — the probe proved this is sufficient.

**Cons:**
- Downstream tooling will depend on the `WavesArgs` envelope schema (hard-to-reverse).
- Multi-wave dependency ordering (wave N from wave N-1's merged HEAD) is not yet validated —
  deliberately scoped OUT of Increment 1.

**Canon-principle alignment:** honors `generic-compiler` (no per-flow branches),
`fail-closed-by-default` (validated envelope or `ToolResult` error), `no-dead-abstractions`
(runner wired to a real live-run in the same increment), `validate-at-trust-boundaries`.

## Decision

Chosen: **Option C — args-as-data envelope built by a pure orchestrator-side `compile_waves`,
consumed by ONE static generic `workflows/canon-waves.js` runner invoked via `scriptPath`.**

This build also **reorders** canon-waves ahead of SYNTHESIS's Inc 2-4 items
(`canon-tail`, `ingest_workflow_run`, review-verify), which were sequenced first only to
de-risk the merge-agent unknown — a risk PR #498's probe has now retired. Increment 1 is scoped
to **single-wave** execution (the exact probe-validated shape). canon-waves ships **opt-in**
alongside the retained `references/dag-execution-protocol.md` fallback; it does not replace it.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| generic-compiler (PRD non-negotiable) | honors | Envelope derived purely from DAG/plan fields; runner iterates `args.waves`; AC1 2-DAG diff is the mechanical proof of no flow-specific path. |
| fail-closed-by-default | honors | `compile_waves` returns a `ToolResult` error on DAG-validation failure; runner arity-checks `args` and per-node `rev-parse --show-toplevel` guards before any write. |
| no-dead-abstractions | honors | Runner + `compile_waves` are both consumed by a real live-run in the same increment (SYNTHESIS "no workflow without a consumer"). |
| probe-before-build-invoke-not-infer | honors | Every load-bearing Workflow claim is probe-validated; the one un-validated claim (multi-wave) is scoped out, not assumed. |

## Consequences

- **Easier**: parallel builds become a compiled, maintained primitive; resume/budget/parallel
  semantics come free from the `Workflow` tool; per-build variation is testable data.
- **Harder / new constraints**: the `WavesArgs` envelope is now a schema downstream code depends
  on — schema changes are versioned (`envelope_version`). Multi-wave dependency ordering is a
  separate increment gated on its own orchestrator-run probe (branch-from-merged-HEAD).
- **Retained**: `references/dag-execution-protocol.md` stays as the documented fallback until
  canon-waves proves out over >=3 green runs; only then is the engine-default flip considered
  (Inc-5).
