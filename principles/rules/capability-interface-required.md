---
id: capability-interface-required
title: Cross-Context Access Requires a Capability Interface
severity: rule
scope:
  layers:
    - domain
tags:
  - ddd
  - boundaries
  - interfaces
  - dependency-inversion
---

Cross-context access to a bounded context's data or behavior must go through a capability interface defined in `domains/{context}/`. Concrete implementation classes must not be imported directly by code in a different bounded context. The interface is the contract; the concrete class is an implementation detail.

## Rationale

`bounded-context-boundaries` establishes that code within one bounded context must not directly import domain types from another. This principle is the concrete, enforceable application of that constraint at the TypeScript import level: any cross-context access must import an `interface` or `type`, never a class.

`information-hiding` identifies the same problem from the module design direction: the concrete class's constructor signature, method visibility, and internal structure are all implementation details. Importing the concrete class exposes all of them. A change to the class's constructor — adding a required parameter, renaming a method, changing the return type of an internal helper — now breaks every cross-context caller.

The failure mode: `OrchestrationService` imports `KgStore` directly. `KgStore`'s constructor gains a new required parameter (a cache client). Now `OrchestrationService` fails to compile. Worse, the failure is discovered by the caller, not by the owner of `KgStore`. The concrete class is the wrong dependency to expose.

This principle is `rule` severity because the dep-cruiser configuration already enforces it as `severity: "error"` in CI. Declaring the principle as `strong-opinion` would misrepresent the actual enforcement level — the tool is stricter than the principle would be. Aligning principle severity with enforcement eliminates this inconsistency and closes the loop: violations fail both `npm run lint:deps` and principle compliance checks.

## Examples

**Bad — concrete class imported across context boundaries:**

```typescript
// features/orchestration/drive-flow.ts
import { KgStore } from "../knowledge-graph/kg-store";          // Cross-context concrete import!
import { WorkspaceManager } from "../orchestration/workspace-manager"; // Same-context: OK

function driveFlow(flow: Flow, kgStore: KgStore) {
  // Orchestration is now coupled to KgStore's constructor signature
  // and every method on KgStore, not just the ones it uses
}
```

```typescript
// features/principles/get-principles.ts
import { FlowRuntime } from "../orchestration/flow-runtime";    // Cross-context concrete import!

// If FlowRuntime gains a new constructor parameter, this file breaks
```

**Good — capability interface imported; concrete class injected:**

```typescript
// domains/knowledge-graph/kg-store.interface.ts
export interface IKgStore {
  query(cypher: string, params?: Record<string, unknown>): Promise<QueryResult>;
  close(): Promise<void>;
}

// features/orchestration/drive-flow.ts
import type { IKgStore } from "@domains/knowledge-graph/kg-store.interface";

function driveFlow(flow: Flow, kgStore: IKgStore) {
  // Orchestration depends only on the declared contract
  // KgStore can change its constructor, add caching, swap backends — zero impact here
}

// src/app/index.ts (wiring entry point — allowed to import concrete)
import { KgStore } from "../features/knowledge-graph/kg-store";
import type { IKgStore } from "@domains/knowledge-graph/kg-store.interface";

const kgStore: IKgStore = new KgStore(neo4jDriver, cacheClient);
```

The concrete class is assembled once, at the application boundary (`src/app/`), and passed everywhere as its interface type. All cross-context consumers see only the capability contract.

## Exceptions

1. **`src/app/`** (the wiring entry point) may import concrete classes to assemble the dependency graph. This is the only place where concrete classes from multiple contexts are composed together. It is the seam where the application becomes a whole.

2. **Test files** (`*.test.ts`, `*.spec.ts`) may import concrete classes for integration test setup. Integration tests verify the concrete implementation; unit tests should still program against the interface.

3. **Files within the same bounded context** may import concrete classes freely. Context membership is determined by directory: files under `features/knowledge-graph/` are in the same context and may import each other's concrete classes without restriction.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "The interface would just mirror every method on the class — it's redundant." | The interface documents the contract that callers depend on. A class with 20 methods but only 3 used cross-context should expose a 3-method interface — that's information hiding working correctly. | Extract an interface with only the methods cross-context callers need. Narrow interfaces are better interfaces. |
| "We're a small team — a direct import is fine for now." | The concrete class's constructor signature is now a shared, public API surface. Every person who adds a dependency to the class must check cross-context callers. | Define the interface now. The dep-cruiser rule already enforces this; the principle aligns the documented constraint with the enforced one. |
| "The dep-cruiser config already catches this — the principle is redundant." | Automated tooling catches violations at commit time; the principle explains *why* the constraint exists so engineers make the right design choice before writing code. | Keep both: the tool enforces, the principle explains. Remove the principle and the "why" is lost; remove the tool and violations slip through code review. |
| "We'll add the interface when we need to swap the implementation." | By then, every cross-context caller is coupled to the concrete class's method signatures. Extracting an interface post-hoc requires auditing every call site for which methods are actually used. | Define the interface before the first cross-context import. It costs 10 lines now and saves significant refactor later. |

## Verification

- [ ] No concrete class is imported across bounded context directories — `npm run lint:deps` passes with zero `capability-interface-required` violations.
- [ ] New cross-context parameters use interface types (`IKgStore`, `IFlowRuntime`), not concrete class types — grep for `import {` (not `import type {`) across context boundaries.
- [ ] Any `pathNot` exception added to the dep-cruiser config is documented with rationale and bounded by a condition from `## Exceptions`.
