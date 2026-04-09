---
id: refactoring-integrity
title: Refactoring Must Be Substantive, Not Cosmetic
severity: rule
scope:
  layers:
    - domain
    - api
    - data
    - shared
tags:
  - ddd
  - refactoring
  - boundaries
  - agent-behavior
---

When splitting or restructuring files, every extracted module must carry a single, articulable responsibility that would exist independently of any line-count target. Reducing a file's size by removing whitespace, trimming comments, collapsing formatting, or dumping types into a catch-all file to hit a threshold is not refactoring — it is obfuscation of the original problem. All splits must follow genuine domain boundaries; every resulting file must be describable in one sentence without the word "and."

## Rationale

Line-count limits exist as a proxy for complexity. When a file approaches the limit, the correct question is "what distinct responsibilities has this file accumulated?" — not "how do I shrink the character count?" Cosmetic trimming produces files that sit just under the threshold while retaining all the original coupling and cognitive load. Reviewers notice a passing lint check, not the underlying problem.

The failure mode is acute when agents do this work under time or token pressure. The easiest refactoring is no refactoring: delete blank lines, abbreviate comments, move types to a `types.ts` file, and declare done. The result is a codebase with the same entanglement but now split across multiple files with no principled boundary between them.

DDD bounded contexts are the correct unit of decomposition. A bounded context has a ubiquitous language, owns its data, and can change without coordinating with other contexts. When a file is split along a bounded context boundary, the resulting files should need to know nothing about each other's internals. If the split requires importing from the sibling file in both directions, the boundary was drawn wrong.

The 5% threshold smell catches a specific agent anti-pattern: trimming just enough whitespace or shortening just enough JSDoc to land at 598 lines when the limit is 600. A file that ends up within 5% of the limit after refactoring is a file that still has too much responsibility — it was cosmetically trimmed, not genuinely decomposed.

## Examples

**Bad — cosmetic reduction to hit a line-count target:**

```typescript
// Before: order-service.ts at 650 lines — "refactored" by:
// 1. Removing blank lines between functions
// 2. Shortening JSDoc from 4-line to 1-line comments
// 3. Moving all interfaces to order-types.ts (598 lines remaining)

// order-types.ts — a "types dump" with no bounded identity
export type Order = { ... };
export type OrderItem = { ... };
export type OrderStatus = ...;
export type PaymentMethod = ...;
export type ShippingAddress = ...;
export type InventoryReservation = ...;  // belongs to inventory context, not order

// order-service.ts — still 598 lines, still orchestrates payment + shipping + inventory
import type { Order, OrderItem, PaymentMethod, InventoryReservation } from "./order-types";
```

**Good — split by genuine DDD responsibility:**

```typescript
// order-service.ts — "Manages the lifecycle of a customer order (placement through confirmation)"
// ~220 lines. Owns: Order, OrderItem, OrderStatus, order placement, order cancellation.
export type Order = { ... };
export type OrderItem = { ... };
export type OrderStatus = "pending" | "confirmed" | "cancelled";
export async function placeOrder(cart: Cart, customer: Customer): Promise<Order> { ... }
export async function cancelOrder(orderId: OrderId, reason: string): Promise<void> { ... }

// payment-service.ts — "Processes and records payment transactions for orders"
// ~180 lines. Owns: PaymentMethod, PaymentResult, charge, refund.
export type PaymentMethod = { ... };
export async function chargeOrder(order: Order, method: PaymentMethod): Promise<PaymentResult> { ... }
export async function refundOrder(orderId: OrderId): Promise<void> { ... }

// inventory-reservation.ts — "Reserves and releases inventory slots during order fulfillment"
// ~140 lines. Owns: InventoryReservation. Imports Order by ID only, never by shape.
export async function reserveItems(orderId: OrderId, items: OrderItem[]): Promise<Reservation> { ... }
export async function releaseReservation(reservationId: ReservationId): Promise<void> { ... }
```

