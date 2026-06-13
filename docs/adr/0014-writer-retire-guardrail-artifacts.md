---
adr: "0014"
title: "Writer retire action removes guardrail artifacts behind five safety gates"
status: accepted
date: "2026-06-13"
build: "address-two-codex-p2-review-comments-on-pr-396-artifact-retirement"
---

# ADR-0014: Writer retire action removes guardrail artifacts behind five safety gates

## Context

PR #396 added an artifact-retirement learner dimension that emits prune-candidate proposals — evidence-backed suggestions to retire dead-weight guardrails (principles, conventions, agent-rules). Codex flagged that the proposals had no working consumer: /canon:review-learnings did not recognize the prune types, and the writer agent (the apply path for all accepted proposals) had no retire/delete action.

Wiring the consumer means giving the writer a destructive capability — removing a guardrail artifact from a system whose guardrails ARE the artifacts. How Canon retires its own guardrails is a durable precedent that will shape all future guardrail-removal tooling, so the decision is recorded here.

## Options Considered

### Option A: Leave the prune proposals advisory-only (no apply path)

**Pros:**
- Zero destructive capability anywhere in the pipeline.

**Cons:**
- Violates mechanism-ships-first-instance — the proposer ships with no consumer, a permanent dangling wire.
- The human would have to manually delete artifacts and clean references, error-prone and unaudited.

**Canon-principle alignment:** tensions mechanism-ships-first-instance; weakly honors least-privilege by adding nothing.

### Option B: Add a retire action to the writer, gated by five layered safety checks behind a human Accept

**Pros:**
- Closes the wire — prune proposals flow end-to-end.
- Defense-in-depth: never-pruneable allowlist + security-tag refusal + rule-tier superseded_by requirement + defer-to-demotion + human-Accept gate, re-checked at the writer even though the learner pre-filtered.
- Uses the writer existing Read/Write/Edit/Bash/Glob tools — no new capability grant.

**Cons:**
- Documents a destructive capability; a future contributor must understand why a "writer" can delete principles.
- Two-place documentation (operative steps in the write-principle SKILL, safety contract in writer.md body).

**Canon-principle alignment:** honors mechanism-ships-first-instance, fail-closed-by-default, least-privilege-access, no-silent-failures.

## Decision

Chosen: **Option B — writer retire action behind five safety gates**

Retirement is propose-only at the learner, surfaced with a rule-tier CAUTION confirmation and security refusal at /canon:review-learnings, and applied by the writer only after an explicit human Accept. The writer re-checks the never-pruneable allowlist and security tag independently (defense-in-depth), requires a non-null superseded_by for rule-tier retirement, and performs removal plus reference cleanup with its existing toolset. No path deletes a guardrail without the human Accept.

## Canon-Principle Alignment

| Principle | Honors / Tensions | Notes |
|-----------|-------------------|-------|
| mechanism-ships-first-instance | honors | First working consumer of the PR #396 proposer. |
| fail-closed-by-default | honors | Every layer refuses on a never-pruneable/security target; writer re-checks. |
| hooks-fail-closed | honors | Defense-in-depth re-check at the writer mirrors the fail-closed posture. |
| least-privilege-access | honors | No new tool grant; destructive action gated behind human Accept. |
| no-silent-failures | honors | Refusals are explicit messages, never silent skips. |
| agent-document-decisions | honors | Qualifying decision recorded as both ephemeral record and this ADR. |

## Consequences

**Positive:**
- The artifact-retirement mechanism is end-to-end real and auditable.
- The never-auto-delete and never-pruneable invariants are enforced at three layers.

**Negative / trade-offs:**
- Canon now has a documented path to remove its own guardrails. Acceptable because it is HITL-gated, allowlist-protected, and superseded_by-required for rules.
- The retire action is documented in two files (SKILL operative + writer.md contract), kept consistent by a cross-read step.

## Revisit-If

- Retirement is moved out of the writer to a dedicated agent or MCP tool.
- The never-pruneable allowlist membership changes.
- Any request emerges to remove the human-Accept gate or auto-apply prune candidates.
