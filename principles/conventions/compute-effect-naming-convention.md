---
id: compute-effect-naming-convention
title: Pure Functions Use compute* Prefix; Effect Functions Use Effect-Indicating Prefix
severity: convention
scope:
  layers: []
  file_patterns:
    - "mcp-server/src/**"
tags:
  - naming
  - testability
  - functions
---

Pure functions that perform computation without I/O or side effects MUST be named with a `compute*` prefix. Functions that perform I/O, DB writes, event emission, or logging MUST be named with an effect-indicating prefix (`log*`, `write*`, `store*`, `record*`). Coordinator functions that orchestrate both call each explicitly by name.

The naming is the primary signal to a code reader — and to the test author — that a function is safe to call in unit-test context without mocking. A `compute*` function accepts inputs and returns a value; no stubs needed. An effect-side function touches infrastructure; it belongs in integration or contract tests, not unit tests.

## Rationale

When a pure function and a side-effecting function share a vague name (`process*`, `handle*`, `get*`), a test author cannot tell at a glance whether the function is safe to call without infrastructure. The `compute*` / effect prefix contract makes that judgment mechanical: if the name starts with `compute`, no mocks are needed; if it starts with `log`, `write`, `store`, or `record`, expect I/O.

This naming contract also makes the extraction decision mechanical when refactoring mixed-responsibility functions to satisfy `functions-do-one-thing` and `no-hidden-side-effects`. The rule is simple: pull the pure logic into a `compute*` function, leave the I/O in the effect-prefixed caller. No design judgment required.

Seven confirmed instances in `mcp-server/src/` establish this as a load-bearing convention. The pattern co-occurs with `pure-io-service-split` — compute functions are the pure entry points; effect functions are the I/O companions.

## Examples

**Bad — vague name gives no signal about purity or side effects:**

```typescript
// Is this safe to call in a unit test? Unknown from the name alone.
function processViolation(violation: Violation, signals: Signal[]): AnnotatedViolation {
  const score = signals.reduce((sum, s) => sum + s.weight, 0);
  db.record("violation_processed", { violation_id: violation.id }); // hidden side effect
  return { ...violation, confidence: score };
}
```

**Bad — effect function named like a pure function:**

```typescript
// Name implies pure; body has a DB write — misleads callers and test authors
function computeOutcome(input: OutcomeInput): void {
  db.insert("violation_outcomes", input); // not a computation
}
```

**Good — pure computation named with compute*:**

```typescript
// Safe to call in any unit test — no mocks, no stubs, no async
export function computeViolationConfidence(
  violation: Violation,
  signals: Signal[],
): ConfidenceAnnotation {
  const score = signals.reduce((sum, s) => sum + s.weight, 0);
  return { violation_id: violation.id, confidence: score };
}
```

**Good — effect side named with effect-indicating prefix:**

```typescript
// Name signals: this touches infrastructure; use integration tests
export async function recordOutcome(input: OutcomeInput): Promise<void> {
  await db.insert("violation_outcomes", input);
}
```

**Good — coordinator calls both explicitly:**

```typescript
// The call site reads like a recipe: compute first, then record
export async function processViolation(
  violation: Violation,
  signals: Signal[],
  db: DbClient,
): Promise<void> {
  const annotation = computeViolationConfidence(violation, signals);
  await recordOutcome({ ...annotation, recorded_at: new Date().toISOString() });
  logViolationProcessed(violation.id);
}
```

**Confirmed instances in this codebase:**

| Function | File | Role |
|----------|------|------|
| `computeConfidenceAnnotation` | `shared/lib/confidence.ts` | pure |
| `computeViolationConfidence` | `orchestration/services/review-confidence-adapter.ts` | pure |
| `computeComplianceConfidence` | `platform/storage/drift/drift-confidence-adapter.ts` | pure |
| `computeAutonomyTier` | `orchestration/tools/compute-autonomy-tier.ts` | pure |
| `computeTierResult` | `orchestration/tools/compute-autonomy-tier.ts` | pure |
| `logAutonomyTierDecision` | `orchestration/tools/compute-autonomy-tier.ts` | effect — logs `auto_decision` event |
| `recordOutcome` | `platform/storage/drift/` | effect — DB write to `violation_outcomes` |

## Exceptions

Functions whose role is orchestration without meaningful computation may use `run*`, `execute*`, or `handle*` if no pure/effect split exists. Framework lifecycle hooks (constructors, middleware, event handlers) are excluded — apply the convention to the business logic they delegate to, not the scaffolding. Functions that are both pure and perform trivial string formatting may use `format*` or `build*` as alternatives to `compute*` when the formatting intent is clearer; in these cases, the function must still be side-effect free.

**Related:** `compute-effect-separation` — the architectural separation this naming enforces. `naming-reveals-intent` — the general principle this convention concretizes. `pure-io-service-split` — structural companion: compute functions are the pure entry points; effect functions are the I/O companions. `no-hidden-side-effects` — the side-effect prohibition that `compute*` names make explicit.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "This principle is too strict for this case." | Principles prevent common failure modes specifically in edge cases and delivery pressure, where shortcuts look most attractive. | Apply the principle unless a concrete, bounded exception is documented under `## Exceptions`. |
| "We'll clean it up after this ships." | Deferred quality work usually becomes permanent debt and normalizes repeated violations. | Implement the compliant approach now, or record an explicit follow-up with owner and due date. |
| "`get*` or `process*` is clearer for this function." | Vague prefixes destroy the testability signal. A reader cannot tell from `getScore` or `processViolation` whether infrastructure is involved. | Use `compute*` for pure functions; use an effect prefix for I/O functions. The name must carry the purity signal. |
| "The function is too small to matter." | Small functions with mixed names accumulate into systemic naming drift. The convention is most valuable precisely for small, focused functions — the naming cost is zero. | Name it correctly regardless of size. |

## Verification

- [ ] Every new pure function in `mcp-server/src/**` that performs computation is named with a `compute*` prefix (or a documented exception such as `format*`/`build*`).
- [ ] Every new function that performs I/O, DB writes, event emission, or logging is named with an effect-indicating prefix (`log*`, `write*`, `store*`, `record*`).
- [ ] No `compute*` function contains a DB write, network call, event emission, or log statement.
- [ ] Any deviation is explicitly documented under `## Exceptions` with rationale and bounds.
