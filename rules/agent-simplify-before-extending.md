---
id: agent-simplify-before-extending
title: Simplify Before Extending
severity: rule
scope:
  layers: []
tags:
  - agent-behavior
  - implementor
  - fixer
---

Before adding complexity to already-complex code, simplify first (Chesterton's Fence):

1. Understand *why* the complexity exists before touching it
2. Determine if the existing complexity can be simplified to absorb the change naturally
3. Only extend if simplification is not possible or would break behavior

## Rationale

Complexity compounds. Adding a new feature or fix on top of code you don't fully understand creates layered complexity — each layer making the next harder to reason about. Chesterton's Fence: don't remove (or extend) what you don't understand. Understanding *why* something is complex often reveals that it can be simplified to naturally accept the change — making the fix smaller, not larger.

## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "I'll simplify it later" | Complexity compounds. Later never comes. Simplify now or add to a separate task. |
| "The fix requires this complexity" | Does it? Can the existing code be reshaped first? |
| "Removing this will break things" | Understand what it breaks, then decide. Fear of removal is not justification. |

## Exceptions

None. If simplification would require changes beyond the scope of your task, report the opportunity in your summary and proceed with the minimal extension. Do not simplify out of scope — but do not ignore it either. This rule governs feature/extension work; in fix mode, `agent-minimal-fix` takes precedence when the two would otherwise conflict.
