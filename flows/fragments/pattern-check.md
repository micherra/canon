---
fragment: pattern-check
type: consultation
description: Architect reviews wave output for pattern drift and convention consistency
agent: canon-architect
role: pattern-check
section: Pattern review
timeout: 5m
---

## Spawn Instructions

### pattern-check
Review wave ${wave} implementation summaries for: ${task}.
Summaries: ${wave_summaries}
Files changed this wave: ${wave_files}
Design: ${WORKSPACE}/plans/${slug}/DESIGN.md

Check for: pattern drift from the design, inconsistent conventions between tasks,
opportunities to share code in next wave. Report corrections and recommendations.
Max 200 tokens. No code — advisory only.
