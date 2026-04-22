---
name: testing
description: Domain primer for test design — pyramid as resource allocation, tests-as-specs vs tests-as-implementation, the Beyonce rule, shared-state pitfalls, mocking discipline. Use when writing unit/integration/e2e tests, reviewing test coverage, deciding what to mock, or debugging flaky tests.
user-invocable: false
---

# Testing Domain

## Mental Models

**The Test Pyramid Is a Resource Allocation Model** — Unit tests are cheap, fast, and numerous. Integration tests are slower, fewer, and verify wiring. End-to-end tests are expensive, brittle, and prove the system works as a whole. The pyramid isn't a rule about how many tests to write — it's a model for where to invest. A function with complex logic deserves unit tests. A function that just wires services together deserves an integration test. Testing wiring with unit tests (mocking everything) or testing logic with e2e tests (slow feedback) is a resource mismatch.

**Tests Are Specifications, Not Verifications** — A well-written test suite is the most accurate documentation of what the system actually does. Tests that describe behavior ("returns 404 when user not found") communicate intent. Tests that verify implementation ("calls findById once with the correct argument") are coupled to code structure and break when the implementation changes without the behavior changing. When a test breaks, it should mean behavior changed — not that someone refactored.

**The Beyonce Rule** — If you liked it, you should have put a test on it. Any behavior the system relies on for correctness needs a test. If there's no test, there's no contract — anyone can change the behavior and nothing will stop them. This applies especially to behaviors discovered during debugging: if you found a bug, the missing test is why it shipped.

## Decision Frameworks

**What to mock** — Mock things that are slow (network, disk, databases in unit tests), non-deterministic (time, randomness, external APIs), or have side effects you can't undo (sending emails, charging credit cards, writing to production). Don't mock things that are fast, deterministic, and in-process — your own utility functions, data transformations, pure business logic. The more you mock, the less your test proves about the real system.

**Test scope selection** — Match the test type to what you're verifying. Testing a pure function with complex branching: unit test. Testing that two modules integrate correctly through a shared interface: integration test. Testing that a user can complete a workflow through the real UI: e2e test. Testing that a module calls another module's method: you're testing implementation, reconsider what behavior you actually care about.

**When to test private internals** — Almost never directly. If a private function is complex enough to warrant its own tests, it's complex enough to be extracted into its own module with a public interface. Testing privates couples tests to implementation structure. The exception: performance-critical algorithms where you need to verify invariants at a granularity the public API doesn't expose.

## Failure Modes

**Testing the happy path and calling it covered** — A test suite where every test ends with "expect result to equal expected output" and none test error cases, edge cases, or boundary conditions. Most production bugs live in the error branches, not the success path. A function with 90% line coverage but no error path tests has the illusion of safety.

**Mock-heavy tests that prove nothing** — When every dependency is mocked, the test only verifies that your code calls mocks in the expected order with the expected arguments. The actual behavior — what happens when those dependencies return real data, throw real errors, or behave unexpectedly — is untested. The test passes when the mocks match your assumptions, not when the system works.

**Shared mutable test state** — A test that passes in isolation but fails when run with the suite (or vice versa) is leaking state. Shared database records, module-level variables, global mocks not restored, or test files written to a common directory. The symptom is flaky tests; the cause is always shared mutation.

**Testing the framework** — Writing tests that verify framework behavior rather than your code's behavior. Testing that React renders a component, that Express routes to a handler, that Prisma returns a query result. These are tests of someone else's code. Test what your code does with the framework, not that the framework works.

## Guardrails

**Test-per-method symmetry** — You should test behavior. If your test file mirrors the source file method-by-method (one test per function, named after the function), you're testing implementation structure, not behavior. Tests should be organized around scenarios and behaviors, not around the source file's table of contents.

**Assertion overload** — You should verify outcomes. If a single test has 15 assertions checking every field of a response, every call to a mock, and every side effect, you've gone too far. A test with too many assertions is testing multiple behaviors — when it fails, you don't know which behavior broke. Prefer one logical assertion per test.

**Coverage worship** — You should track test coverage. If you're writing trivial tests (getter/setter tests, tests that only assert a constructor sets fields) to hit a coverage number, you've gone too far. Coverage measures which lines executed, not which behaviors are verified. 80% meaningful coverage beats 100% with padding.

**Test infrastructure bloat** — You should have test utilities. If your test helpers, custom matchers, and fixture builders have become a framework of their own with their own bugs and learning curve, you've gone too far. Test infrastructure should be boring and obvious. When test utilities need tests, the abstraction has exceeded its value.
