---
id: test-the-sad-path
title: Test the Sad Path First
severity: strong-opinion
scope:
  layers: []
  file_patterns:
    - "**/*.test.*"
    - "**/*.spec.*"
    - "**/test/**"
    - "**/tests/**"
    - "**/__tests__/**"
tags:
  - testing
  - coverage
  - lessons-learned
---

Test suites must cover failure modes, error cases, and edge conditions — not just the happy path. For every function, ask: what happens with null input, empty collections, duplicate entries, network failures, permission denials, concurrent access, and boundary values? If the test suite only proves the code works when everything goes right, it proves almost nothing.

## Rationale

Cem Kaner's *Lessons Learned in Software Testing* makes a central observation: bugs cluster at boundaries and in error-handling paths — exactly the places that happy-path tests don't cover. A test suite where every test provides valid input and asserts success creates a false sense of safety. The code "works" until a user submits an empty form, a network request times out, or a database constraint is violated.

Gerald Weinberg's *Perfect Software* reinforces that testing cannot prove software is correct — but it can prove it fails in specific ways. The most valuable tests are the ones that explore how the system behaves when assumptions are violated.

AI-generated tests overwhelmingly test the happy path. An LLM asked to "write tests for createUser" will generate tests with valid inputs that create users successfully. It rarely generates tests for duplicate emails, empty names, SQL injection attempts, or database connection failures — but those are where the real bugs live.

## Examples

**Bad — only happy path tested:**

```typescript
describe("createUser", () => {
  test("creates a user with valid data", async () => {
    const result = await createUser({ name: "Alice", email: "alice@test.com" });
    expect(result.ok).toBe(true);
    expect(result.data.name).toBe("Alice");
  });

  test("creates another user with valid data", async () => {
    const result = await createUser({ name: "Bob", email: "bob@test.com" });
    expect(result.ok).toBe(true);
    expect(result.data.name).toBe("Bob");
  });
});
```

Two tests that prove the same thing. Zero coverage of failure modes.

**Good — sad paths and edge cases covered:**

```typescript
describe("createUser", () => {
  test("creates a user with valid data", async () => {
    const result = await createUser({ name: "Alice", email: "alice@test.com" });
    expect(result.ok).toBe(true);
  });

  test("rejects empty name", async () => {
    const result = await createUser({ name: "", email: "alice@test.com" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("name_required");
  });

  test("rejects invalid email format", async () => {
    const result = await createUser({ name: "Alice", email: "not-an-email" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_email");
  });

  test("rejects duplicate email", async () => {
    await createUser({ name: "Alice", email: "alice@test.com" });
    const result = await createUser({ name: "Alice2", email: "alice@test.com" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("duplicate_email");
  });

  test("handles database connection failure", async () => {
    db.simulateFailure("connection_refused");
    const result = await createUser({ name: "Alice", email: "alice@test.com" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("data_access_error");
  });

  test("trims whitespace from name and email", async () => {
    const result = await createUser({ name: "  Alice  ", email: "  alice@test.com  " });
    expect(result.ok).toBe(true);
    expect(result.data.name).toBe("Alice");
    expect(result.data.email).toBe("alice@test.com");
  });
});
```

One happy-path test, five sad-path and edge-case tests. This reflects where bugs actually live.

## Exceptions

Pure utility functions with a small input domain (e.g., `clamp(value, min, max)`) may have more happy-path tests than sad-path tests because the error surface is small. UI component tests that verify rendering don't always have meaningful sad paths — a button either renders or doesn't. Use judgment: the principle is "don't neglect failure modes," not "every function must have more sad-path tests than happy-path tests."
