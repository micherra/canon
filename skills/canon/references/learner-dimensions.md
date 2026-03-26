# Learner Dimension Specifications

Reference material for `canon-learner`. Contains dimension specs, report template, and learning log schema.

---

## Dimension 1: Codebase Pattern Inference

**Goal**: Find repeated patterns in the codebase that aren't yet captured as conventions or principles.

### Pre-validated observations (primary source)

Call the `get_patterns` MCP tool to load pre-validated pattern observations logged by agents during normal work. Results are pre-grouped by pattern text with counts and file paths.

Use these as your primary source:
1. For patterns with count >= 3, verify they still hold (files may have changed since observation)
2. Check each against the baseline — skip if already a convention or principle

### Manual scanning (fill gaps)

Only do manual Grep scanning for pattern categories **not covered** by `get_patterns` results. For example, if `get_patterns` returns no naming convention patterns, scan for those manually. Use Grep and Glob across project source files (exclude `node_modules`, `.git`, `.canon`, `dist`, `build`):

1. **Error handling style** — Do functions throw exceptions, return Result/Either types, return null, use error codes? What's the dominant pattern?
2. **Validation patterns** — Is there a consistent validation library or pattern (Zod, Joi, manual checks)? Where does validation happen?
3. **Naming conventions** — File naming (kebab-case, camelCase, PascalCase), function naming, class naming, constant naming patterns
4. **Import patterns** — Barrel exports, relative vs absolute imports, import ordering
5. **Testing patterns** — Test framework (vitest, jest, pytest), test file location (co-located vs separate), assertion style
6. **API patterns** — Handler structure, middleware usage, response format consistency
7. **Type patterns** — TypeScript strict mode, type vs interface preference, generic patterns

### How to measure

For each pattern you observe:
1. Count how many files follow it vs. how many relevant files exist
2. Calculate consistency: `files_following / total_relevant_files`
3. Only report patterns with **consistency >= 70%** across **>= 5 relevant files**

### Inclusion threshold

Only include patterns with **>= 70% consistency** across **>= 5 relevant files**. Report the raw numbers (e.g., "23/28 files"); let the user judge confidence.

### Output per suggestion

```
**{Pattern name}** (confidence: {high|medium}, {N}/{M} files)
Observed: {what the pattern is, with a concrete example}
Suggest: Add to CONVENTIONS.md — "{one-line convention text}"
```

---

## Dimension 2: Drift-Driven Severity Adjustments

**Goal**: Use review history to suggest severity promotions, demotions, or revisions.

### Data sources

Call the `get_drift_report` MCP tool to get baseline stats: per-principle compliance rates, violation counts, intentional deviation counts, trend, never-triggered list, and hotspot directories.

For verdict-impact weighting (learner-specific), also call `get_decisions` to access the raw decision data for BLOCKING/WARNING categorization:
- Violations in BLOCKING reviews count 2x for severity analysis (they stopped builds)
- Violations in WARNING reviews count 1x (normal weight)
- A principle violated 3 times in BLOCKING reviews has the same signal as one violated 6 times in WARNING reviews

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

### Demotion safety

- **Never demote security-tagged rules** (check `tags:` in frontmatter). If a security rule has low compliance, suggest "investigate why" instead.
- **Minimum data**: 10 reviews for any suggestion, 15 for rule demotions. Below threshold → "insufficient data."
- Include `CAUTION: Demoting a rule means pre-commit hooks will no longer block this violation.` in any rule demotion suggestion.

### Output per suggestion

```
**{principle-id}** (current: {severity} → suggested: {new severity})
{compliance_rate}% compliance across {N} reviews, {M} intentional deviations
Suggest: {promote to X | demote to Y — reason | revise — reason | add exception for Z | flag as dead}
{CAUTION note if demoting a rule}
```

---

## Dimension 3: Task Convention Promotion

**Goal**: Find patterns in task-level conventions that should be promoted to project-level.

### Data source

