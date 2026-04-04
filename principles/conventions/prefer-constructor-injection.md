---
id: prefer-constructor-injection
title: Prefer Constructor Injection
severity: convention
scope:
layers: [domain, application, api, workers]
tags: [architecture, dependency-injection, testability]
---

Prefer constructor injection for services and handlers. Dependencies should be
explicit at the class or function boundary rather than created internally.

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