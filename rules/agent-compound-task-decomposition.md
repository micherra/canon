---
id: agent-compound-task-decomposition
title: Decompose Compound Rebase+Fix Tasks
severity: strong-opinion
tags: [agent-behavior, orchestrator, dispatch]
---

# Decompose Compound Rebase+Fix Tasks

When an implement step involves a rebase spanning 5 or more commits, OR combines 2 or more upstream merges with code fixes in a single spawn, decompose the work into two sequential agent spawns:

1. **Spawn 1 — rebase-only**: The engineer resolves the rebase (or upstream merges) without writing any new code or applying any code fixes.
2. **Spawn 2 — fixes-only**: After Spawn 1 completes and the branch is clean, the engineer applies the code fixes identified in the task plan.

## Rationale

Compound rebase+fix tasks exhaust engineer context windows. Observed pattern: 2 of 3 spawns on a 12-commit rebase combined with 2 code fixes failed to complete both workstreams — the engineer ran out of context after resolving conflicts and did not apply the fixes.

Separating the concerns keeps each spawn focused and within context budget. It also produces cleaner commits with clear provenance (rebase commits vs. fix commits).

## Exceptions

If the rebase spans fewer than 5 commits AND involves no merge conflicts, combining the rebase with code fixes in a single spawn is acceptable. The overhead of two spawns is not warranted for trivial history cleanup.

## Application

This rule applies to the orchestrator at dispatch time, before spawning an implement step. The orchestrator evaluates the task plan's rebase requirements and splits the spawn when the threshold is met. The engineer does not need to self-split — the orchestrator is responsible for decomposition.