- `.canon/plans/*/CONVENTIONS.md` — task conventions created by the architect agent during builds

### Analysis

1. Read all task convention files
2. Extract each convention line (bullets starting with `- **`)
3. Group semantically similar conventions (same category and similar pattern — use your judgment)
4. Count how many distinct builds each pattern appeared in

### Suggestion rules

- Pattern must appear in **>= 3 distinct builds** to suggest promotion
- Cross-check against `.canon/CONVENTIONS.md` — skip if already a project convention
- Cross-check against principle index — skip if already covered by a principle

### Output per suggestion

```
**{Pattern category}** (appeared in {N} builds)
Pattern: "{the convention text}"
Builds: {slug-1}, {slug-2}, {slug-3}
Suggest: Add to CONVENTIONS.md — "{convention text}"
```

---

## Dimension 4: Decision Cluster Analysis

**Goal**: Find patterns in why people override principles, and suggest principle revisions.

### Data source

Call the `get_decisions` MCP tool to get decisions pre-grouped by principle_id with category counts.

### Analysis

1. From the grouped results, focus on principles with count >= 3
2. **Use categories first**: The tool returns per-category counts. Categories with 3+ occurrences are strong clustering signals.
3. **Fall back to justification text**: For decisions in the "uncategorized" category, read justifications and identify recurring themes:
   - Same technical reason (e.g., "performance requires this", "legacy API constraint")
   - Same scope (all deviations in the same layer or file pattern)
   - Same exception pattern (e.g., "factory pattern justified when genuinely polymorphic")

### Decision categories

Decisions may include a `category` field with one of:
- `performance` — Deviation needed for performance reasons
- `legacy-constraint` — Existing code or API can't be changed
- `scope-mismatch` — Principle doesn't apply to this context
- `intentional-tradeoff` — Conscious tradeoff with documented reasoning
- `external-requirement` — External dependency or spec requires this
- `other` — Doesn't fit standard categories

When a category appears 3+ times for the same principle, it's a strong signal for a specific type of revision.

### Suggestion rules

| Signal | Suggestion |
|--------|------------|
| 3+ decisions with same category | Add a typed exception to the principle for that category |
| 3+ decisions with similar justification text (no category) | Add an exception to the principle documenting this case |
| All deviations in same layer/file pattern | Narrow the principle's scope to exclude that context |
| Majority of decisions are `scope-mismatch` | The principle's scope is too broad — suggest narrowing |
| Justifications contradict the principle's rationale | Revisit the principle — it may be wrong for this project |

### Output per suggestion

```
**{principle-id}** ({N} decisions, category: {top category or "mixed"})
Common justification: "{summarized theme}"
Files: {file patterns where deviations occur}
Suggest: {add exception for X | narrow scope to exclude Y | revisit rationale}
```

---

## Dimension 5: Convention Graduation

**Goal**: Identify mature conventions ready to become formal principles.

A convention in `.canon/CONVENTIONS.md` that has been stable, universally followed, and survived multiple builds is ready to graduate to a full principle with rationale, examples, and severity.

### Analysis

1. Read `.canon/CONVENTIONS.md` — extract each convention
2. For each convention, check:
   - **Age**: Is it present in the git history for a meaningful period? Check `git log --diff-filter=A -p .canon/CONVENTIONS.md` to find when it was added. Conventions added in the last build are too new.
   - **Codebase adherence**: Does the codebase actually follow this convention? Use Grep/Glob to verify the pattern holds across relevant files (same thresholds as Dimension 1: 70%+ consistency, 5+ files).
   - **Build survival**: Has this convention been carried through as a task convention in multiple builds? Check `.canon/plans/*/CONVENTIONS.md` for overlap.
   - **No violations**: Has this convention ever been contradicted in review data? Check if related principles were violated.

### Graduation criteria

