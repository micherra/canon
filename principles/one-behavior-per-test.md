---
id: one-behavior-per-test
title: One Behavior Per Test
severity: convention
scope:
  languages: []
  layers: []
  file_patterns:
    - "**/*.test.*"
    - "**/*.spec.*"
    - "**/test/**"
    - "**/tests/**"
    - "**/__tests__/**"
tags:
  - testing
  - readability
  - test-patterns
---

Each test should verify exactly one behavior — one scenario, one input condition, one expected outcome. When a test fails, its name should tell you exactly what broke without reading the test body. If a test name requires "and" to describe what it checks, it should be split. More small, focused tests are better than fewer large, comprehensive ones.

## Rationale

A test that checks five things gives you one bit of information when it fails: "something is wrong." A suite of five focused tests tells you exactly *which* behavior broke. Gerald Weinberg emphasizes in *Perfect Software* that the value of testing is the information it provides — and vague information has low value.

Multi-behavior tests also make refactoring terrifying. When you change one behavior and a test with five assertions fails, you have to read the entire test to determine if the failure is expected (you intentionally changed that behavior) or a real bug (you accidentally broke something else). With one-behavior tests, a failure directly maps to the behavior you broke.

*Design Patterns for High-Quality Automated Tests* specifically warns against "eager tests" that verify too much — they are the primary cause of brittle test suites that break for reasons unrelated to the change being made.

AI-generated tests almost always cram multiple behaviors into one test. Asked to "write tests for user registration," the LLM generates a single `test("user registration")` that validates, creates, and checks for duplicates in sequence — because the prompt asked for one concept and the LLM maps one concept to one test.

## Examples

**Bad — multiple behaviors in one test:**

```typescript
test("user registration", async () => {
  // Behavior 1: validation
  const invalidResult = await register({ email: "not-an-email", password: "short" });
  expect(invalidResult.ok).toBe(false);
  expect(invalidResult.errors).toContain("invalid_email");
  expect(invalidResult.errors).toContain("password_too_short");

  // Behavior 2: successful creation
  const validResult = await register({ email: "user@test.com", password: "securePass123" });
  expect(validResult.ok).toBe(true);
  expect(validResult.data.id).toBeDefined();

  // Behavior 3: duplicate detection
  const dupeResult = await register({ email: "user@test.com", password: "securePass123" });
  expect(dupeResult.ok).toBe(false);
  expect(dupeResult.errors).toContain("email_taken");
});
```

If this test fails, the name "user registration" tells you nothing about which behavior broke.

**Good — one behavior per test:**

```typescript
test("register rejects invalid email format", async () => {
  const result = await register({ email: "not-an-email", password: "securePass123" });

  expect(result.ok).toBe(false);
  expect(result.errors).toContain("invalid_email");
});

test("register rejects passwords shorter than 8 characters", async () => {
  const result = await register({ email: "user@test.com", password: "short" });

  expect(result.ok).toBe(false);
  expect(result.errors).toContain("password_too_short");
});

test("register creates a user with a generated id", async () => {
  const result = await register({ email: "user@test.com", password: "securePass123" });

  expect(result.ok).toBe(true);
  expect(result.data.id).toBeDefined();
});

test("register rejects duplicate email addresses", async () => {
  await register({ email: "user@test.com", password: "securePass123" });

  const result = await register({ email: "user@test.com", password: "differentPass123" });

  expect(result.ok).toBe(false);
  expect(result.errors).toContain("email_taken");
});
```

Each test name reads as a specification. When one fails, you know exactly what broke.

## Exceptions

Property-based tests (e.g., fast-check) naturally verify a property across many inputs in a single test — that's the point. Snapshot tests may capture a large output that implicitly covers multiple behaviors, but the snapshot itself is a single assertion ("the output matches"). These are acceptable. The goal is *one reason to fail*, not *one `expect` statement*.
