---
id: agent-context-budget-dispatch
title: Planner Must Estimate Input Complexity for Dispatch Decisions
severity: rule
scope:
  agents: [planner]
tags:
  - agent-behavior
  - planner
  - dispatch
---

When synthesizing a runbook, the planner must estimate both input complexity AND output scope to decide dispatch strategy (subagent vs team). When the estimated input context for a single agent exceeds the single-agent context budget, the runbook must decompose the work into a sequential setup step for shared expensive context work followed by parallel fan-out steps for independent sub-tasks.

This applies even when output scope is small — a task can be "small output, huge input."

## Signals

Any one of the following is sufficient to trigger team dispatch consideration:

- Large PR diffs requiring merge conflict resolution (20+ changed files)
- Multiple independent bugs or fixes with separate file contexts (3+ independent sub-tasks)
- Task requires reading a large codebase surface area before acting (estimated 30+ file reads)
- Combination of expensive setup (merge, scan, migration) plus independent follow-up work

## Estimation Heuristic

Use these rough estimates to total expected file reads before committing to a dispatch strategy:

| Work type | Estimated file reads |
|-----------|---------------------|
| Merge conflict resolution on N-file PR | ~N file reads |
| Each independent bug fix | ~3–5 reads (target file + tests + related imports) |
| Large codebase scan or migration | ~30+ reads |

**Split thresholds:**

- Total estimated reads > 40: a sequential setup + parallel fan-out split is warranted.
- Independent sub-tasks > 2 with a shared setup dependency: use sequential setup + parallel fan-out regardless of total read count.

## Rationale

The existing dispatch heuristic only considers output scope: blast radius, cross-layer spread, and file count of changes. This misses the failure mode where an agent exhausts its context window on input consumption — reading merge diffs, scanning related files, loading imports — before reaching the actual implementation work.

A task can be "small output, huge input": 130 lines written but 50+ files read. No output-side metric catches this. Planning-time prevention (decomposing the runbook) is far cheaper than runtime intervention (re-spawning a timed-out agent, losing partial work, or handing the user a partially applied change set).

## Examples

**Bad — single agent for merge + independent fixes:**

```yaml
id: implement
agent: engineer
dispatch: subagent  # Agent exhausts context on merge diff, never reaches the fixes
```

**Good — setup step then parallel fan-out:**

```yaml
id: resolve-conflicts
agent: engineer
dispatch: subagent  # Sequential: merge main into PR branch (expensive shared setup)

id: fix-tag-bypass
agent: engineer
dispatch: team  # Parallel: only needs matcher.ts context

id: fix-hub-cutoff
agent: engineer
dispatch: team  # Parallel: only needs kg-tags.ts context
```

The setup step resolves the expensive shared work (merge) as a sequential subagent. The fix steps use `dispatch: team` to execute in parallel, each operating on a focused slice of the codebase with per-agent input well within budget.

## Exceptions

- When all sub-tasks share the same 2–3 files (overlapping context), team dispatch adds orchestration overhead without context savings — a single focused agent is preferable.
- When the setup step is trivial (fewer than 5 file reads), splitting adds orchestrator round-trips that exceed the context savings.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "This principle is too strict for this case." | Principles prevent common failure modes specifically in edge cases and delivery pressure, where shortcuts look most attractive. | Apply the principle unless a concrete, bounded exception is documented under `## Exceptions`. |
| "We'll clean it up after this ships." | Deferred quality work usually becomes permanent debt and normalizes repeated violations. | Implement the compliant approach now, or record an explicit follow-up with owner and due date. |
| "Code review can catch this later." | Manual review is inconsistent under time pressure and cannot replace explicit constraints. | Encode compliance in code structure, tests, or linting so violations fail fast and repeatably. |
| "This is just a small change, so the rule doesn't matter." | Small changes accumulate into systemic drift when principles are waived incrementally. | Hold small changes to the same bar and verify the invariant still holds after each change. |

## Verification

- [ ] Updated files satisfy this principle's core constraint in behavior and structure.
- [ ] Any deviation is explicitly documented under `## Exceptions` with rationale and bounds.
- [ ] Tests, lints, or checks were added/updated where needed so regressions are detectable.
