---
title: Mocking Boundaries Domain
description: Where to mock in tests: at system boundaries, not at internal class or module boundaries.
---

# Mocking Boundaries Domain

## Mental Models

**Mock at the System Boundary, Not the Class Boundary** — Mock things that cross process boundaries: network calls, disk I/O, external services, the clock. Do not mock your own modules — that tests implementation structure, not behavior. When you mock a class you wrote, you are asserting that your code calls your other code in a specific way. When the call pattern changes without behavior changing, the test breaks for no reason. The only valid reason to mock something is that it would make the test slow, non-deterministic, or require infrastructure to run.

**Fakes Beat Mocks for Complex Dependencies** — When a dependency has rich behavior (a database, a queue, a cache), a lightweight in-memory fake is more useful than a mock with expected-call assertions. A fake lets the code under test exercise real logic paths through the dependency. A mock only verifies the call signature matched what you expected when you wrote the test. Fakes test behavior; mocks test interaction.

## Decision Frameworks

**Real vs Mock decision** — Use real when: fast, deterministic, in-process. Mock when: slow, non-deterministic, side-effectful, or external. A third-party HTTP client warrants a mock. A utility function you wrote warrants a real call. A database in a unit test warrants a fake. The more you mock, the less your test proves about the real system — every mock is a gap between the test and reality.

**Mock depth** — Mock the nearest boundary to the external system, not an intermediate layer you own. If Service A calls Service B calls External API, mock at the External API boundary, not at Service B. Mocking Service B means you are not testing A's real integration with B. You discover a broken contract only in production when Service B's behavior diverges from what the mock assumed.

## Failure Modes

**Mock-induced false confidence** — All tests pass because every mock returns exactly the data you expected when you wrote the test. The real dependency returns different shapes, has different error semantics, or adds a new required field. The system breaks in production while the test suite stays green. The test suite proved your code calls mocks correctly, not that your code handles real data correctly.

**Mock maintenance burden** — Every internal refactor breaks mock expectations because mocks encode the implementation's call pattern, not its contract. A rename, an extracted helper, or a reordered call sequence requires updating mocks that have nothing to do with the behavior change. Tests become a drag on refactoring instead of a safety net for it.

## Guardrails

**Mock count as smell** — If a test requires 5+ mocks to set up, the code under test has too many dependencies. The right response is to refactor the production code, not to add more test infrastructure. High mock counts reveal a design problem: the code is doing too many things or is coupled to too many collaborators. Accommodate the problem with a refactor, not a bigger test harness.

**Never mock what you own** — If you wrote it and it runs in-process, call it for real. Reserve mocks for things you do not control: third-party SDKs, network services, the filesystem, the clock. Owning the code means you can make it fast and deterministic enough to call directly in tests. Mocking your own modules means writing two implementations and only testing one.
