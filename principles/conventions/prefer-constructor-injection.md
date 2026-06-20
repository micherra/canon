---
id: prefer-constructor-injection
title: Prefer Constructor Injection
severity: convention
portable: true
scope:
  layers:
    - domain
    - api
    - infra
tags: [architecture, dependency-injection, testability]
---

Prefer constructor injection for services and handlers. Dependencies should be
explicit at the class or function boundary rather than created internally.

## Rationale

Use the composition root (bootstrap, module registration, app startup, or
framework provider configuration) to wire implementations to abstractions.
Avoid resolving dependencies from inside business logic with service locators,
global containers, or ad hoc `getService()` calls.

When a dependency is not represented by a concrete runtime class — for example,
configuration, primitives, or interface-based contracts in TypeScript — inject
it through an explicit token or provider key.

If a class needs many dependencies, treat that as a design smell. Refactor the
class into smaller responsibilities instead of hiding complexity behind the
container.

Allow direct construction only for:
- Simple value objects and pure helpers with no external collaborators.
- Factories whose job is controlled object creation.
- Composition-root code that assembles the object graph.

Prefer lifetimes deliberately:
- Singleton only for shared, thread-safe, expensive-to-create services.
- Scoped for request/job/unit-of-work state.
- Transient for stateless, lightweight services.

Do not let longer-lived services capture shorter-lived dependencies.

## Examples

Bad - service locator hidden inside domain logic:

```typescript
class CreateOrderService {
  async execute(input: CreateOrderInput) {
    const repo = container.get<OrderRepository>("OrderRepository");
    const clock = container.get<Clock>("Clock");
    const notifier = container.get<Notifier>("Notifier");

    const order = Order.create(input, clock.now());
    await repo.save(order);
    await notifier.sendOrderCreated(order.id);
    return order;
  }
}
```

Good - dependencies injected at construction boundary:

```typescript
type CreateOrderDeps = {
  repo: OrderRepository;
  clock: Clock;
  notifier: Notifier;
};

class CreateOrderService {
  constructor(private readonly deps: CreateOrderDeps) {}

  async execute(input: CreateOrderInput) {
    const order = Order.create(input, this.deps.clock.now());
    await this.deps.repo.save(order);
    await this.deps.notifier.sendOrderCreated(order.id);
    return order;
  }
}

// Composition root wiring (API/bootstrap layer)
const createOrder = new CreateOrderService({ repo, clock, notifier });
```

## Exceptions

Allow direct construction only for:
- Simple value objects and pure helpers with no external collaborators.
- Factories whose job is controlled object creation.
- Composition-root code that assembles the object graph.

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
