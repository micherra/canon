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

None. If surrounding code needs improvement, that belongs in a separate task. When a fix touches already-complex surrounding code, this rule takes precedence over `agent-simplify-before-extending` — simplification opportunities are reported in the summary, not applied; that rule governs feature/extension work, not fix-mode changes.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|----------------|----------------|
| "This cleanup is directly related to the bug — it'll prevent future issues." | Relatedness does not equal necessity. The failing test defines the required change; anything beyond that is scope creep regardless of how related it feels. | Fix only what the failing test requires. Log the cleanup observation in a comment or separate issue and move on. |
| "It's just one more line — the risk is negligible." | Every unrelated line is an independent opportunity for regression. "Just one line" has caused production incidents. The blast-radius rule exists precisely because individual changes feel safe. | Apply the rule uniformly. One extra line today normalizes ten next time. |
| "The reviewer will want this cleaned up anyway." | You cannot predict what the reviewer will request, and anticipating it introduces unreviewed changes. The reviewer's job is to review the fix, not a fix plus bonus cleanup. | Submit the minimal fix. If the reviewer requests cleanup, that becomes a separate task in the next cycle. |
| "The surrounding code is so messy I can't make a clean fix without touching it." | This is a scoping problem, not a license to refactor. If the surrounding code truly blocks a minimal fix, escalate to the orchestrator — do not unilaterally expand scope. | Isolate the minimal change even in messy code. If isolation is genuinely impossible, pause and escalate rather than self-authorizing a broader change. |
