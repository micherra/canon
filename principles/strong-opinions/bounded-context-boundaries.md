---
id: bounded-context-boundaries
title: Enforce Bounded Context Boundaries in Code
severity: strong-opinion
portable: true
scope:
  layers:
    - domain
tags:
  - ddd
  - boundaries
  - modularity
---

Code within one bounded context must not directly import or reference domain types from another bounded context. Cross-context communication uses integration patterns: published events, shared kernel (explicitly defined and versioned), or anti-corruption layers that translate between contexts. If module A imports domain model B, they are in the same bounded context — make that explicit or fix the boundary.

## Rationale

*Implementing Domain-Driven Design* and *Learning Domain-Driven Design* identify bounded contexts as the most important structural pattern in DDD. A bounded context defines where a domain model is valid — inside the context, terms have precise meaning; outside, they may mean something different. "Account" in the Banking context means a financial account; in the Authentication context, it means a login credential. Sharing the same `Account` class across both contexts forces one model to serve two purposes, and it will serve neither well.

When context boundaries are violated in code (direct imports across contexts), changes in one context break another. The coupling is invisible — there is no compiler warning when the Sales context renames a field that Billing was importing.

The failure mode: the Billing context imports `Order` from the Sales context. Sales renames `Order.total` to `Order.subtotal` and adds a new `Order.total` that includes tax. Billing now silently uses the wrong field, generating incorrect invoices.

## Examples

**Bad — direct cross-context import:**

```typescript
// billing/services/invoice-generator.ts
import { Order } from "../../sales/domain/order";        // Cross-context import!
import { Customer } from "../../sales/domain/customer";  // Cross-context import!

function generateInvoice(order: Order, customer: Customer): Invoice {
  return {
    customerName: customer.name,
    amount: order.total,        // Which "total"? Sales defines this, Billing depends on it
    items: order.lineItems,     // Billing is coupled to Sales' internal structure
  };
}
```

**Good — anti-corruption layer translates between contexts:**

```typescript
// billing/domain/billable-order.ts — Billing's own domain type
interface BillableOrder {
  orderId: string;
  lineItems: BillableLineItem[];
  totalAmount: number;
  currency: string;
}

// billing/integration/sales-acl.ts — Anti-corruption layer
import type { OrderPlacedEvent } from "@company/events"; // Shared event schema

function toBillableOrder(event: OrderPlacedEvent): BillableOrder {
  return {
    orderId: event.orderId,
    lineItems: event.items.map(item => ({
      description: item.productName,
      quantity: item.quantity,
      unitPrice: item.price,
    })),
    totalAmount: event.totalWithTax,
    currency: event.currency,
  };
}
```

The anti-corruption layer (`toBillableOrder`) is the only place where Billing knows about Sales' data shape. If Sales changes its event format, only this translation function needs updating — the rest of Billing is unaffected.

## Exceptions

Deliberately shared kernels — where two contexts agree to share a small, stable set of types — are acceptable when explicitly documented, versioned, and owned by both teams. Utility types without domain semantics (`Result<T>`, `DateRange`, `Money`) are fine to share across contexts — they carry no context-specific meaning. Monoliths with clear module boundaries but a single deployment may use direct imports with documented context boundaries as a pragmatic compromise.

## Related

- [[decompose-by-domain-not-layer]] — bounded contexts are the strategic design; domain decomposition is the tactical implementation: you decompose by domain precisely in order to create and respect bounded context boundaries.
- [[services-own-their-data]] — a service that owns its data store exclusively is the deployment-level enforcement of a bounded context boundary; sharing a database across services violates the context boundary in code AND at the infrastructure level.
- [[aggregates-reference-by-id]] — within a bounded context, aggregates must reference other aggregates by ID only; across context boundaries, direct model imports are forbidden entirely — both principles enforce the same isolation at different scopes.
