---
id: agent-test-the-contract
title: Test the Contract, Not the Implementation
severity: convention
scope:
  languages: []
  layers: []
tags:
  - agent-behavior
  - tester
  - testing
---

Tests verify that code honors its public contract and the Canon principles it was built against. Tests should not be coupled to internal implementation details. When errors-are-values applies, test every error branch. When thin-handlers applies, test that the handler delegates.

## Rationale

AI-generated tests tend toward two failure modes: trivially testing that the code does what it obviously does (snapshot tests, line-by-line mirrors), or deeply coupling to implementation details that break on any refactor. Contract-based tests survive refactoring and catch real bugs.

Principle-driven testing adds a layer: if the code was built to honor a Canon principle, the tests should verify that the principle holds. This catches drift — if a future change breaks principle compliance, the test fails.

## Examples

**Bad — test mirrors implementation details:**

```typescript
test("createOrder calls prisma.$transaction", () => {
  await createOrder(input);
  expect(prisma.$transaction).toHaveBeenCalledTimes(1);
});
```

**Good — test verifies the contract:**

```typescript
test("createOrder returns error for insufficient stock", async () => {
  const result = await createOrder({ userId: "u1", items: [{ productId: "p1", quantity: 999 }] });
  expect(result.ok).toBe(false);
  expect(result.error).toBe("insufficient_stock");
});

test("createOrder returns order on success", async () => {
  const result = await createOrder(validInput);
  expect(result.ok).toBe(true);
  expect(result.data.total).toBe(expectedTotal);
});
```

**Good — principle-driven test (errors-are-values):**

```typescript
// Test EVERY error branch in the result type
test.each([
  ["insufficient_stock", { items: [{ productId: "p1", quantity: 999 }] }],
  ["product_not_found", { items: [{ productId: "nonexistent", quantity: 1 }] }],
  ["user_not_found", { userId: "nonexistent", items: validItems }],
])("createOrder returns '%s' error for %s", async (expectedError, input) => {
  const result = await createOrder(input);
  expect(result.ok).toBe(false);
  expect(result.error).toBe(expectedError);
});
```

## Exceptions

Integration tests and end-to-end tests may reasonably check internal state (database records created, files written) when the contract is the side effect itself.
