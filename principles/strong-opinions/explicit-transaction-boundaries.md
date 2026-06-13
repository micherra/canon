---
id: explicit-transaction-boundaries
title: Define Transaction Boundaries Explicitly
severity: strong-opinion
portable: true
scope:
  layers:
    - domain
    - data
tags:
  - data-intensive
  - reliability
  - distributed-systems
---

Multi-step mutations that must succeed or fail together must have explicit transaction boundaries. Do not rely on implicit auto-commit behavior, hope that sequential operations will all succeed, or scatter related writes across multiple functions without a coordinating transaction. Every group of mutations that forms a logical unit of work must be wrapped in an explicit transaction, saga, or compensating action pattern — and the failure/rollback path must be as well-defined as the success path.

## Rationale

Without explicit transaction boundaries, partial failure is invisible. Three out of four database writes succeed, the fourth fails, and the system is now in an inconsistent state that no error handler anticipated. *Designing Data-Intensive Applications* identifies this as one of the most common sources of data corruption in production systems — not hardware failure, but application-level partial writes that leave data half-updated.

The problem compounds in distributed systems where a single "transaction" spans multiple services or data stores. You can't use a database transaction across services, so you need explicit saga patterns or compensating actions — and those require knowing exactly where the transaction boundaries are.

AI-generated code rarely defines transaction boundaries because LLMs generate operations sequentially and assume each step succeeds. The result is a chain of writes with no rollback path and no consideration of what happens when step 3 of 5 fails.

## Examples

**Bad — implicit "hope it works" transaction:**

```typescript
async function transferFunds(from: string, to: string, amount: number) {
  await db.accounts.update(from, { balance: { decrement: amount } });
  await db.accounts.update(to, { balance: { increment: amount } });
  // If the second update fails, money vanished from 'from' but never arrived at 'to'
  await db.transactions.create({ from, to, amount, status: "completed" });
}

async function createOrder(order: OrderInput) {
  const saved = await db.orders.create(order);
  await inventoryService.reserve(order.items);    // what if this fails?
  await paymentService.charge(order.total);        // what if THIS fails?
  await notificationService.send(order.userId);    // and this?
  // Any failure leaves the system in an unknown partial state
}
```

**Good — explicit transaction boundaries with defined rollback:**

```typescript
// Single-database transaction: use the database's own transaction support
async function transferFunds(from: string, to: string, amount: number) {
  await db.$transaction(async (tx) => {
    await tx.accounts.update(from, { balance: { decrement: amount } });
    await tx.accounts.update(to, { balance: { increment: amount } });
    await tx.transactions.create({ from, to, amount, status: "completed" });
  });
  // All three succeed or all three roll back — no partial state
}

// Cross-service saga: explicit steps with compensating actions
async function createOrder(order: OrderInput): Promise<Result<Order>> {
  const saved = await db.orders.create({ ...order, status: "pending" });

  const reserved = await inventoryService.reserve(order.items);
  if (!reserved.ok) {
    await db.orders.update(saved.id, { status: "failed" });
    return { ok: false, error: "inventory_unavailable" };
  }

  const charged = await paymentService.charge(order.total);
  if (!charged.ok) {
    await inventoryService.release(order.items);  // compensating action
    await db.orders.update(saved.id, { status: "failed" });
    return { ok: false, error: "payment_failed" };
  }

  await db.orders.update(saved.id, { status: "confirmed" });
  await notificationService.send(order.userId);  // best-effort, non-critical
  return { ok: true, data: saved };
}
```

## Exceptions

Read-only operations don't need transaction boundaries. Single-row writes that are inherently atomic don't need explicit wrapping. Best-effort operations (sending notifications, logging analytics events) that are acceptable to lose on failure can be outside the transaction boundary — but document them as "fire-and-forget."

**Related:** `handle-partial-failure` — addresses the mechanics of handling failure in distributed calls; this principle addresses the *scope* of what must succeed together. `idempotent-operations` — compensating actions and retries require idempotency to be safe.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "This principle is too strict for this case." | Principles prevent common failure modes specifically in edge cases and delivery pressure, where shortcuts look most attractive. | Apply the principle unless a concrete, bounded exception is documented under `## Exceptions`. |
| "We'll clean it up after this ships." | Deferred quality work usually becomes permanent debt and normalizes repeated violations. | Implement the compliant approach now, or record an explicit follow-up with owner and due date. |
| "Code review can catch this later." | Manual review is inconsistent under time pressure and cannot replace explicit constraints. | Encode compliance in code structure, tests, or linting so violations fail fast and repeatably. |
| "This is just a small change, so the rule doesn't matter." | Small changes accumulate into systemic drift when principles are waived incrementally. | Hold small changes to the same bar and verify the invariant still holds after each change. |

## Verification

- [ ] Updated files satisfy this principle's core constraint in behavior and structure.
- [ ] Any deviation is explicitly documented under `## Exceptions` with rationale and bounds.
- [ ] Tests, lints, or checks were added/updated where needed so regressions are detectable.
