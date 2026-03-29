# Learner Dimension Specifications

Reference material for `canon-learner`. Contains dimension specs, report template, and learning log schema.

---

## Dimension: principle-health

**Goal**: Use review history to suggest severity promotions, demotions, scope revisions, and removal of dead principles.

### Data source

Call the `get_drift_report` MCP tool to get baseline stats: per-principle compliance rates, violation counts, trend, never-triggered list, violation file_paths, and hotspot directories.

For verdict-impact weighting, weight violations by their review verdict:
- Violations in BLOCKING reviews count 2x for severity analysis (they stopped builds)
- Violations in WARNING reviews count 1x (normal weight)
- A principle violated 3 times in BLOCKING reviews has the same signal as one violated 6 times in WARNING reviews

**Minimum threshold**: 10 reviews required for any suggestion. Below threshold → note "Skipped: principle-health — requires 10 reviews, have {current}."

### Promotion rules

| Signal | Threshold | Suggestion |
|--------|-----------|------------|
| High compliance, strong-opinion | >= 95% compliance across >= 10 reviews, 0 intentional deviations | Promote to rule |
| High compliance, convention | >= 95% compliance across >= 10 reviews | Promote to strong-opinion |

### Demotion rules

Demotions are as important as promotions — a principle at the wrong severity creates noise that erodes trust in the entire system.

| Signal | Threshold | Suggestion |
|--------|-----------|------------|
| Rule with frequent violations | < 80% compliance across >= 10 reviews for a rule | Demote to strong-opinion — if a rule is routinely broken, it's not functioning as a hard constraint |
| Rule with justified overrides | >= 3 intentional deviations for a rule | Demote to strong-opinion — rules should have zero legitimate exceptions; if exceptions exist, it's an opinion |
| Strong-opinion with low compliance | < 50% compliance across >= 10 reviews | Demote to convention — the team doesn't follow this as a default path |
| Strong-opinion ignored in practice | < 30% compliance across >= 15 reviews, no intentional deviations logged | Demote to convention or flag for removal — not even tracked as intentional |
| Convention never honored | < 20% compliance across >= 10 reviews | Flag for removal — this convention doesn't match how the team works |

### Other signals

| Signal | Threshold | Suggestion |
|--------|-----------|------------|
| Low compliance, any severity | < 50% compliance across >= 10 reviews | Revise: too strict, unclear, or wrong scope |
| Frequent justified overrides | >= 5 intentional deviations with similar justifications | Add exception or narrow scope |
| Never triggered | 0 appearances across >= 10 reviews | Flag as potentially dead — too narrow or irrelevant |
| Violations concentrated in one directory | >= 70% of violation file_paths in same directory/layer | Suggest narrowing scope — principle may be too broad for its actual applicability |

### Demotion safety

- **Never demote security-tagged rules** (check `tags:` in frontmatter). If a security rule has low compliance, suggest "investigate why" instead.
- **Minimum data**: 10 reviews for any suggestion, 15 for rule demotions. Below threshold → "insufficient data."
- Include `CAUTION: Demoting a rule means pre-commit hooks will no longer block this violation.` in any rule demotion suggestion.

### Output per suggestion

```
**{principle-id}** (current: {severity} → suggested: {new severity})
{compliance_rate}% compliance across {N} reviews, {M} intentional deviations
Suggest: {promote to X | demote to Y — reason | revise — reason | add exception for Z | flag as dead | narrow scope to {pattern}}
{CAUTION note if demoting a rule}
```

---

## Dimension: codebase-patterns

**Goal**: Detect consistent coding patterns in the live codebase that should be formalized as conventions or principles.

### Data source

Scan the codebase directly using **Grep** and **Glob** tools only. Do NOT use any MCP pattern tool. Scan these categories:

- Error handling (try/catch, Result types, error propagation patterns)
- Validation (schema libraries, guard clauses, input checks)
- Naming (file naming conventions, variable conventions, export patterns)
- Imports (barrel files, path aliases, import ordering)
- Testing (test file location, mock patterns, assertion style)
- API (HTTP handler structure, middleware patterns, response shapes)
- Types (type vs interface, generics, utility type usage)

For each category, identify the dominant pattern and count how many files use it vs. competing patterns.

**Minimum threshold**: Pattern must appear in >= 5 files with >= 70% consistency across relevant files.

### Cross-checks before suggesting

- Check against `.canon/CONVENTIONS.md` — skip if already a project convention
- Check against principle index — skip if already covered by a principle
- Only suggest patterns that are stable (not in recently modified files only)

