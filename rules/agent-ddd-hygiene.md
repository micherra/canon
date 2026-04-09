---
id: agent-ddd-hygiene
title: DDD Boundary Hygiene for Implementors
severity: rule
scope:
  layers: []
tags:
  - agent-behavior
  - implementor
  - ddd
---

When an implementor adds new code that accesses data or behavior from a different bounded context, the implementor must: (a) import the capability interface from `domains/{context}/`, never the concrete class from the implementation directory; (b) receive the dependency via parameter injection, not direct instantiation; (c) not add `pathNot` exceptions to `.dependency-cruiser.cjs` without documenting the deferral reason and removal trigger in a comment.

## Rationale

Direct concrete imports across context boundaries create invisible coupling. The code works today, but any rename, refactor, or extraction in the imported context silently breaks every caller. The `capability-interface-required` principle codifies the structural rule (severity: rule, machine-checked via dep-cruiser); this agent rule codifies the behavioral process an implementor must follow when building.

Parameter injection makes dependencies visible at the call site, enabling testing with stubs and making the coupling explicit in the type signature. Undocumented `pathNot` exceptions accumulate and become permanent workarounds — they defeat the purpose of dep-cruiser enforcement without any record of why or when they can be removed.

## Examples

**Bad — implementor imports a concrete class from an implementation directory:**

```typescript
// In src/features/orchestration/some-service.ts
import { DriftStore } from "@platform/storage/drift/store.ts";

class SomeService {
  private store = new DriftStore();
}
```

**Good — implementor imports the interface from the domain and injects the dependency:**

```typescript
// In src/features/orchestration/some-service.ts
import type { IDriftStore } from "@domains/drift/index.ts";
import { DriftStore } from "@platform/storage/drift/store.ts"; // only in src/app/ wiring

class SomeService {
  constructor(private store: IDriftStore) {}
}

// In src/app/index.ts (wiring)
const service = new SomeService(new DriftStore());
```

**Bad — undocumented pathNot exception in dep-cruiser config:**

```js
// .dependency-cruiser.cjs
{ pathNot: ["@platform/storage/drift"] } // added with no explanation
```

**Good — documented deferral with removal trigger:**

```js
// .dependency-cruiser.cjs
// DEFERRED-DI: DriftStore injected directly until IDriftStore interface
// is extracted in task ddd-wire-drift. Remove exception after that task merges.
{ pathNot: ["@platform/storage/drift"] }
```

## Exceptions

- **Wiring code in `src/app/`**: The entry-point assembly layer instantiates concrete classes and wires the dependency graph. Cross-context concrete imports are expected and correct here.
- **Test setup for integration tests**: Test files may import concrete classes directly when setting up integration test fixtures that need real infrastructure, not stubs.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|----------------|----------------|
| "The interface doesn't exist yet, so I have to import the concrete class." | Importing the concrete class is exactly what creates the coupling this rule prevents. If the interface doesn't exist, create it — or add a documented `DEFERRED-DI` exception with a tracking reference and removal trigger. | Create the interface in `domains/{context}/index.ts`, or add a documented deferral comment to the dep-cruiser exception. Never import the concrete class silently. |
| "It's just one import — a full interface is overkill." | Every boundary violation started as "just one import." The dep-cruiser rule exists precisely because these accumulate invisibly. Severity `rule` means no exceptions without documentation. | Follow the pattern: interface in `domains/`, injection at the call site, concrete class only in `src/app/`. |
| "I'll refactor it to use the interface after the feature is working." | Deferred refactoring almost never happens. The concrete import becomes load-bearing and the deferral becomes permanent. If the interface route isn't clear now, add a documented dep-cruiser exception with a tracking issue reference. | Implement with the interface from the start. If temporarily blocked, document the deferral — don't ship an undocumented exception. |
| "This file is in `src/features/`, not `src/app/`, but it's wiring code." | The `src/app/` exception is for the application assembly layer, not for feature code that happens to instantiate things. Feature code receives dependencies; it does not construct them. | Move instantiation to `src/app/` or accept the dependency via constructor/function parameter. |
