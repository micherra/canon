---
id: pure-io-service-split
title: Split Services Into a Pure Entry Point and an I/O Companion
severity: convention
scope:
  layers:
    - features
tags:
  - architecture
  - testability
  - services
---

Services under `features/*/services/` expose at least one pure entry-point function that accepts signals or state as arguments and returns a result. All infrastructure I/O — DB reads, knowledge-graph queries, event logging — is isolated in a companion gather or read function, or delegated to a tool wrapper via injection. Pure and I/O functions live in the same file; the boundary is documented in the module JSDoc.

## Rationale

Pure functions are trivially unit-testable: no stubs, no mocks, no async fixtures. When a service mixes computation with database reads or side effects, the only test path runs against real (or fully mocked) infrastructure. Separating the pure core from the I/O wrapper means the logic can be tested with plain data literals while the I/O layer is tested separately with integration or contract tests.

This pattern also clarifies the service's contract. Callers that already hold the necessary state can call the pure function directly. Callers that need to fetch state first use the I/O companion. The split is self-documenting: the pure function's signature is an explicit list of what information the computation depends on.

Three confirmed instances in this codebase establish the pattern: `confidence-scorer.ts` (`computeConfidence` pure, `gatherSignals` I/O), `escalation-cascade.ts` (`getNextStrategy` pure, `readEscalationState`/`writeEscalationState` I/O), and the KG `LanguageAdapter` (processing logic vs. file parsing).

## Examples

**Bad — I/O and computation entangled:**

```typescript
// Cannot test computeScore without a real DB connection
async function computeScore(jobId: string): Promise<Score> {
  const signals = await db.query("SELECT * FROM signals WHERE job_id = $1", [jobId]);
  const weights = await kgClient.getWeights(jobId);

  // Pure logic buried inside async function
  const raw = signals.reduce((sum, s) => sum + s.value * weights[s.type], 0);
  return { raw, normalized: raw / signals.length };
}
```

**Good — pure entry point + I/O companion in the same file:**

```typescript
/**
 * Pure entry point — accepts pre-fetched signals and weights.
 * I/O companion: gatherScoreInputs (below).
 */
export function computeScore(signals: Signal[], weights: WeightMap): Score {
  const raw = signals.reduce((sum, s) => sum + s.value * weights[s.type], 0);
  return { raw, normalized: raw / signals.length };
}

/** I/O companion — fetches state, then delegates to computeScore. */
export async function computeScoreForJob(jobId: string): Promise<Score> {
  const signals = await db.query("SELECT * FROM signals WHERE job_id = $1", [jobId]);
  const weights = await kgClient.getWeights(jobId);
  return computeScore(signals, weights);
}
```

**Good — injection variant (tool wrapper provides I/O):**

```typescript
export function getNextStrategy(
  state: EscalationState,
  policies: Policy[],
): Strategy {
  return policies.find(p => p.matches(state)) ?? defaultStrategy;
}

export async function advanceEscalation(
  caseId: string,
  db: DbClient,
): Promise<Strategy> {
  const state = await db.readEscalationState(caseId);
  const policies = await db.loadPolicies();
  const next = getNextStrategy(state, policies);
  await db.writeEscalationState(caseId, applyStrategy(state, next));
  return next;
}
```

## Exceptions

Services whose only logic is I/O orchestration with no meaningful computation (e.g., a passthrough proxy, a simple CRUD wrapper) do not benefit from the split. The principle targets services that contain conditional logic, scoring, ranking, or transformation — computations that are worth testing independently of infrastructure. Framework lifecycle hooks (e.g., NestJS providers, Express middleware) may not be amenable to extraction; apply the split to the business logic they delegate to, not the framework scaffolding itself.

**Related:** `command-query-separation` — the pure function is the query side; the I/O companion is the command/coordination side. `no-hidden-side-effects` — the pure function must not reach outside its arguments.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "This principle is too strict for this case." | Principles prevent common failure modes specifically in edge cases and delivery pressure, where shortcuts look most attractive. | Apply the principle unless a concrete, bounded exception is documented under `## Exceptions`. |
| "We'll clean it up after this ships." | Deferred quality work usually becomes permanent debt and normalizes repeated violations. | Implement the compliant approach now, or record an explicit follow-up with owner and due date. |
| "Code review can catch this later." | Manual review is inconsistent under time pressure and cannot replace explicit constraints. | Encode compliance in code structure, tests, or linting so violations fail fast and repeatably. |
| "This is just a small change, so the rule doesn't matter." | Small changes accumulate into systemic drift when principles are waived incrementally. | Hold small changes to the same bar and verify the invariant still holds after each change. |

## Verification

- [ ] Updated files satisfy this principle's core constraint in behavior and structure.
- [ ] Any deviation is explicitly documented under `## Exceptions` with rationale and bounds.
- [ ] Tests, lints, or checks were added/updated where needed so regressions are detectable.
