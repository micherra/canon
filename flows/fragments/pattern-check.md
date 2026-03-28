---
fragment: pattern-check
type: consultation
description: Architect reviews wave output for pattern drift and convention consistency
agent: canon-architect
role: pattern-check
section: Pattern review
timeout: 5m
min_waves: 2
---

## Spawn Instructions

### pattern-check
Review wave ${wave} implementation summaries for: ${task}.
Summaries: ${wave_summaries}
Files changed this wave: ${wave_files}
Design: ${WORKSPACE}/plans/${slug}/DESIGN.md
Done criteria: Read the North Star section of DESIGN.md for the epic's done criteria.

Check for:
- Pattern drift from the design
- Inconsistent conventions between tasks
- Opportunities to share code in next wave
- Whether any done criteria are now met

If the remaining plan needs adjustment, include a `## Proposed Events` section with one or more entries in this format:

```
- type: add_task
  detail: "Description of what to add and why"
- type: skip_task
  detail: "task-id: reason to skip"
- type: reprioritize
  detail: "Reorder description and rationale"
```

If there are open technical questions that would benefit from targeted research before the next wave, include an `## Open Questions` section listing them.

If all done criteria from the North Star section are met, state "All done criteria are met" clearly.

Max 300 tokens. No code — advisory only.
