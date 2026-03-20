---
id: agent-context-sync
title: Diff-Driven, Contract-Scoped Updates
severity: rule
scope:
  layers: []
tags:
  - agent-behavior
  - scribe
---

The scribe agent updates documentation only when the contract surface of the codebase changes. It reads git diffs and implementor summaries, classifies changes as contract-level or internal, and makes surgical edits to CLAUDE.md, context.md, and CONVENTIONS.md. It never rewrites documents from scratch, never proposes new principles, and exits immediately with NO_UPDATES when all changes are internal.

## Rationale

Documentation drift is the silent killer of AI-assisted development. When CLAUDE.md says the API returns `string` but the code returns `Result<string, Error>`, every agent that reads CLAUDE.md makes decisions on stale information. But updating docs on every change creates noise — a renamed private variable doesn't change what agents need to know. The contract-scoped filter ensures docs stay accurate without drowning in irrelevant updates.

The scribe is intentionally constrained to documenting what IS, not proposing what SHOULD BE. Pattern detection and principle suggestions are the learner's job. Mixing these responsibilities would create a slow, opinionated bottleneck in every build.

## Examples

**Bad — scribe updates docs for internal refactor:**

```
# Git diff shows: renamed `calcTotal` to `calculateTotal` (private helper)

# Scribe updates CLAUDE.md:
## Contracts
- `calculateTotal()` (renamed from `calcTotal`) — computes order total
```

This is noise. `calcTotal` was never in the contract surface. The scribe should classify this as `internal` and exit with NO_UPDATES.

**Good — scribe updates docs for new public API:**

```
# Git diff shows: new endpoint POST /api/v2/orders with Result return type
# Implementor summary confirms: "Added v2 orders endpoint returning Result<Order, ValidationError>"

# Scribe edits CLAUDE.md:
## Contracts
<!-- last-updated: 2025-01-15 -->
- `POST /api/v2/orders` — creates order, returns `Result<Order, ValidationError>`
```

The new endpoint is a contract change. The scribe adds one line to the Contracts section and stamps the date.

**Bad — scribe proposes a new convention from observed patterns:**

```
# Scribe notices 5 files use Zod for validation
# Scribe adds to CONVENTIONS.md:
- **Validation**: Use Zod for all input validation
```

The scribe must never infer conventions from patterns. That's the learner's job (Dimension 1: Codebase Pattern Inference). The scribe only adds to CONVENTIONS.md when an implementor explicitly established a new pattern documented in their summary.

**Good — scribe exits quickly on test-only changes:**

```
# Git diff shows: 3 new test files, 0 source files changed

---
status: "NO_UPDATES"
agent: canon-scribe
timestamp: "2025-01-15T10:30:00Z"
---
## Context Sync
### Changes Classified
| File | Category | Doc Updated |
|------|----------|-------------|
| `tests/order.test.ts` | test-only | — |
| `tests/payment.test.ts` | test-only | — |
| `tests/shipping.test.ts` | test-only | — |
### Documents Updated
- **CLAUDE.md**: No updates needed
- **context.md**: No updates needed
- **CONVENTIONS.md**: No updates needed
```

Fast classification, fast exit. No wasted tokens.

## Exceptions

None. The scribe always operates in this mode. If broader documentation changes are needed (e.g., initial project setup, major restructuring), that's a human task or a dedicated command — not the scribe's automatic hook.
