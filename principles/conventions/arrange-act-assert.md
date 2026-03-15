---
id: arrange-act-assert
title: Structure Tests as Arrange-Act-Assert
severity: convention
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
  - readability
  - test-patterns
---

Every test should follow the Arrange-Act-Assert (AAA) structure: set up the preconditions, execute the behavior under test, then verify the outcome. These three phases should be visually distinct — separated by blank lines or comments. A test that interleaves setup, execution, and assertions is hard to read and harder to debug when it fails.

## Rationale

The AAA pattern (also called Given-When-Then in BDD) makes tests self-documenting. A reader can immediately identify: what state was set up, what action was taken, and what was expected. When a test fails, the structure tells you exactly where to look — was the setup wrong, did the action behave unexpectedly, or is the assertion incorrect?

AI-generated tests frequently interleave assertions with setup and action, creating tests where it's unclear what's being tested. The result: when the test breaks, the developer has to reverse-engineer what the test was actually verifying.

Tests with clear AAA structure also resist the temptation to test multiple behaviors — if you find yourself writing a second "Act" section, that's a signal to split into two tests.

## Examples

**Bad — interleaved setup, action, and assertions:**

```typescript
test("user checkout", async () => {
  const cart = new Cart();
  const item1 = createItem({ price: 10 });
  cart.add(item1);
  expect(cart.itemCount()).toBe(1);
  const item2 = createItem({ price: 20 });
  cart.add(item2);
  expect(cart.itemCount()).toBe(2);
  expect(cart.total()).toBe(30);
  const order = await checkout(cart, testPaymentMethod);
  expect(order.status).toBe("confirmed");
  expect(order.total).toBe(30);
  expect(cart.itemCount()).toBe(0);
});
```

Multiple acts and assertions are interleaved — this is really three tests pretending to be one.

**Good — clear Arrange-Act-Assert structure:**

```typescript
test("checkout creates a confirmed order with the cart total", async () => {
  // Arrange
  const cart = new Cart();
  cart.add(createItem({ price: 10 }));
  cart.add(createItem({ price: 20 }));

  // Act
  const order = await checkout(cart, testPaymentMethod);

  // Assert
  expect(order.status).toBe("confirmed");
  expect(order.total).toBe(30);
});

test("checkout empties the cart after success", async () => {
  // Arrange
  const cart = new Cart();
  cart.add(createItem({ price: 10 }));

  // Act
  await checkout(cart, testPaymentMethod);

  // Assert
  expect(cart.itemCount()).toBe(0);
});
```

Each test has one clear action and verifies one outcome. The structure is immediately readable.

## Exceptions

Trivial one-line tests (`expect(add(1, 2)).toBe(3)`) don't need explicit AAA comments — the structure is obvious. Integration tests that test a multi-step workflow (e.g., "create user, login, update profile") may legitimately have multiple act-assert cycles, but each cycle should still be visually grouped and commented.
