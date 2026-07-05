# Canon — Domain Glossary

This file defines Canon's ubiquitous language: what terms **mean** in this system. It is not a how-to guide — for usage patterns and style conventions, see `.canon/CONVENTIONS.md`. For project guidelines and behavioral rules, see `CLAUDE.md`. When a term appears throughout agent definitions, principles, or orchestration code, this file is the authoritative definition.

---

## ADR (Architecture Decision Record)

A durable record of a consequential architecture decision that passes the 3-condition gate: (1) the decision is irreversible or hard to reverse, (2) it involves a significant design tradeoff, and (3) it is likely to be re-litigated without a written record. Written by the architect to `docs/adr/NNNN-slug.md` (sequential numeric ID enforced by the ADR sequential-ID gate). ADRs are committed to the build branch so they ship alongside the code they document. 28 ADRs tracked as of the 231-commit drift window.

## Blast Radius

The transitive set of files affected by changing a given file, measured by the knowledge graph (`graph_query({ query_type: "blast_radius" })`). Used for risk assessment during review partitioning — files with a large blast radius warrant smaller reviewer groups and more careful analysis.

## Board

The file `board.json` in the workspace root. Tracks flow state, current step, autonomy tier, and build metadata. The orchestrator's primary state management file — seeded by `init_workspace` and finalized by `finalize_workspace`; step progression is journaled via `log_step` / `batch_log_steps`, not written by agents directly.

## Context Sync

The mandatory post-implementation step where the scribe agent updates `CLAUDE.md`, `context.md`, `CONVENTIONS.md`, and `CONTEXT.md` to reflect contract-level changes introduced by the build. Internal refactors, test-only changes, and variable renames do not trigger a context sync. `CONTEXT.md` is updated only when a build explicitly introduces, renames, or removes a domain concept. Managed by the scribe agent via the `agent-context-sync` rule.

## Convention

A project-level pattern recorded in `.canon/CONVENTIONS.md`. Less formal than a principle — it captures established style preferences and idioms observed across the codebase. Conventions are introduced by the learner agent based on observed patterns, never by the scribe based on individual changes.

## DAG (Task DAG)

A directed acyclic graph of task dependencies, stored in `task-dag.yaml` under the workspace plans directory. Each node names a task, its dependent tasks (`depends_on`), and its target files. The DAG enables parallel dispatch: tasks with no unresolved dependencies are dispatched as wave 1; subsequent waves run after their dependencies complete.

## Doc Corpus

The set of markdown knowledge sources indexed by the parallel doc-vector index: `principles/**`, `references/**`, `.canon/principles/**`, `.canon/proposed-learnings/**`, and out-of-repo build digests (from the Claude Code memory dir). Distinct from the structural code KG (which scans TypeScript import/export graphs). Each source is stamped with a `trust_tier` at ingest time (v1: all `internal`). Freshness is keyed by a content-hash over all corpus file stats (`doc_corpus_hash` in the `meta` table, per ADR-0029) — not git-HEAD — because build digests and `.canon/` paths mutate without commits. Queried via `search_knowledge`.

## Decisions Corpus

The offline, cross-workspace aggregate of orchestrator decisions — a superset spanning every workspace's own Decisions Ledger, not just the current one. Built by unioning two partitions with no dedup needed: live workspaces still on disk (walked via glob over `.canon/workspaces/**/orchestration.db`) and reaped workspaces already durably persisted into the project-level `drift.db` `orchestrator_decisions` table (v14 migration). A workspace is always either live-on-disk or reaped-and-persisted, never both, so the union is dedup-free by construction. Read via `get_decisions_corpus`, which tags each record `source: "live" | "durable"`, aggregates by effective category (`gate ?? decision_type` — so `plan_approval`/`review_verdict` surface as first-class buckets instead of collapsing into an undifferentiated `hitl_gate`), and reports per-field fill-rates; unreadable stores land in `skipped[]` rather than being silently dropped. Pure query, offline + deterministic. Introduced by ADR-0040.

## Decisions Ledger

