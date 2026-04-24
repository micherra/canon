---
id: agent-document-public-apis
title: Document Public APIs with JSDoc/TSDoc
severity: rule
scope:
  layers: []
tags:
  - agent-behavior
  - engineer
---

When creating or modifying exported functions, types, interfaces, or classes, the engineer must add or update JSDoc/TSDoc comments describing the contract: what the function does, parameter semantics, return value semantics, and any errors or exceptions thrown.

## Rationale

Public APIs are the boundary other modules depend on. When a caller has to read the implementation to understand what a function does, returns, or throws, they are coupling to implementation details rather than the declared contract. A missing or stale JSDoc comment is a documentation bug — it causes the same downstream confusion as a stale CLAUDE.md entry.

The reviewer already checks for this in Stage 2 (Sub-Axis: Public API Documentation). Waiting until review to add comments is wasteful: the engineer is already in the context when writing the code, and the fix is trivial at authoring time. Doing it proactively avoids a review cycle.

## Examples

**Bad — exported function with no documentation:**

```typescript
export function processOrder(order: Order, options: ProcessOptions): Result<Receipt, OrderError> {
  // ... implementation
}
```

A caller reading this learns the types but not: what "process" means, whether `options` has required fields, whether the returned error includes partial state, or what triggers each error branch.

**Good — exported function with contract documentation:**

```typescript
/**
 * Processes a validated order and records a receipt.
 *
 * @param order - A fully validated Order object. Must have `items` non-empty
 *   and `customerId` referencing an existing customer.
 * @param options - Processing options. `options.dryRun` skips persistence but
 *   still performs stock validation.
 * @returns `Ok(receipt)` on success; `Err(OrderError)` with one of:
 *   - `"INSUFFICIENT_STOCK"` — one or more items unavailable
 *   - `"CUSTOMER_NOT_FOUND"` — customerId does not resolve
 *   - `"PERSISTENCE_FAILED"` — database write failed (idempotent — order was not recorded)
 */
export function processOrder(order: Order, options: ProcessOptions): Result<Receipt, OrderError> {
  // ... implementation
}
```

**Good — simple function with a one-line description:**

```typescript
/** Returns the ISO-8601 timestamp for when the order was last modified. */
export function getOrderUpdatedAt(order: Order): string {
  return order.updatedAt.toISOString();
}
```

One-line descriptions are fine for simple functions. Multi-line documentation is reserved for functions with non-obvious parameter semantics, multiple error branches, or side effects.

## Scope

This rule applies to:
- Exported functions and methods (`export function`, `export const fn = ...`, public class methods)
- Exported types and interfaces (`export type`, `export interface`) when fields have non-obvious semantics
- Exported classes (`export class`) — document the class purpose and constructor parameters

This rule does NOT apply to:
- Non-exported (private / internal) functions — use inline comments when needed
- Re-exports that add no new semantics (`export { foo } from './foo'`)
- Test files — test function names should be self-documenting; JSDoc is not required

## Comment Content Rules

Comments describe the **contract**, not the **implementation**:

- **Do**: describe what the function does, what parameters represent, what the return value means, what errors signal
- **Do not**: describe how the function achieves its result — that belongs in inline comments within the body

If the implementation is the only way to understand a parameter (e.g., a complex algorithm input), that is a signal to improve the abstraction, not to document the implementation detail.

## Exceptions

If the exported symbol is a thin re-export of a well-documented external type (e.g., re-exporting a type from a dependency with no added semantics), a JSDoc comment may be omitted. In this case, the engineer should verify the upstream type already carries documentation visible to consumers.
