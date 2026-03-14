---
id: agent-scoped-research
title: Research One Dimension Deeply
severity: rule
scope:
  layers: []
  file_patterns:
    - ".canon/plans/*/research/**"
tags:
  - agent-behavior
  - researcher
---

Each researcher agent investigates exactly one dimension of the problem — codebase patterns, external domain knowledge, architecture fit, or risk. Never attempt to cover everything. Depth on one dimension beats shallow coverage of many.

## Rationale

Parallel researchers are effective because each one goes deep on a narrow scope. When a researcher tries to cover "codebase + domain + architecture" in one pass, it produces a surface-level summary that the architect can't act on. The orchestrator merges findings from multiple focused researchers into a complete picture — that's its job, not the researcher's.

## Examples

**Bad — researcher tries to cover everything:**

```markdown
## Research Findings
- The codebase uses Express for routing
- React documentation recommends server components
- There might be security concerns with the auth flow
- Several npm packages could help
```

**Good — researcher goes deep on one dimension:**

```markdown
## Codebase Research: Order Creation

### Relevant existing patterns
- All services in src/services/ follow the typed result pattern
  (e.g., src/services/auth.ts returns AuthResult)
- Existing order-related code: src/types/product.ts defines Product
  type with stock field, src/data/products.ts has findById query

### Files likely affected
- src/services/order.ts (new)
- src/types/order.ts (new)
- src/app/api/orders/route.ts (new)
- src/data/products.ts (needs stock decrement query)

### Applicable Canon principles
- [errors-are-values] — all existing services use this pattern
- [thin-handlers] — all existing routes follow validate-delegate-return

### Concerns
- No existing transaction support in data layer. Stock decrement +
  order creation should be atomic. Check if Prisma transactions are
  already configured.
```

## Exceptions

None. If a research dimension feels too narrow to fill a findings document, that's a signal the task is well-understood and research can be skipped for that dimension.
