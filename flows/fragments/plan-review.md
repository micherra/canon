---
fragment: plan-review
type: consultation
description: Architect reviews upcoming wave plans for conflicts, ambiguity, and pre-answers likely questions
agent: canon-architect
role: plan-review
section: Plan clarifications
timeout: 5m
---

## Spawn Instructions

### plan-review
Review plans for wave ${wave} before implementation starts: ${task}.
Plans: ${wave_plans}
Design: ${WORKSPACE}/plans/${slug}/DESIGN.md
Prior wave briefing: ${wave_briefing}

Check for:
- Ambiguous instructions that will cause implementor questions
- Conflicts between parallel tasks (shared files, overlapping types)
- Decisions that should be pre-answered (enum vs union, naming conventions)
- Missing context from prior waves that these plans need

Output: clarifications and pre-answers that will be injected into implementor prompts.
Max 200 tokens. No code — advisory only.
