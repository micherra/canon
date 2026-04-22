---
template: planning-brief
description: Structured pre-build evaluation produced by the planner agent. Gates whether work proceeds to architect + engineer.
used-by: [planner]
read-by: [canon-orchestrator, architect, engineer]
---

# Planning Brief: {request-title}

<!-- Outcome: GREENLIGHT | REDIRECT | OPEN_QUESTIONS -->
**Outcome**: {one of GREENLIGHT, REDIRECT, OPEN_QUESTIONS}

**Effort estimate**: {small (hours) | medium (days) | large (weeks+)}
**Value estimate**: {low | medium | high — with one-line justification}

## ASSUMPTIONS

Explicit assumptions that shape this brief. Correct any that are wrong before proceeding.

1. {assumption 1}
2. {assumption 2}
3. {assumption 3}

## Problem Statement

What problem is being solved? State it in one or two sentences from the user's perspective. Distinguish real (evidenced) from speculative (imagined).

- **Evidence**: {logs, reports, usage data, user feedback that shows this problem is real — or "speculative" if none}

## Target Users

Who benefits from solving this problem?

- **Primary**: {user/role, frequency of benefit}
- **Secondary**: {user/role, frequency} — or "none"

## Acceptance Criteria

Concrete, observable conditions that must hold when the work is done. If the request lacks these, propose them here.

- [ ] {criterion 1 — observable, testable}
- [ ] {criterion 2}
- [ ] {criterion 3}

## Alternatives Considered

At least 2–3 alternatives, including "do nothing" where applicable. For each:

### Alternative A: {name}
- **Approach**: {one-line summary}
- **Effort**: {bucket}
- **Tradeoff**: {what this gives up vs the proposed approach}

### Alternative B: {name}
- **Approach**: {...}
- **Effort**: {...}
- **Tradeoff**: {...}

### Alternative C: Do nothing
- **Consequence**: {what happens if this isn't built}

## Recommended Approach

One recommended approach, grounded in the alternatives above.

- **Approach**: {description}
- **Why this one**: {rationale — tie to Canon principles where relevant}
- **Scope boundaries**: {what is explicitly in scope and what is out of scope — prevents drift during implementation}

If the outcome is REDIRECT, the recommended approach differs from the request. State the redirect rationale explicitly.

## Open Questions

Questions that must be answered by the user before the architect can proceed. Leave empty when outcome is GREENLIGHT.

1. {question 1 — and why the answer matters}
2. {question 2}

## Value Assessment

Is the cost proportional to the value? One paragraph weighing effort vs expected benefit.

- **Cost**: {effort bucket + key risks}
- **Value**: {expected benefit magnitude + frequency + affected user count}
- **Proportion**: {is this cost justified — yes/no/conditional}

## Handoff

- **GREENLIGHT** → architect spawned next with this brief as context.
- **REDIRECT** → lead presents this brief to the user; on approval, architect spawned with the redirected scope.
- **OPEN_QUESTIONS** → lead presents Open Questions to the user; brief is revised after answers.
