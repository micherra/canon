---
template: planning-brief
description: Structured pre-build evaluation produced by the planner agent. Gates whether work proceeds to architect + engineer.
used-by: [planner]
read-by: [canon-orchestrator, architect, engineer]
---

# Planning Brief: {request-title}

<!--
DEPTH CALIBRATION — choose before writing:
  Trivial  (1 runbook step)   -> one-sentence Problem Statement, one-line Recommended Approach, no Alternatives required, minimal Criteria. Requirement Coverage Map: one row.
  Small    (3-4 step runbook) -> all 8 sections, at least one real Alternative + "Do nothing", explicit Criteria, every requirement explicitly mapped.
  Complex  (multi-wave epic)  -> all 8 sections at full depth, multiple Alternatives, North-Star Criteria, risk-adjusted Value Assessment, every requirement explicitly mapped.
-->

<!-- Outcome: GREENLIGHT | REDIRECT | OPEN_QUESTIONS -->
**Outcome**: {one of GREENLIGHT, REDIRECT, OPEN_QUESTIONS}

**Effort estimate**: {small (hours) | medium (days) | large (weeks+)}
**Value estimate**: {low | medium | high — with one-line justification citing observable signal: issue count, error rate, affected user count}

## ASSUMPTIONS

Explicit assumptions that shape this brief. List every assumption you resolved yourself while writing this brief. If an assumption is wrong, correct it here before proceeding — do not let it propagate silently into the architect's work.

If you have no assumptions, say so: "none — all requirements and constraints are specified in the request."

1. {assumption 1 — state what you assumed and why}
2. {assumption 2}
3. {assumption 3}

## Problem Statement

What problem is being solved? State the real outcome the user wants, not the solution they proposed. One to two sentences from the user's perspective. Distinguish observed (evidenced) from speculative (imagined).

- **Evidence**: {cite graph_query results, issue counts, error logs, usage data, or user reports that confirm this problem is real — or state "speculative: no evidence available" if none exists}

<!--
Trivial requests: one sentence is sufficient.
Complex epics: state the North-Star problem — the outcome that must hold system-wide when the work is done.
-->

## Target Users

Who benefits from solving this problem? Who does not? Scope prevents over-building.

