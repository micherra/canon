---
template: review-checklist
description: Structured format for review outputs
used-by: [canon-reviewer]
---

# Template: Review Checklist

Use this template when producing review reports for the workspace.

```markdown
---
verdict: "{BLOCKING|WARNING|CLEAN}"
agent: canon-reviewer
timestamp: "{ISO-8601}"
files-reviewed: {N}
principles-checked: {N}
---

## Canon Review — Verdict: {verdict}

### Principle Compliance

#### Violations
<!-- Ordered by impact score (highest first). Omit section if none. -->
| Principle | Severity | File | Description | Fix |
|-----------|----------|------|-------------|-----|
| {id} | {rule/strong-opinion/convention} | `path:line` | {what violates} | {how to fix} |

#### Honored
<!-- Brief notes on principles the code follows well. -->
- **{principle-id}**: {how honored}

#### Score
| Layer | Rules | Opinions | Conventions |
|-------|-------|----------|-------------|
| {layer} | {X}/{Y} | {X}/{Y} | {X}/{Y} |

### Code Quality (Advisory)

#### Suggestions
- **{category}**: {observation and suggestion}

#### Strengths
- {positive observation}

### Graph Context
<!-- Only if graph_context was available. Otherwise omit. -->
- **Hub impact**: {observations about high fan-in files}
- **Cycles**: {observations about circular dependencies}
- **Layer boundaries**: {observations about cross-layer imports}

### Compliance Cross-Check
<!-- Only during /canon:build when implementor summaries are available. Omit for standalone /canon:review. -->
<!-- Read *-SUMMARY.md AFTER completing Stages 1 and 2. Do not revise earlier findings. -->

#### Discrepancies
| Principle | Implementor Declared | Reviewer Found | Assessment |
|-----------|---------------------|----------------|-----------|
| {id} | ✓ COMPLIANT | VIOLATED | {detail} |

#### Incomplete Fixes
- **{principle-id}**: {detail of remaining issue}

#### Cross-Check Summary
<!-- "All declarations aligned" or "N discrepancies found — implementor may have misunderstood {principle-ids}" -->
{summary}
```

## Rules

- Verdict is always the first thing in the document — reviewers reading this need to know immediately
- Violations ordered by impact (rule > strong-opinion > convention, then by impact score)
- The reviewer never reads research or plans — this template enforces cold review
- Graph context section only appears when `review_code` returned graph data
- Keep under 600 tokens
