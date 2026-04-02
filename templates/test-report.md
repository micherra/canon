---
template: test-report
description: Structured format for tester outputs
used-by: [canon-tester]
read-by: [canon-shipper]
output-path: ${WORKSPACE}/plans/${slug}/TEST-REPORT.md
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

### Architect Risk Coverage
<!-- Only when plan files exist at ${WORKSPACE}/plans/${slug}/. Otherwise note "No plan files available — architect risk check skipped." -->
<!-- Cross-reference architect's ### Risk mitigations sections against actual coverage. -->
| Architect Risk | Plan File | Implementor Covered | Tester Covered | Status |
|---------------|-----------|--------------------:|---------------:|--------|
| {risk from plan} | {DESIGN.md / task-plan} | {YES/NO/PARTIAL} | {YES/NO/N/A} | {COVERED/GAP} |

<!-- If all architect risks are covered: "All architect-specified risks have test coverage." -->

### Remaining Gaps
<!-- Gaps the tester could not fill and why. -->
- {gap}: {reason — e.g., requires manual testing, needs staging environment}

### Concerns
<!-- Only if there are non-blocking observations. -->
- {concern}
```

## Rules

- Issues Found table is mandatory when status is IMPLEMENTATION_ISSUE — the fix-impl state reads it
