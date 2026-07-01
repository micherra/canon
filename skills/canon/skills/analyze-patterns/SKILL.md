---
name: analyze-patterns
description: >-
  Pattern mining and proposal generation for Canon's learning loop.
  Analyzes codebase patterns, review history, build execution data,
  and conventions to produce structured improvement proposals.
  Covers manual analysis and auto-trigger modes. Loaded by the
  learner agent.
user-invocable: false
---

# canon:analyze-patterns — Pattern Mining and Proposal Generation Skill

This skill defines the full procedural contract for Canon's learning loop. Load it when you are the learner agent performing pattern analysis. The agent body's read-only constraint is absolute and inherited by this skill — you NEVER modify principles, conventions, or project code.

---

## Context

You receive from the orchestrator:

- Which dimensions to analyze (any of: `principle-health`, `codebase-patterns`, `convention-lifecycle`, `process-health`, `agent-effectiveness`, `artifact-retirement`, `retrieval-effectiveness`, `rule-compliance-measurement`, `cliff-rate`)
- Data availability summary
- Paths to principles directory, conventions file, project root
- Previous learning history (`.canon/learning.jsonl`) if it exists — check for suppressed suggestions
- **[Auto-trigger mode]** Recent build transcript paths when spawned after flow completion — these are the primary input for the `agent-effectiveness` dimension, which is the PRIMARY dimension for auto-trigger mode
- **[Auto-trigger mode]** Build execution summary from the completed flow (via workspace journal)

---

## Process

### Step 1: Load baseline and initialize the report

Load the current state of Canon in this project:

1. Build the principle index — per `${CLAUDE_PLUGIN_ROOT}/references/principle-loading.md`, use `list_principles` MCP tool for the metadata-only index. Record each principle's id, severity, scope, and tags.
2. Read `.canon/CONVENTIONS.md` if it exists — these are the project's current conventions.
3. Read `.canon/learning.jsonl` if it exists — these are previous suggestions. Check for:
   - **Suppressed suggestions**: entries with `"action": "dismissed"` — do NOT re-suggest these
   - **Recurring suggestions**: entries with `"action": "suggested"` appearing 3+ times — flag as persistent
4. This is your baseline. Every suggestion must be checked against it — don't suggest what already exists and don't re-suggest dismissed items.
5. **Initialize the report file**: Write `.canon/LEARNING-REPORT.md` with a header containing the date and scope summary. Use this format:

```markdown
# Canon Learning Report

Generated: {ISO date}
Dimensions: {comma-separated list of requested dimensions}
Status: in-progress

---
```

This ensures the file exists even if the agent hits its turn limit during analysis.

### Step 2: Run requested dimensions

Run dimensions in order of data availability. **Skip dimensions without sufficient data** and note it in the report. **After completing each dimension's analysis, immediately append its findings section to `.canon/LEARNING-REPORT.md`** before moving to the next dimension. This ensures partial results are persisted if the turn limit is reached mid-analysis. Run `agent-effectiveness` AFTER `process-health` — it benefits from the flow-level patterns already identified by process-health analysis.

Dimension ordering depends on trigger mode:
- **Auto-trigger mode** (learner spawned automatically after a build): run `agent-effectiveness` FIRST — it is the primary dimension in this mode. Run `process-health` after, only if sufficient flow history exists (>= 5 flow runs). The flow history needed by process-health may not yet exist for a fresh build.
- **Manual/explicit mode** (user explicitly requests pattern analysis): run `process-health` before `agent-effectiveness` — agent-effectiveness benefits from the flow-level patterns already identified by process-health analysis.

Data sufficiency thresholds:

- **principle-health** requires >= 10 reviews (from `get_drift_report`)
- **codebase-patterns** requires >= 5 files with >= 70% consistency per pattern
- **convention-lifecycle** requires >= 3 builds for promotion sub-analysis; graduation and staleness run regardless. Success-pattern mining (Sub-analysis E) requires >= 3 distinct clean builds carrying a `notable_resolution` line; below threshold → skip with "Skipped: success-pattern — {N} < 3 distinct clean builds."
- **process-health** requires >= 5 flow runs (from `get_history` MCP tool; supplement with `get_build_history` for trend analysis across many builds)
- **agent-effectiveness** requires >= 3 completed flows with transcript data (read from workspace journals)
- **artifact-retirement** (principle path) requires >= 10 reviews (inherits principle-health minimum); below threshold → emit "Skipped: artifact-retirement (principles) — requires 10 reviews, have {current}". The convention/agent-rule adherence path has no review-count floor but still requires the 2-run cooling-off (`watch_threshold: 2`).
- **retrieval-effectiveness** requires >= 3 flows with transcript data (assess whether the right context was loaded for the task).
- **rule-compliance-measurement** requires >= 10 builds with transcript data (measure whether rule-severity principles are consistently honored).
- **cliff-rate** uses `get_cross_run_analysis`; sparse-data contract applies (emit partial signal even below the ideal sample count, but note the confidence).

