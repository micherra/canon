---
id: agent-budget-checkpoint
title: Budget-Aware Checkpointing
severity: strong-opinion
tags: [agent-behavior, budget, resilience]
scope:
  agents: [engineer, reviewer, architect, scribe, shipper, learner]
---

# Budget-Aware Checkpointing

Agents must write partial artifacts at regular intervals relative to their turn budget to prevent lost work on context exhaustion or session termination.

## Rule

Your spawn prompt includes `turn_budget: N` (the maxTurns value for your role). Use it to pace your work:

### At ~50% budget: Progress checkpoint

Write a partial artifact to your declared output path. Include:
- What is complete so far (files modified, tests written, stages finished)
- What remains (files not yet touched, stages pending)
- Current status: `[CHECKPOINT — {N}% complete, {remaining items} remaining]`

This checkpoint ensures re-spawn enrichment has concrete prior-progress data if the session ends unexpectedly.

### At ~75% budget: Wrap-up mode

Stop starting new workstreams. Focus on:
1. Complete the current unit of work (finish the file you're editing, close the test you're writing)
2. Commit what you have (`wip({task-id}): partial progress`)
3. Write your summary artifact with honest coverage notes — mark incomplete items explicitly
4. Report `PARTIAL_FIX` or `DONE_WITH_CONCERNS` with detail on what remains

A partial artifact with honest coverage is infinitely more useful than no artifact at all.

### Budget estimation

You cannot query your exact turn count. Estimate based on work volume:
- Count major work units in your plan (files to edit, stages to run, tests to write)
- Track which units you have completed
- When roughly half are done, write the 50% checkpoint
- When roughly three-quarters are done or you sense the session is getting long, enter wrap-up

## Relationship to `agent-artifact-write-before-return`

That rule requires writing all declared artifacts before returning your terminal status. This rule extends the same principle earlier in the session — write partial artifacts at checkpoints, not just at the end. The two rules are complementary: this one prevents lost work mid-session; that one prevents lost work at session end.

## Relationship to reviewer Early Output Protocol

The reviewer already implements a version of this pattern via its Early Output Protocol (stub artifact before Stage 1, partial after Stage 1, partial after Stage 3). This rule generalizes that pattern to all agents.

## Examples

**Bad — agent runs out of budget with no artifacts written:**

```
[Turn 1-45: reads files, writes code, runs tests]
[Turn 46-50: still writing code...]
[Session terminated — no summary, no commits, no artifacts]
```

Re-spawn has zero context. The entire session's work is lost.

**Good — agent checkpoints at regular intervals:**

```
[Turn 1-25: reads plan, edits 3 of 6 files, writes tests]
[Turn 25: writes partial summary — "3/6 files complete, tests passing for completed files"]
[Turn 26-40: edits 2 more files]
[Turn 38: enters wrap-up — commits partial work, writes summary with 5/6 files complete]
[Turn 40: reports DONE_WITH_CONCERNS — "1 file remaining: src/utils/parser.ts"]
```

Re-spawn receives: "5/6 files complete, only src/utils/parser.ts remaining."

## Exceptions

- Agents with very short budgets (scribe at 70 turns, shipper at 60 turns) where the work is typically completable well within budget may skip the 50% checkpoint if the task is straightforward. The 75% wrap-up behavior still applies.
- The reviewer's existing Early Output Protocol satisfies this rule's intent — the reviewer does not need to add additional checkpoint logic beyond what it already does.
