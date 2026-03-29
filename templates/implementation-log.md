---
template: implementation-log
description: Structured format for implementor task summaries
used-by: [canon-implementor, canon-fixer]
read-by: [canon-tester, canon-reviewer, canon-scribe, canon-shipper]
output-path: ${WORKSPACE}/plans/${slug}/SUMMARY.md
---

# Template: Implementation Log

Use this template when producing the task summary after implementation. This replaces the raw SUMMARY.md format with a standardized structure.

```markdown
---
task-id: "{slug}-{NN}"
status: "{DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT}"
agent: canon-implementor
timestamp: "{ISO-8601}"
commit: "{hash}"
---

## Implementation: {task-id}

### What Changed
<!-- Brief description of what was implemented. -->
{description}

### Files
| File | Action | Purpose |
|------|--------|---------|
| `path/to/file.ts` | created/modified | {purpose} |

### Tests Written
| Test File | Count | Coverage |
|-----------|-------|----------|
| `path/to/file.test.ts` | {N} | happy path, error cases |

### Coverage Notes
<!-- What's tested, what's NOT tested, and why. The tester reads this section first. -->
#### Tested Paths
- {function/endpoint}: happy path, error return, {specific edge case}

#### Known Gaps
<!-- Be honest about what you didn't test. The tester will fill these. -->
- {function/endpoint}: {untested path} — {reason: not in plan scope / time constraint / needs integration test}

#### Risk Mitigation Tests
<!-- If the plan had a ### Risk mitigations section, list which ones you tested. -->
- {risk item}: tested via {test name} — {PASS/FAIL}
- {risk item}: NOT tested — {reason, e.g., requires integration setup}

#### External Evidence
<!-- Only include if web research materially informed implementation choices. -->
- `{URL}` — {what implementation decision, API usage, or constraint this source informed}

### Canon Compliance
<!-- One line per principle from the plan. -->
- **{principle-id}** ({severity}): {✓ COMPLIANT|⚠ JUSTIFIED_DEVIATION|✗ VIOLATION_FOUND → FIXED} — {detail}

### Verification
- [ ] New tests: {N} passing
- [ ] Full test suite: passing
- [ ] {additional verification steps}

### Concerns
<!-- Only if status is DONE_WITH_CONCERNS. Otherwise omit this section. -->
- {concern}

### Blockers
<!-- Only if status is BLOCKED. Otherwise omit this section. -->
- {what's blocking and what input is needed}
```

## Rules

- Write this summary immediately after committing
- Status must be one of the four defined values — no custom statuses
- Canon compliance section is mandatory — every principle in the plan must appear
- Concerns and Blockers sections only appear when relevant
- Include `External Evidence` only when web research materially informed implementation choices
