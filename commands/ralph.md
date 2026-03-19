---
description: Iterative principle-driven build — loops review-refactor until CLEAN or max iterations
argument-hint: <task description> [--max-iterations N] [--auto] [--skip-research] [--skip-tests] [--skip-security] [--plan-only]
allowed-tools: [Read, Write, Edit, Bash, Glob, Grep, Agent]
model: opus
---

Ralph loop: runs the Canon build pipeline, then iterates review→refactor until the code meets Canon's standard (CLEAN verdict) or hits the iteration limit.

You are a **thin orchestrator**. You spawn agents, pass context between them, and manage the loop. You never do heavy work yourself. Stay under 30-40% context usage.

## Orchestrator Rules

- Read paths and metadata only. Never load file contents into your own context.
- Each agent spawn passes specific file paths to read, not raw content.
- Read summaries from agents, not full outputs.
- If a refactorer reports CANNOT_FIX, remove that violation from future iterations.
- Track convergence: if violations don't decrease, stop early.

## Parse Flags

From ${ARGUMENTS}, extract:
- **Task description**: Everything that's not a flag
- `--max-iterations N`: Max review-refactor loops (default 3)
- `--auto`: Auto-fix without pausing between iterations. Default is pause-and-ask.
- `--skip-research`: Pass through to build
- `--skip-tests`: Pass through to build
- `--skip-security`: Pass through to build
- `--plan-only`: Run build with --plan-only, no loop
- `--tier small|medium|large`: Override tier classification

## Setup

Create the artifact directory:
```bash
TASK_SLUG=$(echo "${task_description}" | tr '[:upper:]' '[:lower:]' | tr ' ' '-' | sed 's/[^a-z0-9-]//g' | head -c 50)
mkdir -p .canon/plans/${TASK_SLUG}/research
```

## Phase 1: Initial Build

Run the full `/canon:build` pipeline with the task description and any passthrough flags. This handles tier classification, research, architecture, planning, implementation, testing, security, and the first review.

Read the review verdict from `.canon/plans/{slug}/REVIEW.md`.

If **--plan-only**: Stop here, present the plan to the user.

If verdict is **CLEAN**: Skip to Phase 3 (Log & Report). The build passed on the first try.

## Phase 2: Ralph Loop

Initialize:
- `iteration = 1` (the build's review counts as iteration 0)
- `cannot_fix = []` — violations that refactorers couldn't fix
- `attempted_fixes = {}` — track fix attempts to detect repeats

### For each iteration (up to --max-iterations):

#### 2a. Parse Violations

Read `.canon/plans/{slug}/REVIEW.md` and extract violations:
- principle_id, severity, file_path, description
- Filter out any in `cannot_fix` list

If no actionable violations remain (all in cannot_fix), exit loop.

#### 2b. User Checkpoint (unless --auto)

Present violations to the user:
```
Ralph iteration {N}/{max}: {count} violation(s) to fix.
- [{principle-id}] ({severity}) in {file}: {description}

Continue? (The --auto flag skips this prompt.)
```

If user declines, exit loop.

#### 2c. Spawn Refactorers

Group violations by `{principle_id, file_path}`. For each group, spawn a canon-refactorer agent in parallel:

"Fix the {principle-id} violation in {file_path}. Details: {description}. The violated principle's severity is {severity}."

Collect outcomes:
- **FIXED**: Resolved
- **PARTIAL_FIX**: Note what remains
- **CANNOT_FIX**: Add to `cannot_fix` list with reason

#### 2d. Re-Review

Spawn canon-reviewer to review all changes since the last review:

"Review all code changes. Use `git diff HEAD~{commits_since_last_review}` to see changes. Save review to .canon/plans/{slug}/REVIEW.md"

Read the new verdict.

#### 2e. Convergence Check

Record iteration result: `{iteration, verdict, violations_count, violations_fixed, cannot_fix_count}`

- If **CLEAN**: Exit loop — converged.
- If violations unchanged from previous iteration (same count AND same principle IDs): Exit loop — stuck.
- If iteration == max_iterations: Exit loop — max reached.
- Otherwise: Continue to next iteration.

## Phase 3: Log & Report

### Log

Call the `log_ralph` MCP tool with:
- task_slug
- iterations array (all iteration results)
- final_verdict
- converged (true if CLEAN achieved)
- team (agents used: at minimum canon-reviewer, canon-refactorer)

### Emit orchestration events

For each iteration, emit events to `.canon/orchestration-events.jsonl` (if the event store is available). This feeds the orchestration UI.

### Report

Save `.canon/plans/{slug}/RALPH-REPORT.md`:

```markdown
## Ralph Report: {task description}

### Result: {CONVERGED | STUCK | MAX_ITERATIONS | USER_STOPPED}
Final verdict: {CLEAN | WARNING | BLOCKING}
Iterations: {N}

### Iteration Summary
| # | Verdict | Violations | Fixed | Cannot Fix |
|---|---------|-----------|-------|------------|
| 1 | WARNING | 5 | 3 | 0 |
| ... | | | | |

### Unfixed Violations
(List any remaining violations with principle IDs and reasons)

### Artifacts
- Build artifacts: .canon/plans/{slug}/
- Loop data: .canon/ralph-loops.jsonl
```

## Phase 4: Summary

Present the report to the user:

- If **CONVERGED**: "Ralph achieved CLEAN in {N} iterations. All Canon principles satisfied."
- If **STUCK**: "Ralph stopped after {N} iterations — violations unchanged. {count} violation(s) need manual attention."
- If **MAX_ITERATIONS**: "Ralph reached the {max} iteration limit with {verdict}. {count} violation(s) remain."
- If **USER_STOPPED**: "Ralph stopped at user request after {N} iterations."

Include a tip: "Run `/canon:learn` to analyze ralph loop patterns and improve principles."
