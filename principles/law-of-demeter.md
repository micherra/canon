---
id: law-of-demeter
title: Talk to Neighbors, Not Strangers
severity: convention
scope:
  languages: []
  layers: []
tags:
  - coupling
  - encapsulation
  - clean-code
---

A method should only call methods on objects it directly knows about: its own instance, its parameters, objects it creates, and its direct components. Avoid "train wreck" chains like `order.getCustomer().getAddress().getCity().getName()` — each dot couples you to the internal structure of another object. If the chain is longer than two dots, you're probably reaching through objects you shouldn't know about.

## Rationale

Long method chains couple the caller to the internal structure of every object in the chain. If `Customer` changes how it stores addresses, every caller that reached through `customer.getAddress().getCity()` breaks. The caller shouldn't know that a customer *has* an address object that *has* a city object — it should just ask the customer for what it needs.

This is often called the "principle of least knowledge." Each module should have limited knowledge of other modules: only modules "closely" related to the current module. The more objects you reach through, the more assumptions you embed, and the more fragile the code becomes.

## Examples

**Bad — reaching through object chains:**

```typescript
// Caller knows the internal structure of Order, Customer, and Address
function getShippingLabel(order: Order): string {
  const name = order.getCustomer().getName();
  const street = order.getCustomer().getAddress().getStreet();
  const city = order.getCustomer().getAddress().getCity();
  const zip = order.getCustomer().getAddress().getZipCode();
  return `${name}\n${street}\n${city}, ${zip}`;
}

// Even worse: conditional logic based on deep structure
if (order.getCustomer().getAccount().getSubscription().getTier() === "premium") {
  applyDiscount(order);
}
```

**Good — ask the object to do the work:**

```typescript
// Let Order/Customer handle their own structure
function getShippingLabel(order: Order): string {
  return order.getShippingLabel(); // Order knows how to format this
}

// Or: pass the data you need, not the entire object chain
function getShippingLabel(customer: { name: string; address: Address }): string {
  return `${customer.name}\n${customer.address.format()}`;
}

// Let the order check its own eligibility
if (order.qualifiesForDiscount()) {
  applyDiscount(order);
}
```

## Exceptions

Fluent APIs and builder patterns are designed for chaining and don't violate this principle — each call returns the same or a new builder object, not a different internal component. Data-only objects (DTOs, records, plain data structures) without behavior are also fine to navigate — `config.database.host` is reading a data structure, not reaching through encapsulated behavior.

**Related:** `aggregates-reference-by-id` is the DDD-specific, stronger form of this principle — aggregates must not even hold direct object references to other aggregates, using IDs instead. This prevents cascade loading and preserves transactional boundaries at the domain modeling level.
