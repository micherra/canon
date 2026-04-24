---
id: agent-document-decisions
title: Promote Significant Workspace Decisions to Project ADRs
severity: rule
scope:
  layers: []
tags:
  - agent-behavior
  - scribe
---

When the scribe finds design decisions in `${WORKSPACE}/decisions/` (written by the architect using the `design-decision` template), it evaluates each decision for significance and promotes qualifying decisions to project-level ADRs in `docs/decisions/`.

## Rationale

Workspace decisions are ephemeral — they live inside a per-flow workspace directory and are invisible to future contributors. Decisions that affect public API contracts, architectural patterns, or cross-cutting concerns carry forward implications: future agents and engineers need to know what was decided and why. Leaving significant decisions buried in workspace artifacts causes the same problem they were meant to solve.

Insignificant decisions — internal naming choices, local implementation details, test structure — do not need promotion. Persisting them would pollute the ADR record with noise and make it harder to find the decisions that actually matter.

## Examples

**Bad — scribe skips promotion because "the decision is already documented":**

The workspace `decisions/` directory contains `decision-001.md` recording that the public `OrderService` API was changed from throwing exceptions to returning `Result<T, E>` types. The scribe completes its CLAUDE.md updates and closes without promoting the decision.

Result: the next engineer working on a downstream service has no idea the API contract changed semantics and writes error-handling code that expects thrown exceptions.

**Good — scribe evaluates significance and promotes:**

The scribe reads `decisions/decision-001.md` and classifies it as significant (affects public API contract). It writes `docs/decisions/0042-order-service-result-types.md` with:
- The original decision content copied verbatim
- An added `Status: Accepted` field
- An added `Flow: feature-order-service` provenance line

The scribe does not rewrite, editorialize, or summarize — it promotes verbatim with metadata.

## Significance Criteria

**Promote** (significant) — decisions affecting:
- Public API contracts: function signatures, return types, error semantics
- Architectural patterns: module boundaries, data flow, layer responsibilities
- Cross-cutting concerns: authentication, error handling strategies, logging conventions, dependency choices

**Do not promote** (insignificant) — decisions about:
- Internal naming: variable names, private function names, local constants
- Local implementation choices: algorithm selection for a single function, internal data structures
- Test structure: test file organization, fixture naming, test helper design

When in doubt, err toward promotion. A spurious ADR is less harmful than a missing one.

## Output Format

Promoted ADRs are written to `docs/decisions/NNNN-{slug}.md` where `NNNN` is auto-incremented from the highest existing number in `docs/decisions/`. The slug is derived from the workspace decision filename or title.

The scribe adds three metadata lines at the top of the promoted file:

```markdown
Status: Accepted
Flow: {flow-slug}
Promoted-From: ${WORKSPACE}/decisions/{filename}
```

Everything else is the workspace decision content, copied verbatim. The scribe does NOT rewrite, summarize, or editorialize.

## Exceptions

If `docs/decisions/` does not exist in the project, the scribe skips promotion and notes in the CONTEXT-SYNC.md report: "No docs/decisions/ directory found — workspace decisions not promoted. Create docs/decisions/ to enable ADR promotion."

If the workspace contains no `decisions/` directory or the directory is empty, skip this step silently.
