---
id: agent-test-sad-paths
title: Test Failure Modes Before Happy Paths
severity: rule
scope:
  layers: []
tags:
  - agent-behavior
  - tester
  - implementor
  - testing
---

When writing tests, agents must cover failure modes, error cases, and edge conditions — not just the happy path. For every function, consider: null input, empty collections, duplicate entries, network failures, permission denials, concurrent access, and boundary values. If the test suite only proves the code works when everything goes right, it proves almost nothing.

## Rationale

AI-generated tests overwhelmingly test the happy path. An LLM asked to "write tests for createUser" will generate tests with valid inputs that create users successfully. It rarely generates tests for duplicate emails, empty names, or database connection failures — but those are where the real bugs live. Bugs cluster at boundaries and in error-handling paths, exactly the places happy-path tests don't cover.

## Examples

**Bad — only happy path tested:**

```typescript
describe("createUser", () => {
  test("creates a user with valid data", async () => {
    const result = await createUser({ name: "Alice", email: "alice@test.com" });
    expect(result.ok).toBe(true);
  });

  test("creates another user with valid data", async () => {
    const result = await createUser({ name: "Bob", email: "bob@test.com" });
    expect(result.ok).toBe(true);
  });
});
```

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

  test("rejects duplicate email", async () => {
    await createUser({ name: "Alice", email: "alice@test.com" });
    const result = await createUser({ name: "Alice2", email: "alice@test.com" });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("duplicate_email");
  });
});
```

## Exceptions

Pure utility functions with a small input domain (e.g., `clamp(value, min, max)`) may have more happy-path tests than sad-path tests because the error surface is small. UI component render tests don't always have meaningful sad paths.
