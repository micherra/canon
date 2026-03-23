---
fragment: impl-handoff
type: consultation
description: Architect produces implementation overview for downstream test, security, and review agents
agent: canon-architect
role: impl-handoff
artifact: IMPL-OVERVIEW.md
timeout: 5m
---

## Spawn Instructions

### impl-handoff
Summarize the full implementation across all waves for: ${task}.
All summaries: ${all_summaries}
Design: ${WORKSPACE}/plans/${slug}/DESIGN.md

Produce for downstream agents (tester, security, reviewer):
- Key patterns and conventions used across implementation
- Shared code and utilities created
- Known gaps or areas not fully tested by implementors
- Risk areas that need extra scrutiny
- Architectural decisions that reviewers should validate

Max 300 tokens. No code — advisory only.