### Output per suggestion

```
**{Pattern category}** ({N} files, {consistency}% consistent)
Pattern: "{description of the dominant pattern}"
Evidence: {file-1}, {file-2}, {file-3} (and {N-3} more)
Suggest: Add to CONVENTIONS.md — "{convention text}"
```

---

## Dimension: convention-lifecycle

**Goal**: Track the full lifecycle of conventions — from task-level patterns to project conventions to formal principles, and flag stale conventions.

This dimension merges three analyses:

### Sub-analysis A: Task convention promotion

**Data source**: `.canon/plans/*/CONVENTIONS.md` — task conventions created by the architect agent during builds.

1. Read all task convention files
2. Extract each convention line (bullets starting with `- **`)
3. Group semantically similar conventions (same category and similar pattern)
4. Count how many distinct builds each pattern appeared in

**Suggestion rule**: Pattern must appear in >= 3 distinct builds to suggest promotion. Cross-check against `.canon/CONVENTIONS.md` and principle index before suggesting.

**Minimum threshold**: 3 builds. Below → note "Skipped: convention promotion — requires 3 builds, have {current}."

**Output per suggestion**:
```
**{Pattern category}** (appeared in {N} builds)
Pattern: "{the convention text}"
Builds: {slug-1}, {slug-2}, {slug-3}
Suggest: Add to CONVENTIONS.md — "{convention text}"
```

### Sub-analysis B: Convention graduation

**Goal**: Identify conventions in `.canon/CONVENTIONS.md` ready to become formal principles.

1. Read `.canon/CONVENTIONS.md` — extract each convention
2. For each convention, check:
   - **Age**: Check `git log --diff-filter=A -p .canon/CONVENTIONS.md` to find when it was added. Conventions added in the last build are too new.
   - **Codebase adherence**: Use Grep/Glob to verify the pattern holds. Threshold: >= 80% consistency across relevant files.
   - **Build survival**: Has this convention appeared as a task convention in multiple builds? Check `.canon/plans/*/CONVENTIONS.md` for overlap.
   - **No violations**: Has this convention ever been contradicted in review data?

**Graduation criteria** (all must be true):
- Convention has existed for >= 5 builds or been in `CONVENTIONS.md` for a meaningful period
- Codebase adherence >= 80% across relevant files
- Convention has never been contradicted in review or decision data

**Output per suggestion**:
```
**{Convention text}** (ready for graduation)
Age: Present since {date or build count}
Adherence: {N}% across {M} files
Suggest: Ask Canon to create a new principle — starts an interactive interview to build a formal principle with rationale and examples
Proposed severity: {convention or strong-opinion based on whether it affects correctness}
```

### Sub-analysis C: Convention staleness detection

**Goal**: Identify conventions in `CONVENTIONS.md` that the codebase no longer follows.

1. Read `.canon/CONVENTIONS.md` — extract each convention
2. For each convention, determine what codebase pattern it describes
3. Use Grep/Glob to check if the pattern still holds:
   - Search for the pattern the convention describes
   - Search for contradicting patterns (e.g., if convention says "Use Zod", search for competing validation libraries)
4. Calculate current adherence

**Staleness criteria** (any one sufficient):
- Adherence has dropped below 50% across relevant files
- A competing pattern has emerged with higher adoption than the convention's pattern
- The convention references a tool/library/pattern that no longer exists in the codebase

**Output per suggestion**:
```
**{Convention text}** (stale)
Current adherence: {N}% across {M} files
Competing pattern: {what the codebase actually does now, if applicable}
Suggest: {update convention to match current practice | remove convention | investigate divergence}
```

---

## Dimension: process-health

**Goal**: Detect flow execution problems — churn, duration outliers, skipped states, and declining pass rates — that suggest principles or flow definitions need revision.

### Data source

Read `.canon/flow-runs.jsonl` directly (no MCP tool needed). Each entry represents one completed flow run with state-level data.

**Minimum threshold**: 5 flow runs required for any suggestion. Below → note "Skipped: process-health — requires 5 flow runs, have {current}."

### Signals to analyze

