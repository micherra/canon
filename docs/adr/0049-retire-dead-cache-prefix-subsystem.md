---
adr: "0049"
title: "Retire the dead cache_prefix subsystem"
status: accepted
date: "2026-07-11"
build: "surface-per-agent-type-cache-efficiency-in-getcrossrunanalysis-read"
---

# ADR-0049: Retire the dead cache_prefix subsystem

## Context

ADR-006a introduced a `cache_prefix` subsystem: `buildCachePrefix()` assembles a shared
prompt-cache prefix (`## Flow` → CLAUDE.md → `## Workspace` → `## Conventions`), `init_workspace`
stores it via `ExecutionStore.setCachePrefix` and returns a `cache_prefix_hash`, and the value
persists in an `execution.cache_prefix` column.

A grounded read-only investigation (recorded in this build's `PROBE-FINDINGS.md`) established two
high-confidence static facts:

1. **Zero production consumers.** `getCachePrefix()` is called only from tests. The
   `cache_prefix_hash` return field is consumed by nothing — no orchestrator template, reference,
   agent, or skill reads it (repo-wide grep; the only non-`mcp-server` mention is a `.spike/`
   note).
2. **No injection seam.** The MCP server contains no Anthropic API client and no `cache_control`
   construction. Canon exposes MCP tools; the Claude Code *harness* spawns agents and owns the API
   request, `cache_control` placement, and TTL. There is nowhere a stored `cache_prefix` string
   could enter a request's cacheable bytes.

Separately, the assembled prefix ordered the dynamic `## Workspace` block *before* stable
`## Conventions` — the documented cache-poisoning anti-pattern — but since the prefix is never
read, that mis-ordering has no runtime effect. The user asked to "wire it so getCachePrefix is
actually wired," and explicitly sanctioned retire-as-fallback rather than shipping a redundant
consumer.

## Options Considered

### Option A: Wire `getCachePrefix()` to a real consumer (reorder first)

**Pros:**
- Honors the user's literal request; preserves the subsystem.

**Cons:**
- No consumer exists and none is reachable: Canon cannot set `cache_control`, so a stored prefix
  cannot influence caching. Wiring would require building a new spawn-prompt injector that prepends
  the prefix to prompt bodies — which duplicates CLAUDE.md + CONVENTIONS content already in the
  system prompt, *adding* tokens for zero cache benefit, and risks the behavioral-regression class
  from reordering a model-facing prompt.

**Canon-principle alignment:** tensions `no-dead-abstractions` (keeps a subsystem alive to justify
itself) and `simplicity-first`.

### Option B: Retire the whole subsystem

**Pros:**
- Removes a false "we do prompt caching" affordance and a dead-wire blind spot.
- Evidence-backed by an empirical reference trace (`probe-before-build-invoke-not-infer`).

**Cons:**
- Deletes work introduced by ADR-006a; re-adding prompt caching later means rebuilding
  builder + store + schema *and* a request injector.

**Canon-principle alignment:** honors `no-dead-abstractions`, `simplicity-first`,
`probe-before-build-invoke-not-infer`.

## Decision

Chosen: **Option B — Retire the whole subsystem.**

Delete `cache-prefix-builder.ts`, `ExecutionStore.getCachePrefix`/`setCachePrefix` + their prepared
statements, the `init_workspace` build/store/return (including the `cache_prefix_hash` result
field), and stop creating the `execution.cache_prefix` column.

**Schema-column retire mechanism:** execution stores are per-workspace and ephemeral (created at
`init_workspace`, reaped at `finalize`), so there is no long-lived DB to migrate. Rather than a
`DROP COLUMN` migration (SQLite-version-dependent) or a `SCHEMA_VERSION` bump, the v4 migration's
`up` is neutered to a **version-only bump** — the `ALTER TABLE … ADD COLUMN` is removed while the
migration entry stays in place. New DBs replay the full ladder (v3→v4→v5 contiguous) without ever
materializing the column.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| no-dead-abstractions | honors | Removes an entire subsystem with zero real references |
| probe-before-build-invoke-not-infer | honors | Verdict rests on an empirical repo-wide reference trace, not inference (`PROBE-FINDINGS.md`) |
| simplicity-first | honors | Deletes a builder + store API + schema column + return field for a capability Canon cannot deliver |
| no-orphan-migrations | tensions (acceptable) | Neutering a historical migration to a version-only bump is mildly surprising, but preserves ladder contiguity while removing the column from all go-forward ephemeral DBs — least-risk for a per-workspace store |

## Consequences

**Positive:**
- `get_cross_run_analysis` gains a real per-agent cache-efficiency signal (this build's Thread A)
  while Canon stops shipping a dead prefix that advertised caching it never performed.
- Dead-wire-gate no longer has a `cache_prefix` blind spot.

**Negative / trade-offs:**
- `init_workspace` no longer returns `cache_prefix_hash` (was consumed by nothing).
- Re-introducing prompt caching requires rebuilding the subsystem plus a genuine request-injection
  seam.
- One historical migration (v4) is now a no-op version bump.

## Revisit-If

- Canon gains a real request-assembly seam where it can set `cache_control` (e.g. Canon begins
  constructing Anthropic API requests directly, rather than delegating spawns to the harness) —
  then a stored, stable-ordered prefix could become a genuine consumer and prompt caching is worth
  rebuilding.
