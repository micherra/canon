---
id: aggregates-reference-by-id
title: Aggregates Reference Other Aggregates by ID Only
severity: strong-opinion
scope:
  languages: []
  layers:
    - domain
tags:
  - ddd
  - aggregates
  - coupling
---

Aggregates must reference other aggregates by identity (ID) only, never by direct object reference. An `Order` aggregate holds a `customerId: string`, not a `customer: Customer` object. Cross-aggregate operations go through repositories or domain services, not object graph traversal. Loading one aggregate must never cascade-load another.

## Rationale

*Implementing Domain-Driven Design* and *Learning Domain-Driven Design* both establish that aggregates are consistency boundaries — each aggregate is a transactional unit that enforces its own invariants. Direct object references between aggregates break this boundary in several ways: they create cascade-loading problems (loading an Order loads the Customer, which loads their Orders, which loads...), they make it impossible to put aggregates in different services later, and they blur transactional boundaries (which aggregate is responsible for consistency?).

The failure mode: `Order` has a `customer: Customer` property. The ORM eagerly loads the customer with every order query. Then someone writes `order.customer.address.city` — traversing three aggregates in one expression. The ORM generates N+1 queries. Performance degrades. Someone adds `{ eager: true }` to fix the N+1, and now every order query joins the customer table, the address table, and the city table. One entity class has become an implicit join across the entire database.

## Examples

**Bad — direct object references between aggregates:**

```typescript
class Order {
  id: string;
  customer: Customer;           // Direct reference to another aggregate
  items: OrderItem[];

  calculateDiscount(): number {
    // Traversing aggregate boundaries through object graph
    if (this.customer.loyaltyTier === "gold") {
      return this.total() * 0.1;
    }
    // What if customer's tier changes mid-transaction?
    // Which aggregate's transaction wins?
    return 0;
  }
}

class Customer {
  id: string;
  orders: Order[];             // Bidirectional reference — loads everything
  loyaltyTier: string;
  address: Address;            // Yet another aggregate navigable through Customer
}
```

**Good — ID references with domain services for cross-aggregate operations:**

```typescript
class Order {
  id: string;
  customerId: string;          // ID reference only — no cascade loading
  items: OrderItem[];

  total(): number {
    return this.items.reduce((sum, item) => sum + item.subtotal(), 0);
  }
}

// Cross-aggregate logic in a domain service
class DiscountCalculator {
  constructor(private customerRepo: CustomerRepository) {}

  async calculateDiscount(order: Order): Promise<number> {
    const customer = await this.customerRepo.findById(order.customerId);
    if (!customer) return 0;
    if (customer.loyaltyTier === "gold") {
      return order.total() * 0.1;
    }
    return 0;
  }
}
```

Loading an `Order` is now a single query. The `DiscountCalculator` explicitly loads the `Customer` when needed — no hidden cascade, no N+1, no ambiguous transaction boundary.

## Exceptions

Within the same aggregate, direct references are expected — that defines the aggregate boundary. Value objects embedded within an aggregate (`Address` inside `Customer`, `OrderItem` inside `Order`) are direct references by design. In read models or DTOs projected for display purposes, denormalized object graphs are acceptable — they are not domain aggregates and carry no consistency invariants.

**Related:** `law-of-demeter` is the general OOP version of this constraint — don't reach through object chains. This principle is the DDD-specific, stronger form: aggregates must not hold direct references to other aggregates at all, preventing cascade loading and preserving transactional boundaries. Demeter says "don't traverse"; this says "don't even hold the reference."
