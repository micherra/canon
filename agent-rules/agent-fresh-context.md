---
id: agent-fresh-context
title: Fresh Context, Atomic Commits
severity: rule
scope:
  layers: []
tags:
  - agent-behavior
  - implementor
---

Each implementor agent executes in a fresh context with only its plan, relevant Canon principles, and CLAUDE.md. It commits its own work atomically — one task, one commit. The implementor never reads other tasks' plans, summaries, or the session history.

## Rationale

Context rot is the #1 cause of quality degradation in AI-generated codebases. After 50k+ tokens of accumulated context, the agent starts forgetting earlier instructions, generating inconsistent code, and losing track of the overall design. Fresh context per task eliminates this entirely. Atomic commits make each task independently revertable and bisectable.

## Examples

**Bad — implementor accumulates context from previous tasks:**

```
Orchestrator: "Here's task 3. For context, here's what tasks 1 and 2 did:
[5000 tokens of summaries]. Also here's the full design doc: [3000 tokens].
And the research findings: [4000 tokens]."
```

**Good — implementor gets only what it needs:**

```
Orchestrator spawns implementor with:
- The plan file (self-contained, ~500 tokens)
- 2 Canon principles (full body, ~1500 tokens)
- CLAUDE.md (~500 tokens)
- Filesystem access to read existing code as needed
Total context load: ~2500 tokens. 197k tokens free for work.
```

## Exceptions

If two tasks are so tightly coupled they can't be implemented independently (e.g., both modify the same function), the planner should merge them into one task rather than having two implementors coordinate. Coordination between implementors violates fresh context.
