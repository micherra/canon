# Testing Domain

Pay attention to these concerns when working in this domain.

- **Test isolation**: Each test must be independent and leave no side effects; tests should pass in any order and in parallel.
- **Determinism**: Eliminate randomness and time-dependency from tests; seed random data and mock clocks where needed.
- **Fixture and mock management**: Set up fixtures in beforeEach/setup, tear them down in afterEach/teardown; prefer minimal fixtures over large shared ones.
- **Error path coverage**: Write tests for failure modes and edge cases, not just the happy path; most bugs live in error branches.
- **Test naming**: Name tests to describe behavior ("returns 404 when user not found"), not implementation ("calls findById with correct arg").
- **Setup and teardown discipline**: Never rely on test execution order for state; if a test needs a precondition, set it up explicitly in that test.
- **Test interdependence**: Do not share mutable state between tests; global mocks must be reset after each test.
- **Suite performance**: Keep unit tests free of real I/O (disk, network, database); reserve integration tests for verifying the wired-together system.
