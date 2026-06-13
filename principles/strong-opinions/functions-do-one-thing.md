---
id: functions-do-one-thing
title: Functions Do One Thing
severity: strong-opinion
portable: true
scope:
  layers: []
tags:
  - functions
  - readability
  - clean-code
  - ui
  - components
  - modularity
---

A function should do exactly one thing. If you can extract a meaningful sub-function from it — one whose name is not just a restatement of the parent function's name — the original function does too much. Functions should be short: typically under 30 lines of logic, excluding declarations and blank lines.

## Rationale

Long functions that do many things are the primary unit of technical debt. They're hard to name (because they do several things), hard to test (because you must set up state for every path), hard to reuse (because you only need part of what they do), and hard to modify (because changes to one concern risk breaking another).

AI-generated code is especially prone to long functions. When given a task like "build user registration," an LLM generates one function that validates, hashes passwords, checks uniqueness, creates the record, and sends an email. It works — but it's a monolith that can't be maintained without understanding the whole thing.

The test is simple: describe what the function does. If the description uses "and" or "then," it likely does more than one thing.

## Examples

**Bad — function does five things:**

```typescript
async function processOrder(input: OrderInput): Promise<Order> {
  // 1. Validate input
  if (!input.items.length) throw new Error("No items");
  if (!input.userId) throw new Error("No user");

  // 2. Check inventory
  for (const item of input.items) {
    const product = await db.product.findUnique({ where: { id: item.productId } });
    if (!product || product.stock < item.quantity) {
      throw new Error(`Insufficient stock for ${item.productId}`);
    }
  }

  // 3. Calculate total
  let total = 0;
  for (const item of input.items) {
    const product = await db.product.findUnique({ where: { id: item.productId } });
    total += product.price * item.quantity;
  }
  const tax = total * 0.08;
  const finalTotal = total + tax;

  // 4. Create order
  const order = await db.order.create({
    data: { userId: input.userId, total: finalTotal, items: input.items },
  });

  // 5. Send confirmation
  await sendEmail(input.userId, `Order ${order.id} confirmed: $${finalTotal}`);

  return order;
}
```

**Good — each function does one thing:**

```typescript
async function processOrder(input: OrderInput): Promise<OrderResult> {
  const validated = validateOrderInput(input);
  if (!validated.ok) return validated;

  const stockCheck = await verifyInventory(validated.data.items);
  if (!stockCheck.ok) return stockCheck;

  const total = calculateOrderTotal(stockCheck.data);
  const order = await createOrder(validated.data.userId, total, validated.data.items);
  await sendOrderConfirmation(order);

  return { ok: true, data: order };
}
```

Each extracted function has a clear, singular purpose and can be tested independently.

This applies at every level — functions, UI components, modules. A React component that fetches data, manages tooltip state, and handles navigation does too many things. Split rendering, data-fetching, and behavioral concerns into separate components or hooks so each piece can be understood, tested, and reused independently.

## Exceptions

Pure data transformation pipelines (map/filter/reduce chains) can be longer without being "multi-purpose" — they're doing one thing (transforming data) through multiple steps. Configuration/setup functions that initialize many related settings are doing one thing (configuration) even though they touch many values. Leaf UI components that combine a small amount of local state with rendering (a `<Toggle>` managing its own open/closed state) are fine — the state is intrinsic to the component's single purpose.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "It's all related — validation, transformation, and persistence all handle the same entity." | Relatedness of subject matter is not the same as singleness of purpose. Validate, transform, and persist are three distinct operations that change independently and fail independently. | Extract each concern into its own function. Compose them at the orchestration level. |
| "Splitting it into more functions would mean more files to navigate." | More small, well-named functions are easier to navigate than fewer large, multi-purpose ones. A function named `validateOrderInput` tells you exactly where to look; a 200-line `processOrder` does not. | Split by responsibility. File count is not a cost — confusion is. |
| "The function is readable — I can follow it top to bottom." | "Readable once" is not the same as "maintainable over time." Readability degrades as functions grow and logic branches multiply. | Apply the "and/then" test: if describing the function requires "and" or "then," it does more than one thing and should be split. |
| "It's only 50 lines — that's not too long." | Line count is a proxy, not the definition. A 50-line function with three unrelated responsibilities violates this principle; a 50-line pure transformation pipeline may not. | Evaluate by responsibility count, not line count. |

## Verification

- [ ] No functions exceed 40 lines of logic (excluding blank lines and declarations) — check for functions with high line counts in domain and service files, treating this as a smell requiring inspection.
- [ ] Function names do not use conjunctions suggesting multiple purposes — grep for function names containing `And`, `AndThen`, `AndSend`, `AndSave`, or similar compound verbs in domain and service layers.
