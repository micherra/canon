---
id: errors-are-values
title: Errors Are Values, Not Surprises
severity: strong-opinion
scope:
  languages:
    - typescript
    - python
  layers:
    - domain
    - api
tags:
  - error-handling
  - reliability
  - readability
---

Prefer returning typed result objects over throwing exceptions for expected failure cases. Exceptions are for unexpected failures (network down, null pointer). Business rule violations (insufficient funds, invalid state transition) are expected outcomes — model them as return values.

## Rationale

Thrown exceptions are invisible in the type system and create hidden control flow. A caller can't tell from a function signature what can go wrong — they have to read the implementation or hope for documentation. Result types make the failure modes explicit at the call site, which is especially important when an AI agent is generating the calling code.

## Examples

**Bad — throwing for expected cases:**

```typescript
async function transferFunds(from: string, to: string, amount: number): Promise<Transfer> {
  const sender = await getAccount(from);
  if (sender.balance < amount) {
    throw new InsufficientFundsError(sender.balance, amount);
  }
  return await executeTransfer(sender, recipient, amount);
}
```

**Good — result type makes failure modes explicit:**

```typescript
type TransferResult =
  | { ok: true; data: Transfer }
  | { ok: false; error: "insufficient_funds"; balance: number; required: number }
  | { ok: false; error: "account_frozen"; accountId: string };

async function transferFunds(
  from: string, to: string, amount: number
): Promise<TransferResult> {
  const sender = await getAccount(from);
  if (!sender) return { ok: false, error: "account_not_found", accountId: from };
  if (sender.balance < amount) {
    return { ok: false, error: "insufficient_funds", balance: sender.balance, required: amount };
  }
  return { ok: true, data: transfer };
}
```

## Exceptions

Use thrown exceptions for genuinely unexpected failures: database connection lost, file system errors, null reference bugs. Also, if the codebase has an established exception-based pattern, consistency may outweigh this principle.

**Related:** `define-errors-out-of-existence` is the companion principle — before modeling an error as a value, ask whether the API can be redesigned so the error condition is impossible. Apply that principle first to eliminate unnecessary errors, then use typed results for the errors that remain.
