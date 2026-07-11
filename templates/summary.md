---
template: summary
description: Structured format for implementor task summaries
used-by: [implementor, fixer]
read-by: [tester, reviewer, scribe, shipper]
output-path: ${WORKSPACE}/plans/${slug}/{task_id}-SUMMARY.md
---

# Template: Implementation Summary

Use this template when producing the task summary after implementation. The output file name follows the `{task_id}-SUMMARY.md` convention (e.g., `my-task-01-SUMMARY.md`).

```markdown
---
task-id: "{slug}-{NN}"
status: "{DONE|DONE_WITH_CONCERNS|BLOCKED|NEEDS_CONTEXT}"
agent: implementor
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

#### Criteria Coverage
<!-- Map every acceptance criterion from the task plan to what was implemented. -->
<!-- The reviewer checks this section in Stage 3 (compliance cross-check). -->
<!-- Reproduction column: a runnable shell command proving the criterion holds, for every mechanically-verifiable AC (reviewer taxonomy: MCP-tool / Structural; architect: mechanical) — a scoped test, curl against the running app, CLI call, or grep assertion. Non-runnable ACs (manual/non-automatable, or not runtime-observable) carry the sanctioned `n/a — <reason>` marker instead (e.g. `n/a — not runtime-observable (pure refactor)`, `n/a — manual (requires human judgment)`). Never fabricate a command to fill the column. A literal `|` inside a command must be written `&#124;` (the same escape `escapeMdCell` uses) — this is a DISPLAY-ONLY escape for markdown-table parseability, NOT the command's executable form. Any consumer that executes or promotes the recorded command MUST decode `&#124;` back to `|` first (e.g. `sed 's/&#124;/|/g'`); running the raw `&#124;`-containing literal in a shell does not pipe. Prefer a pipe-free form (`grep -c X f` over `grep X f | wc -l`) whenever possible — it avoids the escape/decode round-trip entirely. -->
| # | Task plan criterion | Disposition | Implementation or rationale | Reproduction |
|---|---------------------|-------------|----------------------------|--------------|
| 1 | {criterion from task plan} | {covered &#124; descoped &#124; partial} | {what was implemented, or why it's deferred} | `{runnable command}` or `n/a — {reason}` |

#### External Evidence
<!-- Only include if web research materially informed implementation choices. -->
- `{URL}` — {what implementation decision, API usage, or constraint this source informed}

### Canon Compliance

| Principle | Status | Notes |
|-----------|--------|-------|
| {principle-id} | honored / violated / n/a | {brief note} |

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
- Criteria Coverage Reproduction column: every mechanically-verifiable AC MUST carry a runnable command; every non-runnable AC MUST carry an `n/a — <reason>` marker — never a fabricated command
- A literal `|` in a Reproduction command must be written `&#124;`, or use a pipe-free form. `&#124;` is a table-display escape only — the command's canonical/executable form uses a real `|`. Any consumer that executes or promotes the recorded command must decode `&#124;` → `|` first (`sed 's/&#124;/|/g'`); do not run the raw `&#124;` literal in a shell — it does not pipe
