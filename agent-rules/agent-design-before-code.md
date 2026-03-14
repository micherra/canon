---
id: agent-design-before-code
title: Design Before Code
severity: rule
scope:
  languages: []
  layers: []
  file_patterns:
    - ".canon/plans/*/DESIGN.md"
tags:
  - agent-behavior
  - architect
---

The architect agent must produce a complete design document with Canon alignment notes before any implementation begins. The design must map every decision to a relevant principle and explicitly state which principles are in tension.

## Rationale

Skipping design and jumping to implementation is the single most expensive mistake in AI-generated codebases. Without a design, each implementor makes independent decisions that conflict with each other. The architect's job is to make those decisions once, check them against the canon, and lock them down so implementors don't have to guess.

## Examples

**Bad — architect jumps to file listing without design reasoning:**

```markdown
## Design
Files to create:
- src/services/order.ts
- src/app/api/orders/route.ts
- src/types/order.ts
```

**Good — design with principle alignment and explicit decisions:**

```markdown
## Design: Order Creation

### Approach
Single service function that validates stock, calculates total, and creates
the order in a transaction. Thin API route that validates input and delegates.

### Canon alignment
- [simplicity-first] ✓ — one service file, no abstract layers
- [thin-handlers] ✓ — route only validates + delegates
- [errors-are-values] ✓ — service returns OrderResult union type
- [no-dead-abstractions] ✓ — no IOrderService interface

### Decisions
1. Stock check + order creation wrapped in Prisma transaction
   (atomicity over simplicity — justified by data integrity)
2. Order total calculated server-side, never trust client amount
3. Return full order object in success case (client needs it for redirect)

### Open questions for user
- Should out-of-stock items fail the entire order or just be excluded?
```

## Exceptions

Trivial tasks (renaming a variable, fixing a typo, updating config) don't need a design document. The orchestrator can skip the architect for tasks flagged as trivial.
