---
template: wave-report
description: Structured wave execution report produced at the end of each wave. Consumed by the wave-steward skill for inter-wave analysis and next-wave prompt drafting.
used-by: [orchestrator]
read-by: [wave-steward, orchestrator]
output-path: ${WORKSPACE}/WAVE-REPORT.md
---

# Template: Wave Report

```markdown
## Wave Identity

- **Wave name**: {wave name, e.g. "v2.1b Wave 3 — runbook accumulation"}
- **Task IDs covered**: {comma-separated list, e.g. "NF-07, NF-08, NF-09"}
- **Branch**: {session branch name}

## Commits

<!-- List every commit produced in this wave, one per line. -->
- `{sha}` {one-line subject}
- `{sha}` {one-line subject}

## Exit Criteria

<!-- Copy each exit criterion from the wave prompt verbatim. Mark each PASS or FAIL. -->
- [ ] {criterion text} — {PASS / FAIL}
- [ ] {criterion text} — {PASS / FAIL}

## Verdict

<!-- One of: PASS, CONDITIONAL, FAIL. -->
**{PASS / CONDITIONAL / FAIL}**

<!-- Required when verdict is CONDITIONAL: list each condition explicitly. -->
Conditions:
- {condition text, or omit this block entirely when verdict is PASS or FAIL}

## Test Delta

<!-- Explicit zeroes required — do not omit when counts are zero. -->
- **Before**: {N} tests
- **After**: {N} tests
- **New regressions**: {0, or list failing test names}
- **New tests added**: {0 or count with brief description}

## PLAN Amendments

<!-- List changes made to any PLAN or INDEX documents during this wave. -->
{None, or bulleted list of amendments with document path and description}

## Findings

<!-- Severity: HIGH / MEDIUM / LOW / INFORMATIONAL -->
- **[{SEVERITY}]** {description of finding}
- **[{SEVERITY}]** {description of finding}

## Remediations Filed

<!-- List new follow-up tasks created during this wave. Include task ID and any dependency edges. -->
- `{task-id}` — {description} *(blocks: {task-id}, or "none")*

## Blockers

<!-- Anything preventing the next wave from starting. -->
{None, or bulleted list of blockers with blocking gate or dependency noted}

## PR

- **PR**: #{number} — {link}
```

## Rules

- Write this report immediately after the wave's final commit
- Every exit criterion from the wave prompt must appear in the checklist — do not omit failures
- Verdict must match the evidence in the exit criteria checklist
- Include test delta even if 0/0 — explicit zeroes prevent ambiguity
