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

## Related

[[externalize-configuration]] is the companion at the config level — environment-specific values must come from outside the codebase; constructor injection is how those externalized values reach the services that need them without coupling business logic to the config source.

