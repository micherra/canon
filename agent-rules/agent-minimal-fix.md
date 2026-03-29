---
id: agent-minimal-fix
title: Minimal Blast-Radius Fixes
severity: rule
scope:
  layers: []
tags:
  - agent-behavior
  - fixer
---

Fixer agents must change only what is necessary to resolve the reported issue. No refactoring, no cleanup, no "while I'm here" improvements. Every modified line must trace directly to the failing test or violation being fixed. All pre-existing tests must still pass after the fix.

## Rationale

Fix loops are the highest-risk phase of a build. The reported issue creates pressure to act quickly, and that urgency invites scope creep — renaming a variable, extracting a helper, tidying an import. Each unrelated change is a new opportunity for regression that has nothing to do with the original problem. When a fix introduces a new failure, the loop extends and the root cause becomes harder to isolate.

Keeping fixes atomic also makes them reviewable. A diff that touches only the broken behavior is easy to verify. A diff that mixes a fix with refactoring forces the reviewer to untangle which changes are load-bearing.

## Examples

**Bad — fix includes unrelated cleanup:**

```typescript
// Reported issue: discount calculation returns NaN for empty cart
function applyDiscount(cart: Cart, code: string): number {
-  const total = cart.items.reduce((sum, i) => sum + i.price * i.qty, 0);
+  if (!cart.items.length) return 0; // fix
+  const items = cart.items.filter(i => i.qty > 0); // "cleanup"
+  const total = items.reduce((sum, i) => sum + i.price * i.qty, 0);
+  // TODO: should validate code format here
   const factor = DISCOUNTS[code] ?? 1;
   return total * factor;
}
```

**Good — fix addresses only the reported issue:**

```typescript
function applyDiscount(cart: Cart, code: string): number {
+  if (!cart.items.length) return 0;
   const total = cart.items.reduce((sum, i) => sum + i.price * i.qty, 0);
   const factor = DISCOUNTS[code] ?? 1;
   return total * factor;
}
```

## Exceptions

None. If surrounding code needs improvement, that belongs in a separate task.
