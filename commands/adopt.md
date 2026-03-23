---
description: Scan codebase for principle coverage and produce a prioritized remediation plan
argument-hint: [directory] [--top N] [--severity rule|strong-opinion|convention] [--fix]
allowed-tools: [Read, Bash, Glob, Grep, Agent]
model: sonnet
---

Thin launcher for the `adopt` flow. Scans the codebase for Canon principle applicability, identifies violations, and optionally spawns fixers on rule-severity violations.

## Instructions

### Step 1: Parse arguments

From ${ARGUMENTS}, extract:
- **Directory**: First non-flag argument, defaults to `.` if not provided
- `--top N`: Number of top violation files to highlight (default: 10)
- `--severity LEVEL`: Minimum severity to include (default: `convention` — includes everything)
- `--fix`: If present, automatically fix Tier 1 (rule-severity) violations after scan

### Step 2: Launch the adopt flow

Invoke the orchestrator with:
- `flow: adopt`
- `task: "Adoption scan of ${directory}"`
- Metadata: `{ fix_requested: {bool}, severity_filter: "{level}", top_n: {N}, directory: "{path}" }`

The flow will:
1. **Scan**: Discover files, match principles, produce tiered adoption report
2. **Fix** (if `--fix`): Spawn parallel fixers on Tier 1 violations
3. **Rescan** (after fix): Regenerate the report to show progress

### Step 3: Present results

Read the adoption report from the workspace and display to the user.

If `--fix` was used, also show:
- How many violations were fixed vs. remaining
- Any violations that could not be fixed automatically

Suggest next steps:
- Ask Canon to explain any unfamiliar principles
- Ask Canon for status to see drift data and compliance trends
- Re-run with `--fix` to address remaining violations
