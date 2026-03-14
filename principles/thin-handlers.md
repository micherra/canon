---
id: thin-handlers
title: Handlers Are Thin Orchestrators
severity: strong-opinion
scope:
  languages: []
  layers:
    - api
  file_patterns:
    - "**/*.controller.*"
    - "**/routes/**"
    - "**/api/**"
tags:
  - separation-of-concerns
  - testability
  - simplicity
---

HTTP handlers, route controllers, and API entry points should do three things: validate input, call a service, and return a response. Business logic belongs in service modules, not handler files.

## Rationale

Fat handlers are how web applications become unmaintainable. They start simple, then accumulate conditionals, database calls, and transformation logic until they're 200-line monoliths. This pattern recurs across every framework — Express, Next.js, FastAPI, Spring.

Keeping handlers thin means: business logic is testable without an HTTP layer, the API surface is scannable at a glance, and you can change the web framework without rewriting business rules.

## Examples

**Bad — business logic in the handler:**

```typescript
app.post("/api/orders", async (req, res) => {
  const { userId, items } = req.body;
  if (!userId || !items?.length) {
    return res.status(400).json({ error: "Missing fields" });
  }
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user) return res.status(404).json({ error: "User not found" });
  let total = 0;
  for (const item of items) {
    const product = await db.product.findUnique({ where: { id: item.productId } });
    if (product.stock < item.quantity) {
      return res.status(422).json({ error: `Insufficient stock` });
    }
    total += product.price * item.quantity;
  }
  const order = await db.order.create({ data: { userId, items, total } });
  return res.status(201).json({ order });
});
```

**Good — handler validates and delegates:**

```typescript
app.post("/api/orders", async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const result = await orderService.create(parsed.data);
  if (!result.ok) {
    return res.status(result.statusCode).json({ error: result.error });
  }
  return res.status(201).json({ order: result.data });
});
```

## Exceptions

Trivial endpoints with no business logic — health checks, simple lookups — don't need the indirection. If the handler is under ~15 lines with no branching beyond validation, it's fine as-is.

**Related:** `consistent-abstraction-levels` generalizes this principle to all functions, not just HTTP handlers — any function that mixes orchestration with low-level detail is mixing abstraction levels.