- **Primary**: {user role or team name, frequency of benefit — e.g., "end-users performing daily searches"}
- **Secondary**: {user role, frequency} — or "none"
- **Out of scope**: {roles or systems explicitly excluded from this brief's scope}

## Acceptance Criteria

Concrete, observable conditions that must hold when the work is done. Each criterion must be independently verifiable by a reviewer unfamiliar with the request. If the request lacks explicit criteria, propose them here.

- [ ] {criterion 1 — observable and testable; state what to check and how to confirm pass/fail}
- [ ] {criterion 2}
- [ ] {criterion 3}

<!--
Trivial requests: one or two criteria maximum.
Small features: explicit criteria covering happy path and key error cases.
Complex epics: include a North-Star criterion (system-wide observable outcome) plus decomposed sub-criteria per wave or subsystem.
If a criterion cannot be verified without user input, tag it in Open Questions instead.
-->

## Requirement Coverage Map

Map each discrete requirement from the original request to its disposition in this brief. Every requirement the user stated or implied must appear in exactly one row. This section is the traceability contract — the orchestrator uses it to detect silent scope narrowing.

| # | Requirement (from original request) | Disposition | Runbook step or rationale |
|---|-------------------------------------|-------------|--------------------------|
| 1 | {requirement extracted from request} | covered | {step ID or acceptance criterion that addresses it} |
| 2 | {requirement} | descoped | {why — complexity, out of scope, deferred to follow-up} |
| 3 | {requirement} | partial | {what is covered vs what is deferred} |

<!--
Disposition values:
  covered  — fully addressed by the runbook's acceptance criteria and steps
  descoped — deliberately excluded; rationale required
  partial  — partially addressed; explain what is and isn't covered
  
If ALL requirements are "covered", the orchestrator proceeds silently to runbook approval.
If ANY requirement is "descoped" or "partial", the orchestrator surfaces them to the user as an explicit HITL decision before approval.

Trivial requests (single requirement): one row, disposition "covered". The section is still required but minimal.
-->

## Alternatives Considered

At least 2-3 alternatives for non-trivial requests, including "Do nothing" as Alternative C. For each alternative: approach summary, effort bucket, and honest tradeoff against the Recommended Approach. Apply the Canon preference ordering: configuration over new code; extension over rewrite; scoped fix over broad refactor.

<!--
Trivial requests: Alternatives section is not required. Include only if a genuine alternative exists and is worth noting.
Small features and complex epics: at least one real alternative plus "Do nothing" are required.
-->

### Alternative A: {name}
- **Approach**: {one-line summary of what this alternative does}
- **Effort**: {small | medium | large}
- **Tradeoff**: {what this alternative gives up compared to the Recommended Approach — be specific and honest}

### Alternative B: {name}
- **Approach**: {one-line summary}
- **Effort**: {bucket}
- **Tradeoff**: {specific tradeoff}

### Alternative C: Do nothing
- **Consequence**: {what happens if this problem is not solved — state it in terms of user impact, not technical debt}

## Recommended Approach

One recommended approach, grounded in the Alternatives analysis above. Phrase the approach in terms of runbook step IDs from `references/runbook-vocabulary.md` so the synthesis skill can consume it directly.

- **Approach**: {description of what will be built or changed}
- **Why this one**: {rationale — cite Canon principle IDs where applicable, cite evidence, explain why this outperforms the alternatives}
- **Scope boundaries**: {what is explicitly in scope; what is explicitly out of scope — prevents scope drift during implementation}
- **Runbook steps**: {list the step IDs from runbook-vocabulary.md that this approach requires, in order — e.g., "research -> design -> implement (team, 2 tasks) -> test -> review -> context-sync -> learn"}

<!--
If the outcome is REDIRECT: the Recommended Approach differs from the original request. State the redirect rationale explicitly — show how the redirected scope still satisfies the user's underlying need.
If the outcome is OPEN_QUESTIONS: provide a tentative recommended approach with the assumption that open questions resolve in the expected direction. Mark the assumption explicitly.
-->

## Open Questions

Questions that must be answered before the architect can proceed. Each item is tagged with its decision-owner and states why the answer matters.

Leave empty (write "None — all requirements and constraints are specified") when the outcome is GREENLIGHT with no unresolved items.

1. {question — why does the answer matter, what decision does it unblock} [user | planner | architect]
2. {question} [owner]

<!--
Decision-owner guidance:
  [user]      — only the requester can answer this (business rule, priority, access to data)
  [planner]   — requires additional research the planner can do (graph_query, web search)
  [architect] — a technical design choice; safe to greenlight and let architect resolve
-->

## Value Assessment

Is the cost proportional to the value? One paragraph weighing effort against expected benefit. Apply agent-evidence-over-intuition: cite observable signals rather than asserting value qualitatively.

- **Cost**: {effort bucket (small/medium/large) + key risks that could increase it — e.g., "medium; risk of scope expansion if legacy API surface is larger than estimated"}
- **Value**: {expected benefit magnitude + frequency + affected user count or percentage — cite observable signals}
- **Proportion**: {yes | no | conditional — if conditional, state the conditions under which the cost is justified}

<!--
Complex epics: include a risk-adjusted estimate. What happens if the work runs long or scope expands? Does the value still justify the cost?
REDIRECT outcomes: the value assessment covers the redirected (narrower) scope.
-->

## Handoff

- **GREENLIGHT** -> architect spawned next with this brief as context. The brief's Recommended Approach (specifically the Runbook steps field) is the primary input to the synthesis step.
- **REDIRECT** -> lead presents this brief to the user; on approval, architect is spawned with the redirected scope. The original request is archived for reference.
- **OPEN_QUESTIONS** -> lead presents the Open Questions to the user; brief is revised after answers received. Revised brief is saved as `planning-brief-iter-1.md` (subsequent revisions increment the counter); the base `planning-brief.md` is updated to the latest approved version.
