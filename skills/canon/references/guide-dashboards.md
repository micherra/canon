# Guide Health Dashboard Reference

Reference material for `canon-guide`. Contains the health dashboard reporting format.

---

## Active Build Status

Read the active workspace's `board.json` and `session.json`. Present:
- Current flow and task
- Current state and its status
- States completed so far
- Whether anything is blocked
- Concerns accumulated

If no active workspace exists, say "No active build."

## Project Health Dashboard

Gather and present project-wide health data:

1. **Principles**: Count `.canon/principles/**/*.md` files. Tally by severity (rule / strong-opinion / convention).
2. **Recent reviews**: Read `.canon/reviews.jsonl` (if exists). Show the last 10 reviews as a scorecard:

| # | Date | Files | Verdict | Rules | Opinions | Conventions |
|---|------|-------|---------|-------|----------|-------------|

3. **Trend summary**: "Last 10 reviews: N CLEAN, N WARNING, N BLOCKING"
4. **Drift report**: Call the `get_drift_report` MCP tool. Display the formatted report inline — compliance rates, most violated principles, hotspot directories, recent deviations, never-triggered principles, and recommendations. If no reviews exist, skip and note "No review data yet."
5. **Learning readiness**: Last learn run timestamp, reviews since last learn

## Actionable Suggestions

Based on the data:
- If 0 reviews: "Run some code reviews to start building drift data."
- If 10+ reviews since last learn: "Enough data for learning — try `/canon:learn`."
- If 0 conventions: "No project conventions yet. Edit `.canon/CONVENTIONS.md` or run `/canon:learn --patterns`."
