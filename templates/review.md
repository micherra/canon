---
template: review
description: Structured format for review outputs
used-by: [reviewer]
read-by: [shipper]
output-path: ${WORKSPACE}/reviews/
---

# Template: Review Checklist

Use this template when producing review reports for the workspace.

```markdown
---
verdict: "{BLOCKING|WARNING|CLEAN}"
agent: reviewer
timestamp: "{ISO-8601}"
files-reviewed: {N}
principles-checked: {N}
ac-criteria-verified: {N}
ac-criteria-passed: {N}
---

## Canon Review — Verdict: {verdict}

### Principle Compliance

#### Violations
<!-- Ordered by impact score (highest first). Omit section if none. -->
| Principle | Severity | Location | Confidence | Description | Fix |
|-----------|----------|----------|------------|-------------|-----|
| {id} | {rule/strong-opinion/convention} | `path:line` | {HIGH\|MEDIUM\|LOW\|INSUFFICIENT\|—} | {what violates} | {how to fix} |

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

### Public API Documentation (Advisory)
<!-- Only for files with exported symbols in the diff. Omit section if no findings. -->
- `path:line` — `symbolName`: {finding}

### Gotcha Documentation (Advisory)
<!-- Flag non-obvious behavior not already covered by Stage 1 violations. Omit section if no findings. -->
- `path:line` — {behavior}: {why non-obvious}

### Graph Context
<!-- Only if graph_context was available. Otherwise omit. -->
- **Hub impact**: {observations about high fan-in files}
- **Cycles**: {observations about circular dependencies}
- **Layer boundaries**: {observations about cross-layer imports}

### Compliance Cross-Check
<!-- Only during build pipelines when implementor summaries are available. Omit for standalone reviews. -->

#### Discrepancies
<!-- Implementor self-declared compliant, but reviewer found a violation. -->
| Principle | Implementor Declared | Reviewer Found | Assessment |
|-----------|---------------------|----------------|-----------|
| {id} | ✓ COMPLIANT | VIOLATED | {detail} |

#### Unnecessary Deviations
<!-- Implementor declared deviation, but reviewer sees no need for it. -->
- **{principle-id}**: Implementor justified deviation but code appears compliant. The deviation may be unnecessary.

#### Confirmed Fixes
<!-- Implementor declared VIOLATION_FOUND → FIXED, reviewer confirms fix is complete. -->
- **{principle-id}**: Fix confirmed — {detail}

#### Incomplete Fixes
<!-- Implementor declared VIOLATION_FOUND → FIXED, but reviewer still finds a violation. -->
- **{principle-id}**: {detail of remaining issue}

#### Cross-Check Summary
<!-- "All declarations aligned" or "N discrepancies found — implementor may have misunderstood {principle-ids}" -->
{summary}

### Drift from Plan
<!-- Only when architect plan files exist in ${WORKSPACE}/plans/${slug}/. Otherwise note "No plan files available — Stage 4 skipped." -->

**Unplanned files changed:**
<!-- Files in git diff but NOT mentioned in any plan file. Omit section if none. -->
- `path/to/file.ts` — not mentioned in plan files; review for scope creep

**Missing planned work:**
<!-- Files mentioned in plan files but NOT in git diff. Omit section if none. -->
- `path/to/other.ts` — plan files specified changes here; none found in diff

<!-- If no drift: "No drift detected — all changed files match the plan file scope." -->

### Acceptance Criteria Verification
<!-- Only during build pipelines when a runbook exists. Otherwise note "Stage 5 skipped -- no runbook available." -->
<!-- Evidence comes from MCP tool calls, Bash, Grep, Read — not from a test file. -->

| # | Acceptance Criterion | Method | Result | Evidence |
|---|---------------------|--------|--------|---------|
| 1 | {criterion from runbook} | {e.g., "graph_query search" / "Grep for pattern" / "Read file"} | {PASS/FAIL/SKIP} | {relevant excerpt from tool response or command output, or skip rationale} |

<!-- If all pass: "All acceptance criteria verified." -->
<!-- If any fail: "N of M acceptance criteria failed — see details above." -->

### Build Verification
<!-- Required — run npm run build, npm run lint, npm test. Record baseline from target branch. Only new errors (delta) are BLOCKING/WARNING. Pre-existing errors tagged [baseline]. -->
| Check | Command | Exit Code | Error Count | Baseline | New Errors |
|-------|---------|-----------|-------------|----------|------------|
| TypeScript | `npm run build` | {0/non-zero} | {n} | {baseline_n} | {delta} |
| Lint | `npm run lint` | {0/non-zero} | {n} | {baseline_n} | {delta} |
| Tests | `npm test` | {0/non-zero} | {pass}/{total} | — | — |
```

## Rules

- Verdict is always the first thing in the document — reviewers reading this need to know immediately
- Violations ordered by impact (rule > strong-opinion > convention, then by impact score)
- The reviewer never reads research or plans during Stages 1-2 (cold review) — plan files (DESIGN.md, INDEX.md) are read only in Stage 4 for drift detection, not for cold review context
- Graph context section only appears when `review_code` returned graph data
- Keep concise — favor tables over prose
