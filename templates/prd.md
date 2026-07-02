---
template: prd
description: Structured PRD template the PM fills before spawning the architect
used-by: [orchestrator]
read-by: [architect, renderer-agent]
output-path: ${WORKSPACE}/plans/${SLUG}/prd.md
---

# PRD — {Build Title}

## Outcome

<!-- GREENLIGHT | CAUTION | NO-GO -->
GREENLIGHT

## Effort Estimate

<!-- small (hours) | medium (days) | large (weeks+) -->
medium

## Value Estimate

<!-- low | medium | high — follow with a one-line justification -->
high — {one-line justification for the value estimate}

## Problem Statement

{What problem is being solved? State the real outcome the user wants, not the
implementation approach. Focus on the gap between the current state and the desired state.}

**Evidence:** {One or two sentences of concrete evidence that the problem exists — user
complaints, observed failures, metrics showing the gap, or explicit user request.}

## Acceptance Criteria

<!-- VERIFICATION NOTE (sug_MMMMM2): Any AC asserting current system behavior ("X already blocks Y",
     "the hook currently passes Z") MUST be verified empirically — probe the code, run the test, or
     read the file — before finalizing. Memory-based current-behavior claims frequently misstate it
     (especially hook behavior). If unverified, mark UNVERIFIED and task the architect with
     confirmation before scoping. -->

| # | Criterion | Verification | Type |
|---|-----------|--------------|------|
| 1 | {What must be true when this build is done} | {How to verify — automated test, manual check, or metric} | mechanical \| manual |
| 2 | {Second criterion} | {Verification method} | mechanical \| manual |

<!-- Type column: "mechanical" = can be verified by running a command or test.
     "manual" = requires a human to check. -->

## Requirement Coverage Map

| # | Requirement | Disposition | Runbook step or rationale |
|---|-------------|-------------|--------------------------|
| 1 | {Requirement from AC or problem statement} | covered \| descoped \| partial | {Which runbook step delivers this, or why it's out of scope} |

<!-- Disposition values: covered (fully implemented), descoped (out of scope for this build),
     partial (partially addressed — note what's missing). -->

## Scope & Constraints

**In scope:**
- {What this build will deliver}

**Out of scope:**
- {What this build will NOT deliver — set expectations explicitly}

**Non-negotiable constraints:**
- {Hard constraints: performance budgets, compatibility requirements, security rules, etc.}

## Alternatives Considered

### Alternative: {Option Name}

{Brief description of this alternative approach.}

**Why not chosen:** {One or two sentences explaining the tradeoff — cost, complexity, risk,
or misalignment with constraints.}

### Alternative: Do Nothing

**Why not chosen:** {What happens if we don't build this — what pain or risk persists?}

## Open Questions

<!-- Questions that must be answered before the architect can proceed.
     Leave empty if all questions are resolved before handoff. -->

1. {Question that affects design decisions — e.g., "Does this need to work offline?"}
2. {Question about constraints or scope boundaries}