The durable record of consequential orchestrator decisions (HITL gate outcomes, scope cuts, AC changes, tier overrides, merge-conflict resolutions) stored as `orchestrator_decision` events on the execution-store event log. Written via `log_decision` (authoritative — store failure surfaces as error, not silently swallowed) and read via `get_decisions` (returns structured `DecisionRecord[]` + rendered markdown table). Used during in-session compaction rehydration and explicit resume to restore decided state without relying on conversation memory. Built on the event log per ADR-0010 — not on `cliff-ledger.ts`, which is a `Set<string>` de-dupe ledger for a different purpose. A workspace's ledger no longer dies with it: the janitor persists it into the durable `orchestrator_decisions` drift.db table (fail-open) immediately before `rmSync` deletes `orchestration.db` at reap time (ADR-0040). See Decisions Corpus for the cross-workspace offline reader over the live and durable partitions together.

## Drift

Divergence between declared Canon principles and actual codebase patterns, tracked in the drift database (`reviews.jsonl`, `orchestration.db`). Drift accumulates when builds introduce violations that are acknowledged rather than fixed. The `get_drift_report` MCP tool surfaces current drift state.

## Flow

The state machine that drives a build from intent classification through shipping. Flows are implicit in `CLAUDE.md` routing rules — the PM classifies intent and drives the appropriate sequence (implement → verify → review → context-sync → ship → learn). There is no separate flow YAML; the orchestrator implements the sequence directly.

## HITL

Human-In-The-Loop checkpoint. A point in the build process where the orchestrator pauses and presents results to the user for approval, correction, or acknowledgment before proceeding. The mandatory HITL gates are plan approval and the initial review verdict; other gates vary by autonomy tier.

## Hub

A file with high in-degree — many other files import it. Changes to hubs have a large blast radius and require extra caution. Identified by the knowledge graph via `in_degree` and `impact_score` metrics. Hub files get smaller reviewer groups (more attention per reviewer) during team-dispatch review.

## Journal

The file `journal.json` in the workspace root. An ordered log of step executions with status, timestamps, produced artifacts, and agent IDs. The orchestrator writes to it via `log_step` before and after spawning each agent. `finalize_workspace` verifies journal completeness before closing the build.

## Loop

A Canon-managed periodic-observation artifact authored as `loops/<id>.md` (YAML frontmatter + action-prompt body). The `loops/` directory at the repo root is the loop registry — no hardcoded catalog exists. Loops are discovered via `list_loops` and dispatched by the orchestrator via `CronCreate` at a named lifecycle moment (`post-ship`, `on-long-dispatch`, `session-start`). Nothing auto-starts; authoring a `loops/*.md` registers the definition but does not start the loop (dc-06 non-declarative constraint). Phase A ships the framework spine (schema, registry, MCP tools, `_probe` demo); Phase B adds ship-watch; Phase C adds self-paced mode + session-watch; Phase D adds harness-watch + `run-learner` action; Phase E adds evolve + `run-evolve` action.

## Orchestrator Checkpoint

The file `checkpoint.md` written to the workspace root by `write_orchestrator_checkpoint`. A compact, derived resume-state snapshot containing completed and pending steps, recent decisions, and the recommended next action. Written as a best-effort-observable operation — failure surfaces as a `ToolResult` error but never throws or silently succeeds. Authoritative sources (`journal.json`, decisions ledger) always supersede `checkpoint.md`; the file is a convenience cache for fast in-session or post-compaction rehydration. Refreshed per completed step (alongside `log_step` completion) and at each HITL gate.

## Primer

A domain reasoning context file (~37 lines) loaded into an agent's context on demand. Primers teach mental models and decision frameworks for a domain (e.g., `orchestration.md`, `drift.md`) rather than imperative rules. Stored in `primers/` and referenced by name in agent frontmatter or spawn prompts.

## Principle

A codified quality standard with severity (`rule` > `strong-opinion` > `convention`), scope, and examples. Principles are stored in `principles/` and enforced during the review step. Only `rule`-severity violations are required fixes; stronger deviations require documented justification in the Canon Compliance section of implementation summaries.

## Rule (Agent-Behavior)

An imperative behavioral constraint loaded into an agent's context at spawn time. Rules govern agent execution patterns (e.g., TDD required, structured triage, artifact-write-before-return). Stored in `rules/` and listed in agent frontmatter under the `rules:` key. Distinct from Canon principles, which govern code quality.

## Routine

