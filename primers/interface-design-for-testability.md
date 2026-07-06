---
title: Interface Design for Testability Domain
description: Designing function and module interfaces so dependencies are accepted, not constructed, for testability.
---

# Interface Design for Testability Domain

## Mental Models

**Accept Dependencies, Don't Create Them** — Functions that construct their own dependencies (`new DatabaseClient()`) or call global singletons cannot be tested without hijacking internals. Accept dependencies as parameters instead. The caller decides what is real in production and what is a fake in tests. Dependency injection is not a framework feature — it is a design discipline that keeps functions honest about what they require. A function's parameter list is a declaration of its assumptions; hidden construction is a hidden assumption.

**Return, Don't Side-Effect** — Functions that return values are trivially testable: call the function, inspect the return value, assert on the shape. Functions that write to a database, send emails, or mutate global state require external infrastructure to observe their effect. Push side effects to the edges of the call graph; keep the core logic pure. A pure function that computes a result and a separate effectful function that persists it are each easier to test than a single function that does both.

## Decision Frameworks

**Dependency injection depth** — Inject at the layer where tests need control. For a service that queries a database: inject the database client into the service. For a handler that calls the service: inject the service into the handler, not the service's database client. Each layer injects one level deep. Injecting all the way down — the handler receives a database client it never directly calls — means the handler is taking on a responsibility that belongs one layer below.

**Interface vs concrete** — Use an interface when you need a test double: the dependency is slow, external, or has side effects you cannot run in tests. Use a concrete type when the dependency is always real: pure utility functions, value objects, constants. Do not create interfaces speculatively because you might someday want a second implementation. One real implementation is not a reason for an interface; multiple real implementations is.

## Failure Modes

**God constructor** — A class that accepts 8+ dependencies in its constructor. Each dependency is a testing dimension; the combinatorial explosion of interaction states makes thorough testing impractical. A constructor that is hard to call in tests is revealing a design problem: the class has too many responsibilities. Split the class before adding test infrastructure to accommodate the complexity.

**Test-only interfaces** — An interface that exists solely so tests can mock it, with exactly one production implementation and no realistic prospect of a second. If no other implementation will ever exist, the interface is ceremony: it adds indirection without earning polymorphism. Accept the concrete type and use a real instance or a lightweight fake in tests. The interface is not making the code more testable — it is making it more complex.

## Guardrails

**Constructor parameter count** — If a constructor or factory function takes more than 4 dependencies, the module has too many responsibilities. Stop adding test infrastructure to accommodate it; refactor the module instead. The right response to a hard-to-test constructor is a smaller constructor, not a better mock setup.

**Side effect budget** — Each function should have at most one side effect. A function that reads from a database, sends an email, writes a log entry, and updates a cache has four reasons to be hard to test and four reasons to fail independently. Split it into single-effect functions, each testable in isolation. The composition of single-effect functions is easier to test than a multi-effect monolith.
