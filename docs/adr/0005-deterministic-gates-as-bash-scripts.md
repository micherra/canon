---
adr: "0005"
title: "Deterministic verification gates are bash scripts invoked by the verify contract, not MCP tools"
status: accepted
date: "2026-06-11"
build: "deterministic-verification-hardening-batch-a-1-dead-wire-reachability"
---

# ADR-0005: Deterministic verification gates are bash scripts invoked by the verify contract, not MCP tools

## Context

Canon's dead-wire defect class (code that compiles and passes unit tests but is never called/registered) has recurred 6+ times in build history (sync_routines, JUDGE, contains-edge, MP-1/MP-7). Several mechanical orchestrator checks — the summary-vs-diff contradiction check and the post-scribe scope guard — are specified as step-by-step PROSE the orchestrator (an LLM) performs by reading-and-judging, and are marked advisory/skippable. The lesson (O'Reilly synthesis, Batch A): an LLM performing a mechanical check by reading-and-judging is itself the unreliability source.

This build converts three such checks into deterministic mechanisms. The cross-cutting decision is WHERE they live: new MCP tools, or shell scripts wired into the verify pipeline. Canon's architecture is MCP-heavy (every orchestration capability is an MCP tool), so MCP tools are the architecturally-expected choice — which is exactly why the chosen alternative is surprising-without-context.

## Options Considered

### Option A: New MCP tools returning structured ToolResult

**Pros:**
- Structured, typed returns; observable via the execution store.
- Fits Canon's MCP-heavy architecture and is reusable across orchestrator call sites.

**Cons:**
- The orchestrator (an LLM) still *chooses* whether to call them — a tool the LLM forgets to call fails OPEN, reproducing the exact skippable-prose failure the build is closing.
- Cannot be invoked from `hooks/lint.sh` (the deterministic verify chokepoint) without a node round-trip; does not run inside the verify shell pipeline.
- Heavier per check: register-*.ts + zod schema + handler + integration test.

**Canon-principle alignment:** tensions `fail-closed-by-default` (uncalled tool = fail-open).

### Option B: Bash scripts in `hooks/`, invoked by the verify-step contract

**Pros:**
- Run inside the deterministic verify pipeline as an explicit shell step → execute every autonomy tier, cannot be silently skipped.
- `hooks/` placement gives free shellcheck (lint.sh scans `hooks/`), the `.test.sh` convention, and `test-helpers.sh`.
- Shell-native fail-closed contract (non-zero exit blocks), identical to `pre-commit-check.sh` / `destructive-guard.sh`.
- Reuses the existing wiring-enrichment grep logic verbatim (real call/registration site vs doc mention).

**Cons:**
- stdout text is less structured than a typed ToolResult; the orchestrator parses exit code + text, not JSON.
- Bash is harder to unit-test than TS (mitigated by the established `.test.sh` convention).

**Canon-principle alignment:** honors `fail-closed-by-default`, `consistent-abstraction-levels` (joins the existing deterministic guard family), `deep-modules`.

## Decision

Chosen: **Option B — bash scripts in `hooks/`, invoked by the verify contract.**

The defect being closed is "an LLM performing a mechanical check is the unreliability source." An MCP tool the orchestrator must remember to call reproduces that failure (fail-open by omission). Only a shell step wired into the verify pipeline executes unconditionally across every tier — the requirement AC #6 makes explicit. The three gate scripts (`dead-wire-gate.sh`, `summary-diff-check.sh`, `scribe-scope-guard.sh`) live in `hooks/` for free shellcheck + test conventions, and are invoked at named orchestration points (verify, post-implement, post-scribe), NOT registered in `hooks.json` as tool-matched hooks.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| fail-closed-by-default | honors | Non-zero exit blocks; a gate error blocks rather than silently passing. An MCP tool would fail open when the orchestrator omits the call. |
| consistent-abstraction-levels | honors | Gates join the existing deterministic shell-guard family (`destructive-guard.sh`, `pre-commit-check.sh`) at the same abstraction level. |
| deep-modules | honors | One script = one gate with a narrow exit-code interface hiding the grep mechanics. |

## Consequences

**Positive:**
- The dead-wire gate, summary-vs-diff check, and scribe scope guard run identically every time and cannot be skipped by any autonomy tier.
- New scripts inherit shellcheck, `.test.sh`, and `test-helpers.sh` for free.
- The build can dogfood its own dead-wire gate (the scripts must themselves pass).

**Negative / trade-offs:**
- Discrepancy data is stdout text + exit code, not structured JSON — a future structured consumer would need a thin MCP wrapper that shells out to the script.
- Bash gate logic is less ergonomic to extend than TypeScript.

## Revisit-If

- A downstream consumer (dashboard, analytics) needs the discrepancy data as structured JSON — add a thin MCP wrapper over the script, keeping the script as the source of truth.
- A future execution context (e.g. the HTTP daemon transport) makes shell-step invocation impossible.
