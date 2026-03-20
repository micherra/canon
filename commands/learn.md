---
description: Analyze codebase and drift data to suggest principle and convention improvements
argument-hint: [--patterns] [--drift] [--conventions] [--decisions] [--graduation] [--staleness] [--apply]
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep, Agent]
model: sonnet
---

Analyze accumulated review data, decision logs, task conventions, and codebase patterns to suggest improvements to Canon principles and conventions. This is Canon's learning loop — it turns enforcement data into actionable refinements.

## Instructions

### Step 1: Parse arguments

Extract flags from ${ARGUMENTS}:
- `--patterns`: Only run codebase pattern inference
- `--drift`: Only run drift-driven severity analysis (includes promotions AND demotions)
- `--conventions`: Only run task convention promotion analysis
- `--decisions`: Only run decision cluster analysis
- `--graduation`: Only run convention-to-principle graduation analysis
- `--staleness`: Only run convention staleness detection
- `--apply`: After generating the report, walk through each suggestion interactively
- No dimension flags (default): Run all six dimensions

Multiple flags can be combined: `--drift --decisions --apply`

### Step 2: Check for data

Check what data sources are available. Use Glob and Read to count lines in:
- `.canon/reviews.jsonl` — review count
- `.canon/decisions.jsonl` — decision count
- `.canon/patterns.jsonl` — agent-reported patterns
- `.canon/learning.jsonl` — previous learning runs
- `.canon/plans/*/CONVENTIONS.md` — task convention files
- `.canon/CONVENTIONS.md` — project conventions
- `.canon/principles/` (including subdirectories `rules/`, `strong-opinions/`, `conventions/`) or `${CLAUDE_PLUGIN_ROOT}/principles/` — principle index

Also glob for source files: `**/*.{ts,tsx,js,jsx,py,go,rs}` (excluding `node_modules/`, `.git/`, `.canon/`, `dist/`, `build/`).

**Early exit**: If `reviews.jsonl` has fewer than 10 lines AND the user didn't pass `--patterns`, `--graduation`, or `--staleness` (which only need the codebase), tell the user:

"Not enough data yet — Canon needs at least 10 code reviews to generate meaningful learning suggestions. You have {N} so far. Run code reviews on a few more files, then come back."

Stop here. Do not spawn the learner.

**Data requirements by dimension:**

| Dimension | Minimum data needed |
|-----------|-------------------|
| patterns | >= 5 source files |
| drift | >= 10 reviews (15 for rule demotions) |
| conventions | >= 3 task convention files |
| decisions | >= 3 decisions for any single principle |
| graduation | >= 1 convention in CONVENTIONS.md + >= 5 source files |
| staleness | >= 1 convention in CONVENTIONS.md + >= 5 source files |

If the user only asked for `--patterns`, `--graduation`, or `--staleness`, the codebase itself is sufficient — proceed even without drift data.

### Step 3: Spawn the canon-learner agent

Launch the canon-learner agent. Provide it with:
- Which dimensions to analyze (based on flags or all six)
- Data availability summary (all counts from Step 2)
- Path to project principles directory (`.canon/principles/` or `${CLAUDE_PLUGIN_ROOT}/principles/`)
- Path to project conventions (`.canon/CONVENTIONS.md`)
- Path to learning history (`.canon/learning.jsonl`)
- Path to agent-reported patterns (`.canon/patterns.jsonl`)
- Project root directory

The agent will:
1. Check learning history for suppressed/recurring suggestions
2. Run the requested analyses
3. Apply minimum confidence thresholds (no noisy suggestions)
4. Produce a structured learning report → `.canon/LEARNING-REPORT.md`
5. Append a structured entry to `.canon/learning.jsonl`

### Step 4: Present the report

Read `.canon/LEARNING-REPORT.md` and display it to the user.

If `--apply` was NOT passed, show action hints after the report:

```markdown
---
**To act on suggestions interactively:** `/canon:learn --apply`

**Manual actions:**
- Add a convention: Edit `.canon/CONVENTIONS.md` directly
- Edit a principle's severity: `/canon:edit-principle {id} --severity {level}`
- Create a new principle: `ask Canon to create a new principle {topic}`
- Log a decision: Use the `report` MCP tool (type=decision)

**To re-run specific dimensions:**
`/canon:learn --drift` | `--patterns` | `--conventions` | `--decisions` | `--graduation` | `--staleness`
```

### Step 5: Interactive apply (only if --apply)

If `--apply` was passed, walk through each suggestion in the report interactively.

For each suggestion, present it to the user and ask:

**"Apply / Skip / Dismiss / Modify?"**

- **Apply**: Execute the suggestion now
- **Skip**: Leave it for next time (may reappear)
- **Dismiss**: Permanently suppress (will never reappear)
- **Modify**: Edit the suggestion text, then apply

Based on the user's choice:

#### Apply

Execute the suggestion:

| Suggestion type | Action |
|----------------|--------|
| New convention | Append to `.canon/CONVENTIONS.md` |
| Severity promotion/demotion | Run `/canon:edit-principle {id} --severity {level}` or edit the principle's YAML frontmatter and move to the appropriate subdirectory |
| Task convention promotion | Append to `.canon/CONVENTIONS.md` |
| Principle revision (add exception) | Read the principle file, append an exception to its Exceptions section |
| Convention graduation | Tell the user to run `ask Canon to create a new principle {topic}` — this requires interactive authoring, don't attempt inline |
| Stale convention removal | Remove the convention line from `.canon/CONVENTIONS.md` |
| Stale convention update | Replace the convention line in `.canon/CONVENTIONS.md` with updated text |

After applying, update the suggestion's entry in `.canon/learning.jsonl` — read the last entry, find the matching suggestion by id, set `"action": "applied"`, and rewrite the last line.

#### Skip

Mark the suggestion as `"action": "skipped"` in learning.jsonl. It may reappear in future runs.

#### Dismiss

Mark the suggestion as `"action": "dismissed"` in learning.jsonl. It will NOT reappear in future runs (the learner agent checks for dismissed suggestions).

#### Modify

Let the user edit the suggestion text, then apply the modified version. Mark as `"action": "applied"` with the modified text.

After walking through all suggestions, show a summary:
```
Applied: N | Skipped: M | Dismissed: K
```

### Important constraints

- Without `--apply`, this command is **read-only analysis** — it never modifies principles, conventions, or any project files (except writing the report and learning log)
- With `--apply`, it modifies only what the user explicitly approves per suggestion
- The report REPLACES any previous `.canon/LEARNING-REPORT.md` (it's a snapshot, not a log)
- The learning log (`.canon/learning.jsonl`) is append-only (except for updating action status during --apply)
- All suggestions include confidence levels and sample sizes so the user can judge quality
- The agent should be conservative — false positives erode trust in the learning loop
- **Demotion safety**: The agent will never suggest demoting security-tagged rules. If `--apply` encounters a demotion suggestion, show an extra confirmation warning before proceeding.
