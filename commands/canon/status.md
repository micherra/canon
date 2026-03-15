---
description: Quick health dashboard for Canon in the current project
argument-hint:
allowed-tools: [Bash, Read, Glob, Grep]
---

Show a one-glance overview of Canon's state in the current project.

## Instructions

### Step 1: Check if Canon is initialized

Look for `.canon/principles/` directory. If it doesn't exist, tell the user:
"Canon is not initialized in this project. Run `/canon:init` to set up."

### Step 2: Gather data

Collect the following in parallel:

1. **Principles**: Count `.canon/principles/**/*.md` files (scanning subdirectories `rules/`, `strong-opinions/`, `conventions/`). For each, read the YAML frontmatter `severity:` field. Tally by severity (rule / strong-opinion / convention).
2. **Reviews**: Count lines in `.canon/reviews.jsonl` (if exists). Read the last entry's timestamp.
3. **Decisions**: Count lines in `.canon/decisions.jsonl` (if exists). Read the last entry's timestamp.
4. **Patterns**: Count lines in `.canon/patterns.jsonl` (if exists).
5. **Conventions**: Check if `.canon/CONVENTIONS.md` exists. Count convention lines (bullets starting with `- **`).
6. **Last learn run**: Check if `.canon/learning.jsonl` exists. Read the last entry's timestamp and suggestion count.
7. **Config**: Check if `.canon/config.json` exists.

### Step 3: Present the dashboard

```markdown
## Canon Status

### Principles
Rules: N | Strong opinions: N | Conventions: N | Total: N

### Recent Reviews
(Show the last 10 reviews from reviews.jsonl as a scorecard)

| # | Date | Files | Verdict | Rules | Opinions | Conventions |
|---|------|-------|---------|-------|----------|-------------|
| 1 | 2025-01-15 | 3 | CLEAN | 4/4 | 6/6 | 3/3 |
| 2 | 2025-01-14 | 5 | WARNING | 4/4 | 5/7 | 2/3 |
| ... | | | | | | |

Parse each review entry from reviews.jsonl. For each, extract:
- `timestamp` → format as date
- `files` → count
- `verdict` → CLEAN, WARNING, or BLOCKING
- `score.rules` → pass/total (e.g. "4/4")
- `score.opinions` → pass/total
- `score.conventions` → pass/total

If fewer than 10 reviews exist, show all of them. If no reviews exist, show "No reviews yet."

Below the table, show a trend summary:
- "Last 10 reviews: N CLEAN, N WARNING, N BLOCKING"
- If all recent reviews are CLEAN: "All clear — principles are holding."
- If BLOCKING count > 0: "N blocking reviews — run `/canon:drift` for details."

### Drift Data
Reviews: N (last: YYYY-MM-DD or "none")
Decisions: N (last: YYYY-MM-DD or "none")
Patterns observed: N

### Conventions
Project conventions: N

### Learning
Last learn run: YYYY-MM-DD (N suggestions) or "never"
Reviews since last learn: N
```

### Step 4: Actionable suggestions

Based on the data, include relevant suggestions:

- If **0 reviews**: "Run `/canon:review` on some code to start building drift data."
- If **10+ reviews since last learn** (or never learned): "You have enough review data for learning. Run `/canon:learn` to discover patterns and refine principles."
- If **0 conventions**: "No project conventions yet. Edit `.canon/CONVENTIONS.md` to document patterns, or run `/canon:learn --patterns` to auto-discover them."
- If **0 decisions but 5+ reviews with violations**: "Consider using the `report` tool (type=decision) to log intentional deviations — this helps Canon distinguish violations from tradeoffs."
- If **no config**: "No `.canon/config.json` found. Run `/canon:init` to generate default config."
