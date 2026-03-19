---
template: test-report
description: Structured format for tester outputs
used-by: [canon-tester]
---

# Template: Test Report

Use this template when producing test reports after test execution.

```markdown
---
status: "{ALL_PASSING|IMPLEMENTATION_ISSUE|BLOCKED}"
agent: canon-tester
timestamp: "{ISO-8601}"
tests-run: {N}
tests-passed: {N}
tests-failed: {N}
---

## Test Report — Status: {status}

### Tests Written
| Test File | Count | Focus |
|-----------|-------|-------|
| `path/to/file.test.ts` | {N} | {integration, coverage gap, edge case} |

### Issues Found
<!-- Only if status is IMPLEMENTATION_ISSUE. Omit section if all tests pass. -->
<!-- The orchestrator reads this table to determine fix-impl inputs. -->
| File | Failing Test | Root Cause | Suggested Fix |
|------|-------------|------------|---------------|
| `path/to/source.ts` | `test description` | {root cause analysis} | {suggested fix approach} |

### Coverage Gaps Filled
<!-- Which gaps from implementor Coverage Notes were addressed. -->
- {function/endpoint}: {gap} — now tested via `{test name}`

### Risk Mitigations Verified
<!-- Cross-reference with implementor's Risk Mitigation Tests section. -->
| Risk Item | Source | Test | Result |
|-----------|--------|------|--------|
| {risk item} | {PLAN / implementor} | `{test name}` | {PASS/FAIL/NOT_TESTED} |

### Remaining Gaps
<!-- Gaps the tester could not fill and why. -->
- {gap}: {reason — e.g., requires manual testing, needs staging environment}

### Concerns
<!-- Only if there are non-blocking observations. -->
- {concern}
```

## Rules

- Status must be one of the three defined values
- Issues Found table is mandatory when status is IMPLEMENTATION_ISSUE — the fix-impl state reads it
- Always start by reading implementor Coverage Notes from *-SUMMARY.md
- Keep under 500 tokens