| Signal | Threshold | Suggestion |
|--------|-----------|------------|
| High iteration count on a state | Average iterations >= 3 across >= 5 runs | Review→fix churn — suggest examining the principle or implementor prompt for that state |
| Declining pass rates | Gate/postcondition pass rate trending down across recent 5 runs | Principles may be becoming harder to satisfy — review recently changed principles |
| Duration outlier by tier | A small-tier flow taking as long as a large-tier flow across >= 3 runs | Flow definition may have unnecessary states for this tier |
| Frequently skipped states | Same state skipped in >= 60% of runs | Flow definition may need trimming — this state adds little value |
| Rising violation count | Total violations per run trending up across recent 5 runs | Principles may need revision or scope narrowing |

### Output per suggestion

```
**{state-name or flow-name}** ({signal type})
Evidence: {specific numbers — average iterations, pass rate trend, duration comparison}
Runs analyzed: {N}
Suggest: {specific action — examine principle X | trim state Y from flow | review implementor prompt for state Z}
```

---

## Report Template

Combine all suggestions into `.canon/LEARNING-REPORT.md`:

```markdown
## Canon Learning Report
Generated: {YYYY-MM-DD} | Reviews analyzed: {N} | Source files scanned: {N} | Flow runs analyzed: {N}

### Principle Health (from review history)

#### Promotions
{principle-health promotion suggestions, or "No promotions suggested." if none}

#### Demotions
{principle-health demotion suggestions, or "No demotions suggested." if none}

#### Scope / Revision
{principle-health scope and revision suggestions, or "No scope revisions suggested." if none}

### Codebase Patterns (from live scan)
{codebase-patterns suggestions, or "No new patterns found meeting threshold (5+ files, 70%+ consistency)." if none}

### Convention Lifecycle

#### Task Convention Promotions
{convention-lifecycle sub-A suggestions, or "No recurring task conventions found (need 3+ builds)." if none}

#### Convention Graduation Candidates
{convention-lifecycle sub-B suggestions, or "No conventions ready for graduation." if none}

#### Stale Conventions
{convention-lifecycle sub-C suggestions, or "All conventions are current." if none}

### Process Health (from flow-runs.jsonl)
{process-health suggestions, or "No process health issues detected." if none}

### Recurring Suggestions
{Suggestions that appeared in 3+ previous learning runs but were never acted on — flag these prominently}

### No Action Needed
- {N} principles have healthy compliance (>80%) with sufficient data
- {M} conventions are well-established in the codebase
- Next learning run recommended after {threshold} more reviews
```

If a dimension was not requested (flags), omit its section entirely.

---

## Learning Log Schema

After writing the report, append a structured entry to `.canon/learning.jsonl`:

```json
{
  "run_id": "learn_{YYYYMMDD}_{random_hex}",
  "timestamp": "{ISO-8601}",
  "dimensions": ["principle-health", "codebase-patterns", "convention-lifecycle", "process-health"],
  "data_summary": {
    "reviews_analyzed": 0,
    "source_files_scanned": 0,
    "task_conventions_read": 0,
    "flow_runs_analyzed": 0
  },
  "suggestions": [
    {
      "id": "sug_{deterministic_hash}",
      "dimension": "principle-health",
      "type": "promote|demote|revise|narrow-scope|flag-dead|promote-convention|graduate|stale|churn|pass-rate|duration|skipped-state|violation-trend",
      "target": "principle-id or convention text or state name",
      "summary": "One-line description of what's suggested",
      "confidence": "high|medium",
      "action": "suggested"
    }
  ]
}
```

### Suggestion ID generation

IDs must be **deterministic** so the same suggestion across runs produces the same ID. This is critical for history dedup and suppression.

Generate the ID by concatenating `dimension + type + target` and taking the first 8 characters of a simple hash:

```
id = "sug_" + first8chars(lowercase(dimension + ":" + type + ":" + target))
```

For example:
- Principle health promotion of `validate-at-trust-boundaries` → `sug_principle-health:promote:validate-at-trust-boundaries` → take first 8 hex chars of a hash
- New codebase pattern about Zod validation → `sug_codebase-patterns:promote-convention:zod-validation-at-api-boundaries` → take first 8

In bash (portable): `echo -n "principle-health:promote:validate-at-trust-boundaries" | md5sum | head -c 8`
(On macOS use `md5 -q` instead of `md5sum` if `md5sum` is unavailable.)

The key property: **the same suggestion always gets the same ID**, regardless of when or how many times the learner runs.

The `action` field starts as `"suggested"`. When the user acts on or dismisses a suggestion via `--apply`, the orchestrator updates it to `"applied"` or `"dismissed"`.

This log enables:
- Detecting recurring suggestions across runs
- Suppressing dismissed suggestions
- Tracking which suggestions were acted on
