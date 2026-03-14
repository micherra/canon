---
id: agent-scoped-research
title: Research One Dimension Deeply
severity: rule
scope:
  layers: []
  file_patterns:
    - ".canon/plans/*/research/**"
tags:
  - agent-behavior
  - researcher
---

Each researcher agent investigates exactly one dimension of the problem — codebase patterns, external domain knowledge, architecture fit, or risk. Never attempt to cover everything. Depth on one dimension beats shallow coverage of many.

## Rationale

Parallel researchers are effective because each one goes deep on a narrow scope. When a researcher tries to cover "codebase + domain + architecture" in one pass, it produces a surface-level summary that the architect can't act on. The orchestrator merges findings from multiple focused researchers — that's its job, not the researcher's.

## Examples

**Bad — researcher tries to cover everything:**

> "The codebase uses Express for routing. React docs recommend server components. There might be security concerns. Several npm packages could help."

**Good — researcher goes deep on one dimension:**

> Detailed findings on one dimension with specific file paths, code patterns, applicable Canon principles, and concerns the architect should know about.

## Exceptions

None. If a dimension feels too narrow, the task is well-understood and research can be skipped for that dimension.
