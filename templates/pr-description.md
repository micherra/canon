---
template: pr-description
description: PR description synthesized from build artifacts
used-by: [canon-shipper]
output-path: ${WORKSPACE}/plans/${slug}/PR-DESCRIPTION.md
---

# Template: PR Description

```markdown
## Summary
{1-3 sentence description synthesized from task + design approach. Focus on WHAT and WHY, not HOW.}

## Changes
{Bulleted list of concrete changes, grouped by area. Extract from implementation summaries.}
- **{area}**: {what changed}
- **{area}**: {what changed}

## Design Decisions
{Only if DESIGN.md exists. 1-2 key decisions with brief rationale. Omit if fast-path flow.}

## Testing
- Tests written: {count from summaries + test report}
- Integration tests: {count from test report, or "N/A"}
- Coverage gaps filled: {count, or "N/A"}
- Review verdict: **{CLEAN/WARNING}**

## Security
{Only if SECURITY.md exists. "Clean" or brief summary of findings and resolutions.}

## Unresolved Concerns
<!-- REQUIRED when review verdict is WARNING or security status is not CLEAN (FINDINGS or CRITICAL). Omit only when review is CLEAN and security is CLEAN. -->
{Prominently list: unresolved review warnings, security findings, drift-from-plan issues, board concerns.}
- **Review**: {verdict and unresolved violations, or "Clean"}
- **Security**: {finding count and severities, or "Clean"}
- **Drift**: {unplanned files or missing work, or "None"}

## Notes
{Any additional concerns from board.json. Any skipped states. Anything a reviewer should watch for.}
{Omit this section entirely if there are no notes.}
```

## Rules

- Write for a human reviewer who hasn't seen the build process
- Be concrete and specific — no filler
- Tone: factual, not promotional
