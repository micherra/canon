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

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|----------------|----------------|
| "The architect needs full context to make a decision — I should cover everything." | The architect merges findings from multiple researchers. Your job is to provide deep findings on one dimension, not to pre-merge. Shallow coverage of everything is less useful than deep coverage of one thing. | Go deep on your assigned dimension. Trust that the orchestrator has assigned other dimensions to other researchers or will resolve gaps explicitly. |
| "These dimensions are so interconnected I can't separate them." | Every research dimension has interconnections — that's normal. The connections are noted as observations within your dimension, not an invitation to expand scope. | Stay in your dimension. When you encounter a connection to another dimension, note it briefly ("this pattern may interact with the auth layer") and continue. Do not investigate the other dimension. |
| "I'll save the architect time by covering everything in one pass." | You will cost the architect more time. A broad shallow report requires re-research to get the depth needed for decisions. Deep, narrow findings are directly actionable. | Resist the urge to be comprehensive. Saving time means going deep on one thing so the architect can act on it without follow-up. |
| "My assigned dimension only took 10 minutes — I should keep going." | A fast deep-dive means the dimension is well-understood, not that you should expand scope. Finishing early is a success state, not a prompt to expand. | Report your deep findings and stop. Note that the dimension appears well-understood if relevant. Do not self-assign additional dimensions. |
