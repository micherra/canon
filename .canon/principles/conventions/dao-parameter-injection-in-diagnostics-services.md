---
id: dao-parameter-injection-in-diagnostics-services
title: DAO Parameter Injection in Diagnostics Services
severity: convention
portable: false
tags: [architecture, testability, diagnostics]
scope:
  layers: []
  file_patterns:
    - "mcp-server/src/features/diagnostics/services/**"
---

Service functions in `features/diagnostics/services/` MUST accept their DAO
(e.g., DriftDbSignals) as a function parameter rather than importing and
instantiating it at the module level.

## Rule

Pure service functions that query or write to drift.db accept the DAO as a
parameter — they do not import `getDriftDb`, `DriftDb`, or `DriftDbSignals`
directly. DB initialization is the responsibility of the caller (typically a
tool handler or the MCP tool registration layer).

## Why

Parameter injection decouples service functions from database path resolution,
enabling direct testing with an in-memory SQLite instance. All three services
in `features/diagnostics/services/` follow this pattern: callers construct
`new DriftDbSignals(db)` with `:memory:` in tests, passing real `DriftDb.getSignals()`
in production.

## Examples

Good — DAO as parameter:
```typescript
export function compileSignals(filePaths: string[], driftDbSignals: DriftDbSignals): FileSignals[] {
  // ...
}
```

Bad — DAO imported directly:
```typescript
import { getDriftDb } from "@platform/storage/drift/drift-db.ts";

export function compileSignals(filePaths: string[]): FileSignals[] {
  const signals = getDriftDb(process.cwd()).getSignals();
  // ...
}
```

## Related

- `pure-io-service-split` — module-level IO/pure separation (this convention specifies the injection mechanism)

## Exceptions

Service functions that act purely as orchestration entry points (e.g., a tool handler that owns DB initialization) may instantiate the DAO directly. The convention targets reusable service functions — those called from multiple sites or those with meaningful computation. Framework lifecycle hooks are exempt.

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
