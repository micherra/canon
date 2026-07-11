---
id: agent-semantic-self-review
title: Semantic Self-Review Before Returning
severity: rule
scope:
  agents: [engineer]
tags:
  - agent-behavior
  - engineer
---

Before reporting terminal status, the engineer performs a SEMANTIC self-review of its own diff — a reading-comprehension judgment over the actual source, not a mechanical check. This applies in both modes: **implementation mode**, where it is a new self-review step the engineer currently lacks; and **fix mode**, where it sharpens the existing Step 6 self-review (`agent-integration-boundary-check`'s neighbor) to the three named axes below rather than leaving "does the fix address the issue?" unstructured.

## The three axes

1. **Intent-satisfaction** — does the change actually accomplish what the task or plan INTENDED, not merely compile or pass the tests that were written for it? Re-read the task's Action/Done-when section and ask whether the diff satisfies the intent behind it, not just its literal words.
2. **Edge-cases** — does it handle the boundary, error, empty, and concurrent conditions the intent implies, even ones the plan didn't spell out?
3. **Contract-consistency** — is the change consistent with the signatures, invariants, and error-handling conventions of the code it touches? Would a maintainer reading the surrounding file recognize this as belonging to it?

State a short 3-axis result in the return (or summary — see `templates/summary.md` `#### Semantic Self-Review`): a sentence per axis is enough. Silence on an axis is not an acceptable substitute for stating it was checked.

## Negative scope — this is NOT the evaluator gate

This rule governs a SEMANTIC judgment made by the engineer, on live source, before returning, while context is warm. It is deliberately distinct from the automated **evaluator gate** (`agents/evaluator.md`, the post-implement/fix quality gate in root `CLAUDE.md` → Post-Step Effects), which is:

- **STRUCTURAL / regex-pattern**: it consumes a pre-computed `EvaluateStepOutput` — `PatternFinding[]` (lazy/hacky/`todo`/`fixme`/`as-any`/`ts-ignore`/bare-catch markers), file-scope drift (declared-vs-actual overlap), and diff stats. It never sees source.
- **Orchestrator-side, Haiku, fail-open, AFTER the engineer returns** — a fresh agent with no memory of writing the code.

Do NOT re-count lazy/hacky markers, do NOT re-derive scope-drift file overlap, and do NOT restate the evaluator's four structural dimensions here — that is the evaluator's job, running separately afterward. This rule asks only the three semantic questions above. The boundary is clean on two orthogonal axes — signal type (structural/regex vs. semantic/intent) and who/when/context (orchestrator Haiku on pre-extracted signals after return vs. the engineer on live source before return) — so there is no overlap to reconcile.

## Rationale

The evaluator structurally cannot judge whether code *means* the right thing — it never reads source, only markers and stats. The engineer is uniquely positioned to make that judgment: it just wrote the change and holds the full task and source in view. The reviewer performs a version of this judgment too, but later, cold, and expensively. Catching a semantic gap here — before the diff leaves the engineer's hands — is cheaper than catching it in review.

## Exceptions

None. Every engineer return (implementation or fix mode) states the 3-axis result. A trivial one-line fix still gets one sentence per axis; brevity is fine, omission is not.
