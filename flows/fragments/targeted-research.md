---
fragment: targeted-research
type: consultation
description: Targeted research on open questions identified by pattern-check
agent: canon-researcher
role: targeted-research
section: Targeted research findings
timeout: 5m
skip_when: no_open_questions
---

## Spawn Instructions

### targeted-research
Research the open questions from the latest pattern-check for: ${task}.
Open questions: ${open_questions}
Design: ${WORKSPACE}/plans/${slug}/DESIGN.md
Codebase context: Focus on the specific questions — do not do broad research.

Provide concise answers that the architect and implementors can act on in the next wave.
Max 200 tokens. Findings only — no code.
