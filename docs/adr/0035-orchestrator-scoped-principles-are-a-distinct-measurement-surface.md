---
adr: "0035"
title: "Orchestrator-scoped principles are a distinct measurement surface, not code-review-citable"
status: accepted
date: "2026-07-02"
build: "fix-driftdb-test-fixture-leak-isolate-test-flow-writes-to-temp-db-purge"
---

# ADR-0035: Orchestrator-scoped principles are a distinct measurement surface

## Context

A full-history learner run (2026-07-02) found that 23 of 46 never-cited principles are
orchestrator-/architect-scoped (e.g. `agent-design-before-code`, `agent-plans-are-prompts`,
`agent-document-decisions`) and carry zero `honored` citations across 94 reviews. The learner
correctly classified this as a reviewer **measurement** gap, not principle deadness.

Mechanism (file/function evidence): the code-review flow surfaces principles scope-filtered to the
diff — `review-code.ts:211-214` calls `matchPrinciples(allPrinciples, { file_path })`
(`matcher.ts:134`). `matchesFilePattern` (`matcher.ts:55-58`) admits a principle only when a diff
file glob-matches one of its `scope.file_patterns`. Orchestrator-scoped principles are
file-pattern-scoped to non-code, gitignored paths (`.canon/plans/*/DESIGN.md`,
`.canon/plans/**/*-PLAN.md`) — a code diff never matches them, and those paths never appear in a
PR diff. Universal-scope agent rules (`layers:[]`, no file_patterns) ARE surfaced against code but
are semantically about architect/orchestrator behavior, so reviewers never mark them honored. The
`honored[]` set (chosen by the reviewer from the surfaced principles, persisted by `store_pr_review`,
counted by `get-compliance.ts:49`) therefore never contains them.

The matcher is behaving correctly. The gap is that the only measurement surface Canon runs is code
review over the worktree diff; there is no review pass over the orchestration trace/artifacts these
principles govern.

## Options Considered

### Option A: Make orchestrator-scoped principles citable within code review

**Pros:**
- Closes the zero-citation gap directly.

**Cons:**
- Requires reviewing gitignored `.canon/plans/**` artifacts (never in the PR diff) or emitting false-honored citations for principles inapplicable to the code diff — corrupting compliance data.

**Canon-principle alignment:** tensions `simplicity-first`, the `matcher.ts` scope contract, and compliance-signal integrity.

### Option B: A dedicated orchestration-trace self-review surface

**Pros:**
- Semantically correct home — evaluates a completed flow's orchestration trace/artifacts against orchestrator-scoped principles and records honored/violated citations.

**Cons:**
- Net-new machinery (new review pass + new citation write path), out of proportion to this build.

**Canon-principle alignment:** honors correct measurement; tensions `simplicity-first` at this scope.

### Option C: Documented decision + filed follow-up; no code change

**Pros:**
- Prevents a future contributor from mis-reading zero-citation as deadness and retiring live governance; zero risk to compliance data; records Option B as the correct future path.

**Cons:**
- The 23 principles remain uncited until Option B is built.

**Canon-principle alignment:** honors `simplicity-first`, `agent-document-decisions`.

## Decision

Chosen: **Option C — documented decision + filed follow-up**, with **Option B** recorded as the
correct long-term path (`docs/explore/orchestrator-scoped-principle-measurement-gap.md`).

The zero-citation signal for orchestrator-scoped principles is a by-design consequence of code
review's scope filter — not a matcher bug and not deadness. We make the "why" durable so nobody
retires live governance, and we file the orchestration-trace self-review surface as the future fix.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| simplicity-first | honors | No matcher/reviewer change; zero net-new machinery this build. |
| agent-document-decisions | honors | Hard-to-reverse-adjacent + surprising + genuine trade-off → durable ADR, not just ephemeral. |
| (compliance-signal integrity) | honors | Avoids false-honored citations that Option A would inject. |
| measure-what-matters (learner trust) | tensions (accepted) | 23 principles stay uncited until Option B; the ADR makes the tension legible. |

## Consequences

**Positive:**
- Future readers understand zero-citation ≠ dead for these principles; retirement is pre-empted.
- Compliance data stays clean (no forced citations).

**Negative / trade-offs:**
- Orchestrator-scoped principles have no compliance/drift signal until the Option B surface exists.

## Revisit-If

- A learner run or contributor needs compliance/drift signal for orchestrator-scoped principles → scope Option B (orchestration-trace self-review) into a dedicated build.
- The matcher's scope semantics change such that orchestration artifacts enter the review diff.
