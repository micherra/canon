---
id: domain-identifier-types
title: Use Branded Types for Domain Identifiers
severity: strong-opinion
scope:
  layers:
    - domain
tags:
  - ddd
  - types
  - branded-types
  - domain-modeling
---

Domain entity identifiers that cross bounded context boundaries should use branded (opaque) types rather than raw `string`. This prevents accidental interchange of identifiers from different domains — passing a `FlowName` where a `StateId` is expected becomes a compile-time error, not a silent runtime bug.

## Rationale

`aggregates-reference-by-id` establishes that aggregates reference other aggregates by identity only. This principle extends that constraint to the type level: not just "pass an ID" but "pass the *right kind* of ID." Raw strings are structurally identical regardless of semantic meaning. `string` is the same type whether it holds a workspace path, a flow name, a state ID, or a ULID. TypeScript's structural typing means a function that expects a `FlowName` will silently accept a `StateId` — they are both `string`.

`ubiquitous-language-in-code` calls for domain concepts to appear explicitly in code. An identifier is a domain concept. `FlowName`, `StateId`, and `WorkspacePath` are distinct concepts in the Canon ubiquitous language. Encoding them as the same `string` type erases that distinction at compile time.

The failure mode: `driveFlow(flowName: string, stateId: string)` is called as `driveFlow(stateId, flowName)` — arguments transposed. Both are strings. TypeScript compiles. The flow runtime receives the wrong values and either crashes at runtime or produces a silently wrong result. The branded type version — `driveFlow(flowName: FlowName, stateId: StateId)` — fails at the call site with a clear type error before any code runs.

This principle is `strong-opinion` rather than `rule` because TypeScript has no native nominal typing. Branded types require opt-in patterns (`z.string().brand<"FlowName">()` or `type FlowName = string & { _brand: "FlowName" }`). A `rule` would be unenforceable without custom lint tooling. `strong-opinion` drives gradual adoption through code review without hard-blocking new code that hasn't yet migrated.

## Examples

**Bad — raw strings for all identifiers:**

```typescript
// Which string is which? TypeScript can't tell.
function getState(flowName: string, stateId: string): FlowState | undefined {
  return flows[flowName]?.states[stateId];
}

// Easy to transpose — both are `string`:
const state = getState(currentStateId, currentFlowName); // Wrong order, compiles fine
```

```typescript
// Parameters read as documentation, not as a contract
async function driveFlow(workspacePath: string, flowName: string, stateId: string) {
  // ...
}
```

**Good — branded types for domain identifiers:**

```typescript
import { z } from "zod";

// Branded types defined in domains/{context}/identifiers.ts
const FlowName = z.string().brand<"FlowName">();
type FlowName = z.infer<typeof FlowName>;

const StateId = z.string().brand<"StateId">();
type StateId = z.infer<typeof StateId>;

// Function signature is self-documenting AND type-safe
function getState(flowName: FlowName, stateId: StateId): FlowState | undefined {
  return flows[flowName]?.states[stateId];
}

// Transposed arguments: compile-time error
const state = getState(currentStateId, currentFlowName);
//                     ~~~~~~~~~~~~~ Type '"StateId"' is not assignable to type '"FlowName"'
```

```typescript
// Branding at the boundary (validation or trusted construction)
function parseFlowName(raw: string): FlowName {
  return FlowName.parse(raw); // Validates and brands in one step
}

// Inside the domain, fully type-safe
const flow = getFlow(parseFlowName("fast-path")); // OK
const flow = getFlow(parseStateId("plan"));       // Compile error — wrong brand
```

## Exceptions

1. **Internal identifiers** that never cross context boundaries may remain `string`. A temporary key used within a single function to deduplicate results does not need a branded type.

2. **Single-scope identifiers** used only in one function without being passed to other functions or stored in domain types. If the identifier is created and consumed in the same expression, branding adds noise without safety.

3. **Migration**: existing code that uses raw `string` for domain identifiers is not retroactively required to adopt branded types. This principle is forward-looking: new identifier parameters that cross context boundaries should use branded types. Existing identifiers are candidates for gradual migration.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "Branded types are boilerplate — it's just a string." | The boilerplate is a one-time definition; the safety benefit applies to every call site, forever. The canonical failure mode (transposed string arguments) is real and produces silent bugs. | Define the branded type in `domains/{context}/identifiers.ts`. Import it at call sites. The overhead is 3 lines per identifier type. |
| "We've never transposed these arguments before." | Arguments-transposed bugs are silent until the feature that depends on correct ordering is tested end-to-end. They don't surface at the call site. | Structural typing gives the compiler zero ability to catch this. Branded types give it full ability. The absence of observed bugs does not mean the risk is zero. |
| "TypeScript's type system isn't nominal — this is a workaround." | Zod brands and type intersection brands are idiomatic TypeScript patterns widely used in production codebases. `string & { _brand: "FlowName" }` is a first-class TypeScript technique, not a hack. | Use `z.string().brand<"FlowName">()` for Zod-validated identifiers or the type intersection pattern otherwise. Both are standard. |
| "We'll add this when we have a bug caused by it." | By then, the function signature is a shared API surface. Adding a brand is a breaking change: all callers must wrap their strings. | Add brands when the identifier is first defined. Adding them later costs nothing if done first; it costs a refactor if deferred. |

## Verification

- [ ] New domain identifier parameters that cross context boundaries use branded types — check function signatures in `domains/` and `features/` for raw `string` parameters that semantically carry a domain identity.
- [ ] Branded type definitions live in `domains/{context}/identifiers.ts` (or equivalent) — not scattered inline across feature files.
- [ ] Zod branded types are parsed at the trust boundary (`FlowName.parse(raw)`) rather than cast (`raw as FlowName`) — grep for `as FlowName`, `as StateId`, etc. and verify each is justified.
