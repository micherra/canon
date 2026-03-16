---
description: Run a Canon flow — a predefined agent pipeline pattern
argument-hint: <flow-name> <task description> [--dry-run] [--max-iterations N] [--list]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent]
model: opus
---

Execute a Canon flow — a YAML-defined agent pipeline. Flows are lightweight orchestration patterns for common Canon workflows.

You are a **thin orchestrator**. You read the flow definition, spawn agents in order, handle branching (on_failure, loop_until), and emit events. Stay under 30-40% context usage.

## Parse Arguments

From ${ARGUMENTS}, extract:
- **Flow name**: First argument (e.g., "ralph", "quick-fix", "deep-build")
- **Task description**: Everything after the flow name that's not a flag
- `--dry-run`: Validate the flow and show the execution plan without running
- `--max-iterations N`: Override the flow's max_iterations
- `--list`: List all available flows and exit

## Available Built-in Flows

| Flow | Description | Steps |
|------|-------------|-------|
| `ralph` | Build-review-fix loop until CLEAN | build → review-loop (with refactor on violation) |
| `quick-fix` | Fast fix with review | implement → review |
| `deep-build` | Full research-to-review pipeline | research → architect → implement → test → security → review |
| `review-only` | Review current changes | review |
| `security-audit` | Security scan + review | security → review |

## --list Mode

If `--list` is passed, call the `list_flows` MCP tool and display the results:

```
Available Canon Flows:
  ralph        — Build-review-fix loop until CLEAN (3 steps, has loops)
  quick-fix    — Fast fix with review (2 steps)
  ...
```

## --dry-run Mode

If `--dry-run`:
1. Load the flow definition from `.canon/flows/{name}.yaml` (or plugin `flows/`)
2. Call `validate_flow` MCP tool
3. Display the validation result and execution plan:
   ```
   Flow: ralph (valid)
   Steps:
     1. [build] command: canon:build (passthrough_flags)
     2. [review-loop] agent: canon-reviewer (loop_until: verdict == "CLEAN", max: 3)
        on_violation: canon-refactorer (parallel_per: violation_group)
   ```
4. Do NOT execute.

## Execution

1. Load the flow YAML
2. Validate it — if invalid, show errors and stop
3. Create execution context with the task slug
4. For each step in order:
   - **If step has `command`**: Run the Canon command (e.g., `/canon:build` with task description)
   - **If step has `agent`**: Spawn the agent with appropriate context
   - **If step has `parallel`**: Spawn multiple instances in parallel
   - **If step has `wave`**: Execute in wave pattern (from build.md's wave logic)
   - **If step has `loop_until`**: Repeat until condition met or max_iterations reached
     - On each loop: check the condition, run `on_violation`/`on_failure` steps if applicable
   - **If step has `goto`**: Jump to the referenced step
5. After all steps complete, finalize and report

## Context Passing

Steps reference outputs from previous steps via `input`:
- `task_description` — The original task from the user
- `git_diff` — Current git diff
- `research_output` — Output from research step
- `plan` — Architect's plan
- `security_findings` — Security scan results

The orchestrator passes file paths, not contents.

## Summary

After execution, present:
- Flow name and status (success/failed/stuck/max_iterations)
- Steps completed / total
- Any verdicts or violations
- Path to artifacts in `.canon/plans/{slug}/`