A Canon-managed scheduled or automated task, stored as a structured markdown file with YAML frontmatter in `routines/<name>.md`. Routines are Canon's 5th managed artifact class (after principles, loops, workspaces, and worktrees). The `routines/` directory at the repo root is the canonical registry; project-local overrides live in `.canon/routines/`. Discovered via `list_routines`, retrieved via `get_routine`, and synchronized from remote schedules via `sync_routines`. A generated index lives at `routines/.claude/CLAUDE.md`. Routines differ from loops: loops are periodic-observation pipelines fired by the orchestrator at lifecycle moments; routines are standalone automated tasks managed with a full state and schedule layer.

## Runbook

The ordered sequence of steps — design, implement, verify, review, context-sync, ship, learn — that defines a build's execution plan. Produced by the architect for non-trivial builds, inferred by the PM for trivial builds, and approved by the user via HITL before execution begins.

## Slug

The kebab-case identifier for a build (e.g., `fix-auth-middleware`, `add-dark-mode`). Derived from the task description during `init_workspace`. Used in branch names (`canon/{slug}`), workspace directory paths, commit trailers, and artifact paths.

## Tier (Autonomy Tier)

The risk classification assigned to a build that determines which HITL gates are active. Computed by `compute_autonomy_tier` based on file blast radius and historical violation rate. Values: `autonomous` (skip build-step checkpoints), `light-touch` (skip only build-step checkpoints), `supervised` (all gates active). Plan approval and initial review verdict are always mandatory regardless of tier.

## Tier (Build Tier)

The complexity classification of a build: `trivial` (single-file fix), `small` (2-5 files), `medium` (5-15 files), `large` (15+ files). Set during `init_workspace` via the `tier` parameter. Determines routing (trivial → engineer directly; non-trivial → architect first) and enrichment depth.

## Verdict

The outcome of a review step: `CLEAN` (no violations found), `WARNING` (advisory items only — build may proceed after user acknowledgment), or `BLOCKING` (must-fix violations — build cannot ship until resolved). The orchestrator gates the ship step on a non-BLOCKING verdict.

## Violation Lifecycle

The state model for entries in the `violations` table of the drift database. Each violation carries a `status` field that is either `open` (default, unresolved) or `resolved`. A violation transitions to `resolved` when a review affirmatively honors its `(file, principle)` pair — meaning the file is in the review's file set, the principle is in the honored list, and the review does not re-record the same violation. Resolution is always an UPDATE (never a DELETE), preserving audit history. The `DriftDb.appendReview()` auto-closure path and the `reconcileStaleViolations` backfill path both produce resolutions; all operational reads (`get_drift_report`, `get_compliance`, pulse hook) exclude `status='resolved'` rows.

## Wave

An execution ordering group in a task DAG. Wave 1 contains tasks with no dependencies (`depends_on: []`). Wave N contains tasks whose dependencies all completed in Wave N-1. Tasks within the same wave can run in parallel. Workers are dispatched by the orchestrator as each wave's prerequisites are satisfied.

## Workflow Script

A plain-JavaScript orchestration script for the Claude Code `Workflow` tool, stored in `workflows/<name>.js`. Workflow scripts are Canon's 6th managed artifact class (after principles, loops, workspaces, worktrees, and routines). Scripts must export a pure-literal `export const meta` object (no variables, spreads, or function calls), be valid plain JavaScript (no TypeScript syntax), and be deterministic — `Date.now()`, `Math.random()`, and argless `new Date()` are banned to preserve prefix-cached resume. The `isolation` agent-option key is also banned (Canon prohibits it in agent option objects). The lint gate (`hooks/workflows-lint.sh` → `mcp-server/scripts/workflows-lint.mjs`) enforces all constraints via node-AST analysis and fails closed when the `typescript` dep is absent. In Increment 0, scripts are invoked on-demand via `Workflow({ scriptPath: "workflows/<name>.js" })`; name-based resolution (`.claude/workflows/`) is Increment 1.

## Workspace

A per-build isolated directory under `.canon/workspaces/`. Contains `board.json`, `journal.json`, `plans/`, `reviews/`, `artifacts/`, and the `worktree/` directory. Created by `init_workspace` and finalized by `finalize_workspace` at build completion.

## Worktree

A git worktree created by `init_workspace` at `{workspace}/worktree` on a `canon/{slug}` branch. All code changes made during a build happen in this worktree — never directly on `main`. Canon owns the worktree lifecycle; changes are merged to main only when the build ships.
