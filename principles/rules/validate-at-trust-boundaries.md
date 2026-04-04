---
id: validate-at-trust-boundaries
title: Validate Data at Every Trust Boundary
severity: rule
scope:
  layers:
    - api
    - infra
tags:
  - security
  - threat-modeling
  - validation
---

Every trust boundary crossing — API endpoints, service-to-service calls, file reads, user input, webhook receivers, third-party API responses — must have explicit input validation. Data crossing a boundary must be validated for type, format, size, and business rules before use. Never trust data simply because it comes from an "internal" source.

## Rationale

*Threat Modeling: Designing for Security* introduces the STRIDE model, where trust boundaries are the primary unit of threat analysis. A trust boundary is any point where data crosses from one trust zone to another: user → server, service A → service B, file system → application. At each crossing, the receiving side must validate that data conforms to its expectations.

The most dangerous assumption in distributed systems is "this data comes from our own service, so it's safe." Internal services have bugs. Internal services get compromised. Internal data stores get corrupted. Every boundary crossing is an opportunity for invalid data to enter the system.

This complements `agent-assume-hostile-input` (an agent workflow rule in `.claude/rules/` that governs how the AI approaches input handling). This principle is the architectural pattern: where in the system architecture must validation occur?

## Examples

**Bad — trusting data because it's "internal":**

```typescript
// API handler uses request body without validation
app.post("/api/orders", async (req, res) => {
  const order = await createOrder(req.body); // What shape is req.body? Who knows.
  res.json(order);
});

// Service trusts response from another internal service
async function getOrderTotal(orderId: string): Promise<number> {
  const response = await fetch(`http://pricing-service/calculate/${orderId}`);
  const data = await response.json();
  return data.total; // What if pricing service returns { error: "not found" }?
}
```

**Good — explicit validation at every boundary:**

```typescript
// API handler validates input with a schema
const CreateOrderSchema = z.object({
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().positive().max(1000),
  })).min(1).max(100),
  shippingAddress: AddressSchema,
});

app.post("/api/orders", async (req, res) => {
  const parsed = CreateOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ errors: parsed.error.issues });
  const order = await createOrder(parsed.data);
  res.json(order);
});

// Service validates response from another service
const PricingResponseSchema = z.object({
  total: z.number().nonnegative(),
  currency: z.string().length(3),
});

async function getOrderTotal(orderId: string): Promise<PricingResult> {
  const response = await fetch(`http://pricing-service/calculate/${orderId}`);
  const data = await response.json();
  const parsed = PricingResponseSchema.safeParse(data);
  if (!parsed.success) return { ok: false, error: "invalid_pricing_response" };
  return { ok: true, data: parsed.data };
}
```

## Exceptions

Internal function calls within the same trust boundary (same service, same process) do not need boundary validation — that would be excessive defensive programming. TypeScript's type system provides compile-time validation within a trust boundary. Performance-critical hot paths may validate once at the boundary and pass validated types internally.
