---
id: agent-cold-review
title: Cold Review, Two Stages
severity: rule
scope:
  layers: []
tags:
  - agent-behavior
  - reviewer
---

The reviewer agent performs two separate evaluation stages — principle compliance first, then code quality — and receives only the diff and matched principles. It never receives the session history, the design document, or the plan. It reviews cold, like an external reviewer seeing the code for the first time.

## Rationale

A reviewer that has access to the plan and design tends to confirm what was intended rather than evaluate what was delivered. "The plan said to create a service, and a service was created" is not a useful review. A cold reviewer looks at the code on its own terms: does it honor the principles? Is it well-written? Would a human reviewer approve this PR?

Splitting compliance from quality forces both evaluations to happen. A single "review this" prompt tends to blur them — the reviewer says "looks good" because the code is clean, missing that it doesn't actually comply with the thin-handlers principle.

## Examples

**Bad — reviewer confirms the plan was followed:**

```markdown
## Review
The code matches the design document. The order service was created
as specified. Looks good!
```

**Good — reviewer evaluates code on its own terms:**

```markdown
## Canon Review — Principle Compliance

### Violations
- [thin-handlers] (strong-opinion): src/app/api/orders/route.ts
  Handler contains stock-checking logic (lines 12-28) that belongs
  in the service layer. The handler should only validate input,
  call the service, and return.

### Honored
- [errors-are-values]: Service returns typed result with 3 error branches
- [simplicity-first]: Single service file, no unnecessary abstractions
- [naming-reveals-intent]: Function names describe behavior clearly

### Score
Rules: 1/1 passed | Opinions: 2/3 passed | Conventions: 1/1 passed

## Canon Review — Code Quality

### Suggestions
- The stock check in the service iterates products sequentially.
  Consider a single query with WHERE id IN (...) for efficiency.
  (Does not violate any principle — this is a quality observation.)
```

## Exceptions

When the reviewer is run as a standalone review on the user's own code (not via the build workflow), it may receive a context description from the user. This is acceptable — the user is providing context, not the orchestrator leaking session history.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|----------------|----------------|
| "The design doc explains why the code is structured this way." | The reviewer's job is to evaluate what was delivered, not confirm that the implementation matches intent. A cold reviewer sees only the code — if the code can't be understood or justified on its own terms, that is a finding. | Review the code on its own terms. If the rationale is not visible in the code, flag it as a documentation or clarity issue. |
| "The implementor probably had a reason for this violation — I shouldn't flag it." | The reviewer exists precisely to catch what the implementor missed or rationalized away. Deferring to imagined intent defeats the purpose of a separate review stage. | Flag the violation. The implementor can respond in the follow-up. The reviewer's job is to surface issues, not pre-resolve them. |
| "I need to understand the full context before I can review this properly." | Cold review is not a bug — it is the design. A reviewer who demands context becomes a confirmer. The constraint forces the reviewer to ask whether the code is self-evident, which is itself a quality signal. | Proceed with the diff and matched principles. If something is genuinely ambiguous, note the ambiguity as a finding rather than seeking to resolve it through context. |
| "This is just a refactor, the tests pass — there's nothing to check for compliance." | Refactors restructure code, which changes how principles apply. A passing test suite confirms behavior but says nothing about principle compliance. The scopes are independent. | Run both review stages regardless of the change type. Apply principle compliance checks to the refactored structure, not only to new logic. |
