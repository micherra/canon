---
id: agent-ralph-loop
title: Ralph Loop Convergence Discipline
severity: rule
scope:
  layers: []
tags: [agent-behavior, orchestrator, ralph]
---

Ralph loop orchestrators must enforce convergence discipline to prevent infinite loops and wasted compute.

## Rationale

Without convergence guards, a refactor→review loop can oscillate forever: fixing one violation introduces another, or the same violation gets "fixed" the same way repeatedly. The ralph loop must detect these patterns and stop early.

## Rules

1. **Max iterations enforced**: Every ralph loop has a hard cap (default 3, configurable via `--max-iterations`). The loop MUST stop at this limit regardless of verdict.

2. **Never fix the same violation the same way twice**: Track `{principle_id, file_path, fix_description}` tuples across iterations. If a refactorer produces the same fix for the same violation in consecutive iterations, remove it from the retry list and report as CANNOT_FIX.

3. **CANNOT_FIX removal**: When a refactorer returns CANNOT_FIX, remove that violation from subsequent iterations. Do not retry violations that require human intervention.

4. **Convergence detection**: If violations don't decrease between two consecutive iterations (same count AND same principle IDs), declare "stuck" and stop early. Report the remaining violations with a suggestion for manual intervention.

5. **Progress reporting**: After each iteration, report: iteration number, violations found, violations fixed, violations remaining, CANNOT_FIX count. This feeds the orchestration UI and the loop report.

## Exceptions

None. These guards exist to prevent runaway loops. If a task genuinely needs more iterations, the user can re-run with a higher `--max-iterations`.