For each dimension:
1. Run the dimension analysis per the specs in `${CLAUDE_PLUGIN_ROOT}/references/learner-dimensions.md`.
2. If data is insufficient, append a skip notice for that dimension to the report immediately.
3. If data is sufficient, append the full dimension section (suggestions, evidence, counts) to the report immediately.
4. Proceed to the next dimension only after appending.

### Dimension Specifications

Run each requested dimension per the specs in `${CLAUDE_PLUGIN_ROOT}/references/learner-dimensions.md`. That file contains:
- Data sources for each dimension (note: no `get_patterns` or `get_decisions` MCP tools — use `get_drift_report` for principle-health and live Grep/Glob for codebase-patterns)
- Thresholds (minimum reviews, builds, flow runs, consistency rates)
- Output format per suggestion
- Report template and learning log schema

Skip dimensions without sufficient data (thresholds are in the reference file).

### Step 3: Finalize the report

Enhance the existing `.canon/LEARNING-REPORT.md` by appending summary sections and updating the header metadata:

1. Append a `## Recurring Suggestions` section listing any suggestions that appeared 3+ times in the learning log.
2. Append a `## No Action Needed` section listing any skipped dimensions and their reason (insufficient data or not requested).
3. Update the `Status: in-progress` line in the header to `Status: complete` and add a final suggestion count: `Suggestions: {N}`.

This step enhances the existing file — it does NOT rewrite it from scratch. All dimension sections written in Step 2 are preserved.

### Step 4: Append to learning log

After finalizing the report, append a structured entry to `.canon/learning.jsonl` using the schema in `${CLAUDE_PLUGIN_ROOT}/references/learner-dimensions.md`.

### Step 5: Write structured proposals (auto-trigger mode only)

When spawned in auto-trigger mode (you receive transcript paths rather than dimension flags), write structured proposals instead of the learning report.

Create the directory `.canon/proposed-learnings/{timestamp}/` where `{timestamp}` is the current ISO timestamp with colons replaced by hyphens (e.g., `2026-04-08T15-30-00Z`).

For each suggestion, write a separate markdown file: `{nn}-{slug}.md` (e.g., `01-add-error-boundary-convention.md`).

Each proposal file follows this format:

```markdown
---
proposal_id: "{timestamp}-{nn}"
type: "new-convention" | "severity-change" | "principle-revision" | "convention-graduation" | "stale-removal"
confidence: 0.0-1.0
target: "{principle-id or convention text}"
---

## Observation

{What pattern was observed, with quantified evidence}

## Proposed Change

{Exact text to add, modify, or remove}

## Evidence

{Transcript excerpts, file counts, review data that support this}
- Source: {transcript path or data source}
- Metric: {specific number}

## Impact

{What improves if this change is adopted}
```

**Write constraint**: Only write files to `.canon/proposed-learnings/`. Do not write to any other directory. Do not modify `.canon/LEARNING-REPORT.md` or `.canon/learning.jsonl` in auto-trigger mode.

### Step 6: Output notification summary (auto-trigger mode only)

After writing all proposals, output a final summary line in this exact format as the LAST line of your response:

CANON_LEARN_NOTIFICATION: Canon learned {N} patterns from recent flows. Run `/canon:review-learnings` to review.

Where {N} is the number of proposal files written. If no proposals were generated (no actionable patterns found), output:

CANON_LEARN_NOTIFICATION: Canon analyzed recent flows but found no new patterns to propose.

This line is machine-readable — the orchestrator parses it to display a user notification.

---

## Mode-Specific Write Constraints

| Mode | Write targets | Forbidden |
|------|--------------|-----------|
| Manual (natural language intent) | `.canon/LEARNING-REPORT.md`, `.canon/learning.jsonl` | `.canon/proposed-learnings/` |
| Auto-trigger (transcript paths received) | `.canon/proposed-learnings/{timestamp}/` | `.canon/LEARNING-REPORT.md`, `.canon/learning.jsonl` |

**Auto-trigger vs manual mode detection**: You are in auto-trigger mode when the orchestrator provides transcript paths in your context instead of dimension flags. When spawned via natural language intent (e.g., "analyze codebase patterns"), dimension flags are explicit (`--principle-health`, `--codebase-patterns`, etc.) and you are in manual mode.
