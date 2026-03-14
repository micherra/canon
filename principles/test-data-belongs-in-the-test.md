---
id: test-data-belongs-in-the-test
title: Test Data Belongs in the Test
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

Test data that affects a test's outcome should be visible in the test body, not hidden in shared fixtures, factory files, or beforeAll blocks. A reader should understand what a test does without navigating to other files. Use inline data for the values that matter to the assertion, and helper factories only for incidental data that doesn't affect the outcome.

## Rationale

*Design Patterns for High-Quality Automated Tests* identifies the "Mystery Guest" as a major test smell: a test that depends on data defined elsewhere, forcing the reader to open another file to understand why the test passes or fails. When a test asserts that `user.role` is `"admin"`, the test should show where `"admin"` was set — not rely on a fixture file that might be 200 lines long.

The principle is about *readability at the point of failure*. When a test fails in CI, the developer reads the test. If the test says `const user = createTestUser()` and asserts `expect(user.role).toBe("admin")`, the developer has to find `createTestUser()` to understand why the role was expected to be "admin." If the test says `const user = createTestUser({ role: "admin" })`, it's self-explanatory.

AI-generated tests often create elaborate shared fixtures (`testUser`, `testOrder`, `testProduct`) at the top of a file and reuse them everywhere. When one test changes a fixture to fix itself, other tests break — the classic shared fixture problem.

## Examples

**Bad — test data hidden in shared fixtures:**

```typescript
// test/fixtures.ts
export const testUser = {
  id: "user-1",
  name: "Test User",
  email: "test@example.com",
  role: "admin",
  department: "engineering",
  createdAt: new Date("2024-01-01"),
};

// test/permissions.test.ts
import { testUser } from "./fixtures";

test("admin can delete posts", () => {
  // Why does this user have permission? You have to open fixtures.ts to find out
  const result = canDeletePost(testUser, somePost);
  expect(result).toBe(true);
});
```

**Good — relevant data inline, incidental data in factories:**

```typescript
test("admin role can delete any post", () => {
  // The relevant fact (role: admin) is right here
  const user = buildUser({ role: "admin" });
  const post = buildPost({ authorId: "someone-else" });

  const result = canDeletePost(user, post);

  expect(result).toBe(true);
});

test("regular users cannot delete others' posts", () => {
  const user = buildUser({ role: "user", id: "user-1" });
  const post = buildPost({ authorId: "user-2" });

  const result = canDeletePost(user, post);

  expect(result).toBe(false);
});
```

The factory `buildUser()` fills in incidental fields (name, email, createdAt) with defaults. The test specifies only the values that matter for the assertion — `role` and `id`.

**Good — factory helper with sensible defaults:**

```typescript
function buildUser(overrides: Partial<User> = {}): User {
  return {
    id: randomId(),
    name: "Test User",
    email: "test@example.com",
    role: "user",
    department: "general",
    createdAt: new Date("2024-01-01"),
    ...overrides,
  };
}
```

The factory provides irrelevant defaults. Tests override only what matters.

## Exceptions

Large integration test datasets (e.g., seeding a database with 50 records for a reporting test) are impractical to inline. Use seed files or fixture factories for these, but add a comment in the test explaining what properties of the seed data the test depends on. Snapshot tests inherently reference external expected-output files — that's acceptable.
