---
id: tests-are-independent
title: Tests Must Be Independent
severity: strong-opinion
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
  - reliability
  - test-patterns
---

Each test must be able to run alone, in any order, and produce the same result. Tests must not depend on shared mutable state, execution order, or side effects from other tests. If test B fails only when test A runs first, both tests are broken — they share hidden state. Use fresh fixtures, proper setup/teardown, and isolated test databases or transactions.

## Rationale

Coupled tests are a maintenance nightmare. When tests share state — a database row, a global variable, a file on disk — they create invisible dependencies. Reordering tests, running a single test in isolation, or parallelizing test execution all break in unpredictable ways. Debugging becomes a puzzle: "this test passes alone but fails in the suite" means the real bug is in a completely different test.

*Design Patterns for High-Quality Automated Tests* treats test independence as foundational — without it, the test suite cannot be trusted, parallelized, or maintained. *Lessons Learned in Software Testing* warns that shared test fixtures are one of the most common causes of test suite rot.

AI-generated tests commonly create a shared object at the top of a `describe` block, mutate it in individual tests, and assume tests run in written order. This works until someone adds a `.only` or the runner parallelizes.

## Examples

**Bad — tests share mutable state:**

```typescript
describe("ShoppingCart", () => {
  const cart = new ShoppingCart(); // Shared across all tests!

  test("starts empty", () => {
    expect(cart.items).toHaveLength(0);
  });

  test("can add an item", () => {
    cart.add({ id: "1", price: 10 });
    expect(cart.items).toHaveLength(1); // Depends on previous test
  });

  test("calculates total", () => {
    cart.add({ id: "2", price: 20 });
    expect(cart.total()).toBe(30); // Depends on BOTH previous tests
  });
});
```

If "can add an item" is skipped, "calculates total" fails — the tests are order-dependent.

**Good — each test creates its own state:**

```typescript
describe("ShoppingCart", () => {
  test("starts empty", () => {
    const cart = new ShoppingCart();
    expect(cart.items).toHaveLength(0);
  });

  test("can add an item", () => {
    const cart = new ShoppingCart();
    cart.add({ id: "1", price: 10 });
    expect(cart.items).toHaveLength(1);
  });

  test("calculates total of all items", () => {
    const cart = new ShoppingCart();
    cart.add({ id: "1", price: 10 });
    cart.add({ id: "2", price: 20 });
    expect(cart.total()).toBe(30);
  });
});
```

Each test is self-contained. Run any test alone, in any order — same result.

**Good — use beforeEach for shared setup without shared mutation:**

```typescript
describe("ShoppingCart", () => {
  let cart: ShoppingCart;

  beforeEach(() => {
    cart = new ShoppingCart(); // Fresh instance per test
  });

  test("starts empty", () => {
    expect(cart.items).toHaveLength(0);
  });

  test("can add an item", () => {
    cart.add({ id: "1", price: 10 });
    expect(cart.items).toHaveLength(1);
  });
});
```

## Exceptions

End-to-end workflow tests that verify a multi-step user journey (create account → login → update profile → delete account) may intentionally chain steps where later steps depend on earlier ones. These should be clearly labeled as workflow/scenario tests and kept in a separate suite from unit tests. Database integration tests may use a shared transaction that rolls back in `afterEach` — this is acceptable because the rollback guarantees isolation.
