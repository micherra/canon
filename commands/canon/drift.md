---
description: Show Canon drift analytics and compliance trends
argument-hint: [--last N] [--principle ID] [--dir PATH]
allowed-tools: [Bash, Read, Glob]
---

Display drift analytics for Canon principle adherence over time. Shows violation trends, hotspot directories, intentional vs unintentional deviations, and recommendations.

## Instructions

### Step 1: Check for data

Look for drift data files:
- `.canon/decisions.jsonl` — intentional deviations logged via `report_decision`
- `.canon/reviews.jsonl` — review results logged by the reviewer agent

If neither file exists, tell the user:
"No drift data found. Drift tracking requires using `/canon:review` to review code and the MCP `report_decision` tool to log intentional deviations. Run some reviews first, then come back here."

### Step 2: Parse arguments

From ${ARGUMENTS}:
- `--last N` → only analyze the last N reviews
- `--principle ID` → drill into a specific principle (e.g., `--principle thin-handlers`)
- `--dir PATH` → drill into a specific directory (e.g., `--dir src/api`)

### Step 3: Load and analyze data

Read both `.jsonl` files. Each line is a JSON object.

For `.canon/reviews.jsonl`, each entry has:
```json
{"review_id":"...","timestamp":"...","verdict":"BLOCKING|WARNING|CLEAN","files":["..."],"violations":[{"principle_id":"...","severity":"..."}],"honored":["..."],"score":{"rules":{"passed":N,"total":N},"opinions":{"passed":N,"total":N},"conventions":{"passed":N,"total":N}}}
```

For `.canon/decisions.jsonl`, each entry has:
```json
{"decision_id":"...","timestamp":"...","principle_id":"...","file_path":"...","justification":"...","category":"performance|legacy-constraint|scope-mismatch|intentional-tradeoff|external-requirement|other"}
```

### Step 4: Compute metrics

1. **Violation frequency by principle** — which principles are violated most
2. **Hotspot directories** — which directories have the most violations
3. **Intentional vs unintentional ratio** — % of deviations that were logged as intentional
4. **Trend** — compare first half vs second half of reviews: improving, stable, or declining
5. **Average score** — rules/opinions/conventions pass rates
6. **Never-triggered principles** — principles that never appeared in any review

### Step 5: Present the report

```markdown
## Canon Drift Report

### Overview (last N reviews)
Total reviews: N
Avg score: Rules X% | Opinions X% | Conventions X%
Trend: Improving/Stable/Declining
Intentional deviation ratio: X%

### Most violated principles
1. principle-id (N violations, N unintentional)
2. principle-id (N violations, N unintentional)

### Hotspot directories
1. src/api/ — N violations across N reviews
2. src/components/ — N violations across N reviews

### Intentional deviation log (last 5)
- [2026-03-13] principle-id in file/path.ts
  "Justification text"

### Recommendations
- Consider revising principle-id (low compliance)
- src/api/ may benefit from a dedicated review pass
```

If `--principle` was specified, show detailed stats for that principle only.
If `--dir` was specified, show detailed stats for that directory only.

### Relationship to `/canon:learn`

`/canon:drift` shows **what happened** — raw analytics, trends, and hotspots. `/canon:learn --drift` analyzes the same data but suggests **what to do about it** — severity promotions, demotions, and principle revisions. After reviewing drift data, suggest running `/canon:learn --drift` for actionable recommendations.
