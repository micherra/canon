---
id: agent-surface-assumptions
title: Surface Assumptions Explicitly
severity: rule
scope:
  layers: []
tags:
  - agent-behavior
  - planner
  - architect
---

Before finalizing findings or a design, explicitly list the assumptions that shaped the work. Include this block in the output document, immediately after the summary:

```
ASSUMPTIONS:
1. [assumption about requirements]
2. [assumption about architecture]
3. [assumption about constraints]
→ These assumptions shape everything below. Correct them before proceeding.
```

## Rationale

Readers use research findings and design documents to make decisions. If an assumption is wrong, every conclusion built on it is wrong. Surfacing assumptions at the top of the document makes HITL checkpoints actionable — the user can correct wrong assumptions before the architect builds a plan on them, or before the implementor acts on one.

Silent assumptions are the most expensive kind: they're invisible until something breaks, and by then the cost to unwind is high.

## Exceptions

None. If you have no assumptions, say so explicitly: `ASSUMPTIONS: none — all requirements and constraints are specified in the task.`
