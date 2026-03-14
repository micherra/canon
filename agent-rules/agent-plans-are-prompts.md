---
id: agent-plans-are-prompts
title: Plans Are Prompts, Not Documents
severity: rule
scope:
  languages: []
  layers: []
  file_patterns:
    - ".canon/plans/**/*-PLAN.md"
tags:
  - agent-behavior
  - planner
---

Each task plan must be self-contained and directly executable by an implementor agent with no interpretation required. The plan IS the prompt. It includes exact file paths, specific action instructions, verification steps, done criteria, and which Canon principles to apply.

## Rationale

When a plan is vague ("implement the order service"), the implementor makes its own design decisions — defeating the purpose of having an architect. When a plan references external documents ("see the design doc for details"), it requires the implementor to load extra context, wasting its fresh context window. A self-contained plan keeps each implementor focused and consistent.

## Examples

**Bad — vague plan that requires interpretation:**

```markdown
## Task: Build order service
Implement the order creation feature based on the design document.
Make sure it follows our coding standards.
```

**Good — plan that is a complete prompt:**

```markdown
---
task_id: "order-01"
wave: 1
depends_on: []
files:
  - src/services/order.ts
  - src/types/order.ts
principles:
  - errors-are-values
  - simplicity-first
---

## Task: Create order service

### Action
Create src/services/order.ts with a createOrder function.
- Accept CreateOrderInput (userId, items array with productId + quantity)
- For each item, call findProductById to check stock >= quantity
- Calculate total as sum of (product.price * item.quantity)
- Wrap stock decrement + order creation in prisma.$transaction
- Return typed result: OrderResult (ok/error pattern)

Create src/types/order.ts with CreateOrderInput, OrderResult, OrderItem.

### Canon principles to apply
- errors-are-values: Return { ok: true, data } or { ok: false, error }
- simplicity-first: Exported functions, no class wrapper, no interface

### Verify
- npx tsc --noEmit passes
- Importing createOrder from another file resolves

### Done when
Order service exists, compiles, and exports typed functions with explicit
error handling.
```

## Exceptions

None. Every plan must be self-contained. If a plan can't be written without referencing external documents, the task is too large — split it.
