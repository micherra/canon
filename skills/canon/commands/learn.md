---
description: Run Canon's learning analysis to discover patterns and suggest principle improvements
argument-hint: [--principle-health] [--codebase-patterns] [--convention-lifecycle] [--process-health] [--all]
allowed-tools: [Read, Bash, Write, Glob, Grep, Agent]
model: sonnet
---

Run Canon's learning analysis. Spawns the learner agent to analyze codebase patterns, review history, build execution data, and conventions to suggest improvements to Canon principles.

## Parse Arguments

From ${ARGUMENTS}, extract dimension flags:
- **`--principle-health`**: Analyze principle compliance and suggest severity changes
- **`--codebase-patterns`**: Scan codebase for consistent patterns to formalize
- **`--convention-lifecycle`**: Track convention promotion, graduation, and staleness
- **`--process-health`**: Analyze build execution history for process issues
- **`--all`** (default if no args): Run all dimensions

If no arguments provided, default to `--all`.

## Step 1: Check prerequisites

1. Verify `.canon/` directory exists (Canon is initialized in this project)
2. Check for sufficient data:
   - For `--principle-health`: check if `get_drift_report` returns >= 10 reviews
   - For `--process-health`: check if `get_history` returns >= 5 flow runs
   - Report data availability to the user before spawning

## Step 2: Spawn learner agent

Spawn the `learner` agent (`canon:learner`) with:
- Requested dimensions from the parsed arguments
- Project root path
- Paths to principles directory and conventions file

The learner will:
- Load baseline (principle index, conventions, learning history)
- Run each requested dimension per `references/learner-dimensions.md`
- Write results to `.canon/LEARNING-REPORT.md`
- Append to `.canon/learning.jsonl`

## Step 3: Present results

After the learner completes, read `.canon/LEARNING-REPORT.md` and present a summary:

```
Learning analysis complete:
- Dimensions analyzed: {list}
- Suggestions: {count}
- Report: .canon/LEARNING-REPORT.md

{If suggestions > 0}
Review the full report for improvement suggestions. Use /canon:review-learnings to act on auto-triggered proposals.
```