**Bad — circular import break via intermediary file:**

```typescript
// Problem: order-service.ts and payment-service.ts import each other
// "Fix": extract shared-order-types.ts as an intermediary

// shared-order-types.ts — exists only to break the cycle, not because the types are shared
export type OrderId = string;
export type OrderTotal = number;
// Both files now import from this, but the actual circular dependency logic is untouched
```

**Good — fix the dependency direction:**

```typescript
// order-service.ts initiates payment; payment-service.ts should not import from order-service.ts.
// payment-service.ts receives what it needs as function arguments — it never imports order internals.
// The dependency is unidirectional: order → payment, not a cycle.

// payment-service.ts — receives OrderId and total as primitives; no order-service import needed
export async function chargeOrder(orderId: string, totalCents: number, method: PaymentMethod): Promise<PaymentResult> { ... }
```

## Exceptions

A shared types file is acceptable when the types it contains are genuinely referenced by three or more bounded contexts that have no other dependency relationship, and the types themselves represent a cross-cutting vocabulary (e.g., `Money`, `Currency`, `Timestamp`). The test: if you deleted the types file and redistributed each type to the context that owns it, would any context need to import a type from a context it otherwise has no relationship with? If yes, a shared vocabulary file is warranted. If no, each type belongs where it is used.

Whitespace and comment style may be adjusted as part of a broader style normalization pass — but only when the primary goal of the PR is style normalization, not when style changes are mixed into a structural refactoring to hit a line-count target.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "I moved everything to a types file — the service file is now under the limit." | A types dump is not a bounded context. It has no responsibility of its own; it is a holding area. The service file's complexity is unchanged; its interfaces are just physically elsewhere. | Find the responsibility boundary inside the service. Split by behavior, not by type vs. non-type. |
| "The file is at 598 lines — that's under 600, so it passes." | Within 5% of the threshold after a refactoring pass is a signal that the file was trimmed, not decomposed. The limit was a proxy for complexity; the complexity remains. | Continue splitting by responsibility until each file is comfortably under the threshold with no whitespace manipulation. |
| "Removing blank lines just cleans up the formatting." | During a structural refactoring, removing blank lines that reduce line count is not formatting — it is gaming the metric. The change has no value on its own and obscures whether a genuine split happened. | Keep formatting changes separate from structural changes. If a genuine decomposition was done, line count falls naturally. |
| "The circular import problem is too complex to fix the right direction — an intermediary file is pragmatic." | An intermediary file does not fix a circular dependency; it hides it. The coupling is still there, now just indirected through a shared file. | Identify which direction the dependency should flow. The downstream context should receive what it needs as arguments or events, never by importing from the upstream context. |
| "This PR was about line count, not full DDD decomposition." | There is no such thing as a line-count refactoring. The only valid reason to split a file is responsibility separation. If the split doesn't produce files with single, articulable responsibilities, it is not a valid split. | Either do the genuine decomposition, or leave the file as-is and document why decomposition is not yet warranted. |

## Verification

- [ ] Every new file produced by the split can be described in one sentence without using "and" — write that sentence as a comment at the top of the file or in the PR description and confirm it holds.
- [ ] No file resulting from the split sits within 5% of the project's line-count threshold (e.g., 570–600 lines for a 600-line limit) — if it does, the split is incomplete.
- [ ] No blank lines or JSDoc comments were removed to reduce line count — diff the whitespace-only changes and confirm none appear in files that were structurally modified in the same commit.
- [ ] Every types file introduced contains only types that are referenced by at least three distinct bounded contexts — list the importing files; if fewer than three contexts import a type, move it to the file that owns it.
- [ ] No new circular imports were introduced and no intermediary files exist solely to break a cycle — run a dependency graph check and confirm import direction is unidirectional across bounded context boundaries.
- [ ] Every extracted file has a test or can be tested in isolation without importing from its sibling split files — if a test for file A requires importing from file B (the other half of the split), the boundary was drawn wrong.
