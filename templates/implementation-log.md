---
template: implementation-log
description: Structured format for implementor task summaries
used-by: [canon-implementor]
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
- Keep under 400 tokens
- Concerns and Blockers sections only appear when relevant
