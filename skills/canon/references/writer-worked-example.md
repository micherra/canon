# Writer Worked Example

A complete principle file looks like this:

```markdown
---
id: thin-handlers
title: Keep Handlers Thin
severity: strong-opinion
scope:
  layers: [api]
  file_patterns: ["**/handlers/**", "**/routes/**", "**/controllers/**"]
tags: [architecture, api, separation-of-concerns]
---

Handlers (route handlers, controllers, resolvers) must only parse input, call a service, and format the response. No business logic, no direct data access, no orchestration.

## Rationale

Fat handlers couple request handling to business logic, making both untestable in isolation. When logic lives in a service, it can be called from handlers, CLI commands, queues, and tests alike.

## Examples

Bad — handler contains business logic:
\```typescript
app.post('/orders', async (req, res) => {
  const items = req.body.items;
  let total = 0;
  for (const item of items) {
    const product = await db.products.find(item.id);
    total += product.price * item.qty;
  }
  const order = await db.orders.create({ items, total });
  res.json(order);
});
\```

Good — handler delegates to service:
\```typescript
app.post('/orders', async (req, res) => {
  const result = await orderService.create(req.body);
  if (!result.ok) return res.status(400).json(result.error);
  res.status(201).json(result.data);
});
\```

## Exceptions

- Health check and readiness probe endpoints may inline simple logic.
- File streaming endpoints where the handler IS the logic.
```
