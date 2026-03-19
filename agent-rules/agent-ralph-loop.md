---
id: agent-convergence-discipline
title: Flow Convergence Discipline
severity: rule
scope:
  layers: []
tags: [agent-behavior, orchestrator, flow]
---

Flow state machines with cycles (e.g., `fix-violations → review → fix-violations`) must enforce convergence discipline to prevent infinite loops and wasted compute.

## Rationale

Without convergence guards, a refactor→review cycle can oscillate forever: fixing one violation introduces another, or the same violation gets "fixed" the same way repeatedly. The flow must detect these patterns and stop early.

## Rules

1. **Max iterations enforced**: Every state with `max_iterations` has a hard cap. The orchestrator MUST transition to `hitl` at this limit regardless of the agent's result. Track iteration count in `board.json` under `iterations.{state_id}.count`.

2. **Duplicate fix detection**: The orchestrator uses the `stuck_when` strategy on the state to detect duplicate work. For `same_violations`, this compares the set of `{principle_id, file_path}` pairs between consecutive iterations. If the sets are identical, the orchestrator transitions to `hitl` — the fix is not converging. The refactorer itself does not need to track this; the orchestrator parses it from the reviewer's REVIEW.md violations table each cycle.

3. **CANNOT_FIX exclusion**: When a refactorer returns CANNOT_FIX for a violation, the orchestrator records it in `iterations.{state_id}.cannot_fix` as a list of `{principle_id, file_path}` pairs. On the next cycle through `parallel-per`, the orchestrator excludes these items from the `iterate_on` fan-out. If all remaining items are in the cannot_fix list, transition to `hitl`.

4. **Stuck detection**: Use the `stuck_when` strategy defined on the state (see SCHEMA.md for history entry schemas). If stuck is detected, override the normal transition and go to `hitl`. The HITL message includes: stuck strategy, iteration count, and the repeated pattern.

5. **Progress reporting**: After each cycle through a looping state, update `board.json` with: iteration number, result, and history entry matching the `stuck_when` schema. This feeds resumability and enables stuck detection across context resets.

## Exceptions

None. These guards exist to prevent runaway loops. If a task genuinely needs more iterations, the user can increase `max_iterations` in the flow template.
