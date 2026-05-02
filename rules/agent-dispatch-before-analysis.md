---
id: agent-dispatch-before-analysis
title: Dispatch Before Analysis — No Self-Produced Substantive Output
severity: rule
scope:
  agents: [orchestrator]
tags: [agent-behavior, orchestrator, dispatch]
---

The orchestrator must not produce substantive analytical output — root-cause analysis, design tradeoff evaluations, research summaries, implementation plans — in its own response text. These are specialist-agent deliverables. Writing them directly is the text-output equivalent of calling `Read` or `Edit` to do agent work: the same dispatch violation, just without a tool call to intercept.

## Rule

Before producing a response that contains multi-paragraph analysis, investigation findings, design evaluation, or structured recommendations, ask: *"Is this output on the Silent Dispatch allowlist?"* The allowlist is defined in CLAUDE.md's Silent Dispatch section (items 1–6: classification sentence, HITL presentations, progress lines, wave summaries, completion summaries, error presentations).

If the output is not on that list, it is agent work. Spawn the appropriate specialist instead of writing it yourself.

## Rationale

Pre-Research Gate (L1) blocks the orchestrator from using `Read`, `Bash`, `Grep`, or `Glob` to investigate before spawning a planner. Pre-Write Gate (L1) blocks the orchestrator from using `Edit` or `Write` outside a Canon flow. Both gates enforce the same principle: the orchestrator is a pure dispatcher.

Text generation is not interceptable by hooks — Claude Code's PreToolUse hooks fire on tool calls, not on text generation. This means no L4 backstop exists for this failure mode. Enforcement is entirely behavioral. The rule fills that gap by making the self-check explicit.

Without this rule, the orchestrator can silently substitute for a researcher or architect just by typing. The output reaches the user, the specialist agent is never spawned, and the Canon flow is bypassed with no audit trail and no artifact written to the workspace.

## Examples

**Bad — orchestrator writes an RCA instead of spawning a planner:**

```
User: "The payment flow is failing in prod — can you figure out why?"

Orchestrator: "Based on the error pattern, this is likely caused by a race condition
in the session token refresh cycle. The token refresh fires asynchronously when the
payment intent is created, and if the refresh completes after the intent validation
step, the session is invalidated mid-flow. To fix this, the token refresh should be
awaited before creating the payment intent..."
```

The orchestrator has produced a root-cause analysis and fix proposal. No planner was spawned. No workspace artifact was written. The orchestrator did agent work in plain text.

**Bad — orchestrator evaluates design tradeoffs instead of spawning an architect:**

```
User: "Should we use Redis or Postgres for the job queue?"

Orchestrator: "Redis is better for high-throughput queues because its in-memory
model gives sub-millisecond enqueue latency. Postgres advisory locks work well for
lower-volume queues where durability matters more. Given your current load profile,
I'd recommend Redis with a dead-letter queue backed by Postgres..."
```

This is an architecture recommendation. It belongs to the architect agent, not the orchestrator's response text.

**Good — orchestrator classifies and dispatches:**

```
User: "The payment flow is failing in prod — can you figure out why?"

Orchestrator: "Investigating the payment failure."
[spawns canon:planner with the investigation task]
```

One classification sentence. Agent spawned. Specialist does the analysis and writes findings to the workspace.

**Good — orchestrator presents a HITL checkpoint with specialist findings:**

```
Orchestrator: "The planner identified a session token race condition as the root
cause. Here are the findings: [presents planner artifact]. Proceed with the fix?"
```

The orchestrator is presenting a specialist's output at a HITL breakpoint — an allowlisted output type. It is not generating the analysis itself.

## Exceptions

The Silent Dispatch allowlist (CLAUDE.md, Silent Dispatch section, items 1–6) defines the full set of permitted orchestrator output during a build flow.

**Question and chat intents** are exempt. When the orchestrator classifies intent as `question` or `chat` (per the Intent Classification table), it responds directly and may produce multi-paragraph explanatory output. This gate applies only while executing a build flow — it does not restrict direct responses to non-build intents.
