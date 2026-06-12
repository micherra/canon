---
id: per-folder-public-interface
title: One Public Interface Per Module Folder
severity: convention
scope:
  layers: []
  file_patterns:
    - "**/features/**"
tags:
  - architecture
  - bounded-context
  - ai-navigability
---

A feature or bounded-context folder exposes its contract through `@domains/*` shared types or a single named entry point; consumers never reach into a sibling folder's internals. The boundary is mechanically enforced by the dependency-cruiser rule `no-cross-feature-internal-import` (the `$1` back-reference blanket rule in `mcp-server/.dependency-cruiser.cjs`) — this rule IS the enforcement mechanism for this convention. See `architectural-fitness-functions` for the general pattern of automated architectural enforcement.

## Rationale

When an AI agent navigates a codebase, it resolves context by following imports. If any file can import any internal of any sibling feature, the AI's import graph becomes the full codebase — there is no way to scope to just the relevant module. Worse, the AI will generate new cross-feature internal imports because it has seen existing ones; each violation trains the next.

A single public interface per folder gives AI navigability: to understand what `knowledge-graph` exposes, read one entry point. To understand what `orchestration` provides, read `@domains/orchestration`. The reviewer follows the same scoping: a PR that touches only `features/pr-review/` should not require reading `features/knowledge-graph/` to understand the blast radius.

Enforcement by documentation alone does not work — see `architectural-fitness-functions`. The `no-cross-feature-internal-import` dependency-cruiser rule turns a documentation convention into a CI gate. Any import of the form `@features/<A>/<internal-path>` from code that lives under `@features/<B>/` will fail the dependency check. This is the fitness function for this boundary.

The complementary principle is `grey-box-module`: the single public entry point IS the grey-box seam — the human-owned interface that the reviewer can trust without reading the implementation internals of the sibling feature.

## Examples

**Bad — consumer reaches into a sibling feature's internal module:**

```typescript
// features/pr-review/pr-review-service.ts
import { GitIntelPipeline } from "@features/knowledge-graph/git-intel/git-intel-pipeline";
//                                                              ^^^^^^^^^^^^^^^^^^^^^^^^
// Reaching into knowledge-graph internals — violates the boundary.
// The no-cross-feature-internal-import depcruise rule will flag this.
```

This creates a hidden coupling: the `pr-review` feature now depends on the internal shape of `git-intel-pipeline.ts`. Any refactor of that file breaks an unrelated feature. The reviewer cannot scope their read to `pr-review/` alone.

**Good — consumer uses the shared domain type or named public entry:**

```typescript
// features/pr-review/pr-review-service.ts
import type { GitIntelResult } from "@domains/knowledge-graph";
//                                   ^^^^^^^^^^^^^^^^^^^^^^^^
// Consuming from @domains/* is the sanctioned contract.
// The knowledge-graph feature owns this type; consumers reference it, not the internals.
```

Or, if a single named entry point is preferred over `@domains/*`:

```typescript
// features/pr-review/pr-review-service.ts
import { runGitIntel } from "@features/knowledge-graph/index";
//                                                    ^^^^^
// A named index file is the only sanctioned internal entry point.
```

## Exceptions

`@shared/*` and `@domains/*` are sanctioned shared kernels — reach-through to them is allowed because they ARE the public contract, not an internal. Only sibling-feature reach-through is forbidden. Also, test files within the same feature folder may import internal modules for white-box unit testing — the boundary applies to cross-feature imports, not intra-feature test depth.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "This principle is too strict for this case." | Principles prevent common failure modes specifically in edge cases and delivery pressure, where shortcuts look most attractive. | Apply the principle unless a concrete, bounded exception is documented under `## Exceptions`. |
| "We'll clean it up after this ships." | Deferred quality work usually becomes permanent debt and normalizes repeated violations. | Implement the compliant approach now, or record an explicit follow-up with owner and due date. |
| "Code review can catch this later." | Manual review is inconsistent under time pressure and cannot replace explicit constraints. | Encode compliance in code structure, tests, or linting so violations fail fast and repeatably. |
| "This is just a small change, so the rule doesn't matter." | Small changes accumulate into systemic drift when principles are waived incrementally. | Hold small changes to the same bar and verify the invariant still holds after each change. |

## Verification

- [ ] Updated files satisfy this principle's core constraint in behavior and structure.
- [ ] Any deviation is explicitly documented under `## Exceptions` with rationale and bounds.
- [ ] Tests, lints, or checks were added/updated where needed so regressions are detectable.
