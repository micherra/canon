---
id: agent-design-before-code
title: Design Before Code
severity: rule
scope:
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

Trivial tasks (renaming a variable, fixing a typo, updating config) don't need a design document. The PM triages these and routes them directly to the engineer, skipping the architect.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|----------------|----------------|
| "This change is too small for a design document." | Small tasks still require decisions about file placement, naming, and principle alignment. Without a design, implementors make those decisions independently and inconsistently. | Produce a minimal design: one paragraph on approach, Canon alignment notes, and any open questions. Small scope means a fast design, not no design. |
| "I already know the approach — writing it down is busy work." | An undocumented approach exists only in one agent's context. The design document is the handoff artifact — without it, implementors must infer your intent. | Write the design. If it's truly obvious, it takes five minutes. If it's not, you needed to think it through anyway. |
| "The research findings already describe the solution." | Research documents describe what exists, not what to build. They don't map decisions to principles, resolve tensions, or lock down choices implementors will face. | Synthesize research into a design that explicitly states decisions, principle alignment, and tradeoffs. Research is input; the design is the output. |
| "I'll clarify details in the plan tasks." | Plan tasks specify scope and files. They cannot substitute for design reasoning — implementors will encounter decisions the tasks don't cover and will guess. | Resolve every meaningful decision in the design document before writing plan tasks. Tasks should implement a locked design, not explore an open one. |
