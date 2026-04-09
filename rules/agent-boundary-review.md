---
id: agent-boundary-review
title: DDD Boundary Review Checklist
severity: rule
scope:
  layers: []
tags:
  - agent-behavior
  - reviewer
  - ddd
---

During Stage 1 (principle compliance) of a code review, the reviewer must specifically check: (a) no cross-context concrete imports — verify against `bounded-context-boundaries` and `capability-interface-required`; (b) no new `pathNot` exceptions added to `.dependency-cruiser.cjs` without a `DEFERRED-DI` comment and a tracking reference; (c) domain-layer files (`domains/`, `flows/`) contain no infrastructure imports (`@platform/adapters/`, `node:child_process`, or similar runtime/OS dependencies).

## Rationale

Boundary violations are easy to miss in review because the code works — the coupling is invisible until a refactoring or rename in the imported context breaks the caller. A reviewer who doesn't explicitly look for these imports will approve them, because nothing about the code surface signals a problem.

The dep-cruiser config enforces this automatically in CI, but CI only catches what the rules cover. Reviewers catch: new `pathNot` exceptions that widen the allowed set, imports that technically pass the current rules but violate the intent, and domain files that import infrastructure through indirect paths not yet in the ruleset.

Because `capability-interface-required` is severity `rule` (per decision ddd-01), any PR that adds a cross-context concrete import outside `src/app/` is a rule violation — not a suggestion. The reviewer must block, not flag-and-approve.

## Examples

**Bad — reviewer approves a cross-context concrete import in a domain file:**

```markdown
## Review
The flow parser looks correct. Logic is well-structured. No issues found. Approved.
```
(The diff contained `import { gitExec } from "@platform/adapters/git-adapter.ts"` in `domains/flows/parser.ts`.)

**Good — reviewer catches and blocks the boundary violation:**

```markdown
## Canon Review — Principle Compliance

### Violations
- [capability-interface-required] (rule): domains/flows/parser.ts line 3
  Concrete infrastructure import `gitExec` from `@platform/adapters/git-adapter.ts`
  in a domain-layer file. Domain files must not import from `@platform/adapters/`.
  Inject a `runCommand` function parameter instead, or extract an interface in
  `domains/flows/` and wire the concrete adapter in `src/app/`.

### Honored
- [bounded-context-boundaries]: No other cross-context imports found
- [errors-are-values]: Error branches returned as typed results throughout

### Score
Rules: 0/1 passed | review blocked pending violation resolution
```

**Bad — reviewer approves a new undocumented pathNot exception:**

```markdown
## Review
Dep-cruiser config update looks fine. The new exception is reasonable. Approved.
```

**Good — reviewer flags the missing documentation:**

```markdown
### Violations
- [agent-ddd-hygiene] (rule): .dependency-cruiser.cjs line 47
  New `pathNot` exception added for `@platform/storage/drift` with no `DEFERRED-DI`
  comment, no tracking reference, and no removal trigger. This exception permanently
  widens the allowed import set without any record of why or when it can be removed.
  Add a comment in the format: `// DEFERRED-DI: <reason>. Remove after <task/condition>.`
```

## Exceptions

None. Boundary checks are always required during Stage 1 review. A PR that modifies only test files or documentation still requires the reviewer to confirm no boundary violations were introduced (diff may be small; the check cost is negligible).

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|----------------|----------------|
| "The code is clean and well-structured — I don't need to hunt for import violations." | `capability-interface-required` is severity `rule`. The dep-cruiser config blocks some violations, but reviewers catch what automated rules miss (new exceptions, indirect imports, intent violations). A clean implementation can still contain a boundary violation. | Explicitly scan every diff for cross-context imports before writing the compliance section. This takes 60 seconds on a typical PR. |
| "The author added a pathNot exception — they must have had a reason." | Unverified reasons are not documented reasons. A `pathNot` exception without a `DEFERRED-DI` comment is indistinguishable from an accidental or lazy exception. Without the comment, future reviewers can't evaluate whether the deferral is still valid. | Flag any undocumented `pathNot` addition as a rule violation. The author must add the comment before the PR can be approved. |
| "This import is in a test file, so boundary rules don't apply." | The `src/app/` and integration-test exceptions in `agent-ddd-hygiene` apply to production wiring and test fixtures that need concrete classes. They do not exempt test files from all boundary checks — a test file that imports a concrete class to test business logic is a different category than a fixture setting up infrastructure. | Apply the same check. If the import falls under the test-fixture exception, note it explicitly in the review rather than silently approving. |
| "Dep-cruiser would have caught it if it were a real violation." | Dep-cruiser catches violations in the current ruleset. New `pathNot` exceptions widen that ruleset — they are the mechanism by which violations evade automated checks. The reviewer is the last line of defense against exception accumulation. | Treat `pathNot` additions as boundary violation candidates requiring explicit justification, not as approved expansions of the allowed import set. |