All of these must be true:
- Convention has existed for **>= 5 builds** or been in `CONVENTIONS.md` for a meaningful period
- Codebase adherence is **>= 80%** across relevant files
- Convention has **never been contradicted** in review or decision data

### Output per suggestion

```
**{Convention text}** (ready for graduation)
Age: Present since {date or build count}
Adherence: {N}% across {M} files
Suggest: Ask Canon to create a new principle — starts an interactive interview to build a formal principle with rationale and examples
Proposed severity: {convention or strong-opinion based on whether it affects correctness}
```

---

## Dimension 6: Convention Staleness Detection

**Goal**: Identify conventions in `CONVENTIONS.md` that the codebase no longer follows.

### Analysis

1. Read `.canon/CONVENTIONS.md` — extract each convention
2. For each convention, determine what codebase pattern it describes
3. Use Grep/Glob to check if the pattern still holds:
   - Search for the pattern the convention describes
   - Search for contradicting patterns (e.g., if convention says "Use Zod", search for competing validation libraries)
4. Calculate current adherence

### Staleness criteria

A convention is stale if:
- Adherence has dropped **below 50%** across relevant files
- A competing pattern has emerged with **higher adoption** than the convention's pattern
- The convention references a tool/library/pattern that no longer exists in the codebase

### Output per suggestion

```
**{Convention text}** (stale)
Current adherence: {N}% across {M} files
Competing pattern: {what the codebase actually does now, if applicable}
Suggest: {update convention to match current practice | remove convention | investigate divergence}
```

---

## Report Template

Combine all suggestions into `.canon/LEARNING-REPORT.md`:

```markdown
## Canon Learning Report
Generated: {YYYY-MM-DD} | Reviews analyzed: {N} | Decisions analyzed: {N} | Source files scanned: {N}

### Suggested Conventions (from codebase patterns)
{Dimension 1 suggestions, or "No patterns found that aren't already captured." if none}

### Suggested Severity Changes (from drift data)

#### Promotions
{Promotion suggestions from Dimension 2, or "No promotions suggested." if none}

#### Demotions
{Demotion suggestions from Dimension 2, or "No demotions suggested." if none}

### Suggested Convention Promotions (from task conventions)
{Dimension 3 suggestions, or "No recurring task conventions found (need 3+ builds)." if none}

### Suggested Principle Revisions (from decision clusters)
{Dimension 4 suggestions, or "No decision clusters found (need 3+ decisions per principle)." if none}

### Convention Graduation Candidates
{Dimension 5 suggestions, or "No conventions ready for graduation." if none}

### Stale Conventions
{Dimension 6 suggestions, or "All conventions are current." if none}

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
  "dimensions": ["patterns", "drift", "conventions", "decisions", "graduation", "staleness"],
  "data_summary": {
    "reviews_analyzed": 0,
    "decisions_analyzed": 0,
    "source_files_scanned": 0,
    "task_conventions_read": 0
  },
  "suggestions": [
    {
      "id": "sug_{deterministic_hash}",
      "dimension": "drift",
      "type": "promote|demote|new-convention|promote-convention|revise-principle|graduate|stale",
      "target": "principle-id or convention text",
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
- Drift promotion of `validate-at-trust-boundaries` → `sug_drift:promote:validate-at-trust-boundaries` → take first 8 hex chars of a hash
- New convention about Zod validation → `sug_patterns:new-convention:zod-validation-at-api-boundaries` → take first 8

In bash (portable): `echo -n "drift:promote:validate-at-trust-boundaries" | md5sum | head -c 8`
(On macOS use `md5 -q` instead of `md5sum` if `md5sum` is unavailable.)

The key property: **the same suggestion always gets the same ID**, regardless of when or how many times the learner runs.

The `action` field starts as `"suggested"`. When the user acts on or dismisses a suggestion via `--apply`, the orchestrator updates it to `"applied"` or `"dismissed"`.

This log enables:
- Detecting recurring suggestions across runs
- Suppressing dismissed suggestions
- Tracking which suggestions were acted on
