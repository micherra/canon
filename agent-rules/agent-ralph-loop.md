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

2. **Never fix the same violation the same way twice**: Track `{principle_id, file_path, fix_description}` tuples in `iterations.{state_id}.history`. If a refactorer produces the same fix for the same violation in consecutive iterations, stop retrying and surface to user.

3. **CANNOT_FIX removal**: When a refactorer returns CANNOT_FIX, do not re-enter the fix state for that violation. Track in `iterations.{state_id}.history`.

4. **Stuck detection**: Use the `stuck_when` strategy defined on the state. If stuck is detected, override the normal transition and go to `hitl`. Report the remaining issues with a suggestion for manual intervention.

5. **Progress reporting**: After each cycle through a looping state, update `board.json` with: iteration number, result, and any relevant data for stuck detection. This feeds the summary and enables resume.

## Exceptions

None. These guards exist to prevent runaway loops. If a task genuinely needs more iterations, the user can increase `max_iterations` in the flow template.
