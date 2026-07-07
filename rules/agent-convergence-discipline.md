---
id: agent-convergence-discipline
title: Flow Convergence Discipline
severity: rule
scope:
  layers: []
tags: [agent-behavior, orchestrator, flow]
---

Bounded fix/review loops (e.g., `implement → review → fix → review`) must enforce convergence discipline to prevent infinite loops and wasted compute.

## Rationale

Without convergence guards, a fix→review cycle can oscillate forever: fixing one violation introduces another, or the same violation gets "fixed" the same way repeatedly. The orchestrator must detect these patterns and escalate before compute is wasted on a non-converging loop.

## Rules

1. **Escalate through the strategy cascade, not a blind retry.** On agent failure or a stuck condition (`isStuck` returns true, agent returns error, or retry fails), call `get_next_escalation_strategy({ workspace, step_id, flow_config? })` BEFORE escalating to HITL. Apply the returned strategy (`add_primer`, `increase_budget`, `escalate_model`, `narrow_scope`, or `hitl`) per `references/escalation-protocol.md`.

2. **Bounded retries per step.** On subsequent failures of the same step, call `get_next_escalation_strategy` again — it tracks state and returns the next strategy. When the tool returns `is_terminal: true`, escalate to HITL. The bounded eval-fix and review-fix loops (see root `CLAUDE.md` § Post-Step Effects) cap at 3 iterations before HITL.

3. **Cumulative timeout.** The escalation tool enforces a 2-minute cumulative timeout across the cascade. If the cascade has been running for 2+ minutes, it returns `hitl` regardless of remaining strategies — the orchestrator does not track time separately.

4. **Adversarial-surface rethink signal.** When a fix loop or a security re-review loop runs 3+ rounds AND every finding in those rounds is a confirmed true positive on a NEW, distinct bypass or failure class (not a regression introduced by a prior fix, not noise or churn), surface the rethink signal to the user before spawning another patch engineer: the surface likely needs a structural or authoritative-primitive design change rather than another patch iteration. See `references/escalation-protocol.md` for the exact discriminator and corroborating instances.

5. **Log the escalation, not just the outcome.** When a loop reaches its terminal iteration and HITL is required, call `log_decision({ workspace, decision_type: "gate_escalation", ... })` so the escalation is part of the durable decisions ledger, not just an in-context event.

## Exceptions

None. These guards exist to prevent runaway loops. If a task genuinely needs more iterations, the user decides at the HITL gate the terminal escalation surfaces.
