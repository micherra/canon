---
id: compute-effect-separation
title: Extract Pure Computation from Effect-Bearing Functions
severity: convention
scope:
  layers:
    - shared
  file_patterns:
    - "mcp-server/src/**"
tags:
  - architecture
  - testability
  - functions
  - single-responsibility
---

When a function mixes pure computation with side effects (I/O, logging, DB writes, event emission), extract the computation into a dedicated pure function and keep effects in a separate effect function. The coordinator calls both explicitly in sequence: compute first, then effect.

This is the standard fix for `functions-do-one-thing` and `no-hidden-side-effects` violations that involve a value-computation entangled with a write or log. The extraction makes the computation independently testable and the effect visible at the call site.

## Rationale

Mixed-responsibility functions hide two failure modes in one body: a logic error and an effect error. When computation and side effects are entangled, you cannot unit-test the logic without triggering I/O, and you cannot observe the effect without running the computation first. Both become harder to debug and maintain.

Extracting pure computation removes the need for mocks or stubs in unit tests — the function is called with plain data and returns a plain result. The effect function becomes a named, narrow operation whose behavior is described by its name. The coordinator function's body then reads as a recipe: compute X, then log/write/store X. This makes the data flow and the side-effect site explicit to any reader.

Four confirmed instances in `mcp-server/src/` establish this as a load-bearing pattern. In every case the extraction was motivated by a `functions-do-one-thing` or line-count violation, and in every case the result satisfied both `functions-do-one-thing` and `no-hidden-side-effects` simultaneously.

## Examples

**Bad — computation and effect entangled in one body:**

```typescript
// Cannot unit-test the tier logic without triggering an audit log write
async function computeAutonomyTier(
  signals: TierSignals,
  workspace: string,
): Promise<TierResult> {
  const tier = signals.override_tier ?? deriveTierFromSignals(signals);
  const result = { tier, rationale: buildRationale(signals, tier) };

  // Hidden side effect — appends an audit event to the execution store
  await executionStore.append(workspace, { type: "auto_decision", ...result });
  return result;
}
```

**Good — computation and effect separated; coordinator calls both explicitly:**

```typescript
// Pure — deterministic, no I/O, testable with plain data literals
export function computeTierResult(
  signals: TierSignals,
  override_tier?: Tier,
): TierResult {
  const tier = override_tier ?? deriveTierFromSignals(signals);
  return { tier, rationale: buildRationale(signals, tier) };
}

// Effect — named after what it writes; no computation inside
export async function logAutonomyTierDecision(
  workspace: string,
  result: TierResult,
  file_paths: string[],
): Promise<void> {
  await executionStore.append(workspace, {
    type: "auto_decision",
    ...result,
    file_paths,
  });
}

// Coordinator — reads as a recipe: compute, then log
export async function computeAutonomyTier(
  signals: TierSignals,
  workspace: string,
): Promise<TierResult> {
  const result = computeTierResult(signals, signals.override_tier);
  await logAutonomyTierDecision(workspace, result, signals.file_paths);
  return result;
}
```

**Bad — pure formatting logic buried inside a function that also writes output:**

```typescript
// buildCorrectionsSection both assembles the markdown AND writes it to the response
function buildCorrectionsSection(corrections: Correction[], response: Response): void {
  const lines = corrections.map(c => `- ${c.id}: ${c.text}`);
  const section = `## Corrections\n${lines.join("\n")}`;
  response.append(section); // effect entangled with formatting
}
```

**Good — formatting extracted as pure function; effect caller is explicit:**

```typescript
// Pure — builds the section string; safe to snapshot-test directly
export function computeCorrectionsSection(corrections: Correction[]): string {
  const lines = corrections.map(c => `- ${c.id}: ${c.text}`);
  return `## Corrections\n${lines.join("\n")}`;
}

// Effect — writes the already-computed section; name describes what it does
export function writeCorrectionsSection(
  corrections: Correction[],
  response: Response,
): void {
  const section = computeCorrectionsSection(corrections);
  response.append(section);
}
```

**Confirmed instances in this codebase:**

| Extraction | File | Trigger |
|------------|------|---------|
| `computeTierResult` + `logAutonomyTierDecision` | `orchestration/tools/compute-autonomy-tier.ts` | `functions-do-one-thing` + `no-hidden-side-effects` |
| `applyOverrides` (pure) extracted from mutating function | `shared/lib/matcher.ts` | `functions-do-one-thing` (sug_GG4) |
| `computeCorrectionsSection` (pure) extracted from writer | `orchestration/tools/resolve-agent-skills.ts` | mixed formatting + I/O |
| `scanArtifactList`, `classifyArtifact`, `scanArtifacts` (pure) | `orchestration/services/artifact-matching.ts` | line-count + `no-hidden-side-effects` |

## Exceptions

Functions that are pure I/O orchestration with no meaningful computation (e.g., a passthrough proxy, a simple CRUD wrapper) do not benefit from the split — there is no pure core to extract. Framework lifecycle hooks (constructors, event handlers, middleware) may not be amenable; apply the extraction to the business logic they delegate to, not the scaffolding itself. When the computation is a single expression (e.g., an inline arithmetic formula), inline it rather than extracting a trivial one-liner.

**Related:** `compute-effect-naming-convention` — the naming contract this separation enforces (`compute*` = pure, `log*`/`write*`/`store*` = effect). Complements `simplicity-first` — the extraction is warranted because mixing responsibilities is the complexity; separating them is the simpler design. Complements `pure-io-service-split` — this convention governs the intra-function extraction shape; `pure-io-service-split` governs the module-level service structure. `no-hidden-side-effects` — the side-effect prohibition that motivates extraction. `functions-do-one-thing` — the single-responsibility rule whose fix this pattern standardizes. Does NOT conflict with `measure-before-optimizing` (performance measurement) or `simplicity-first` (the split reduces, not adds, complexity when responsibilities were already entangled).

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "This principle is too strict for this case." | Principles prevent common failure modes specifically in edge cases and delivery pressure, where shortcuts look most attractive. | Apply the principle unless a concrete, bounded exception is documented under `## Exceptions`. |
| "We'll clean it up after this ships." | Deferred quality work usually becomes permanent debt and normalizes repeated violations. | Implement the compliant approach now, or record an explicit follow-up with owner and due date. |
| "The function is small enough that separation adds unnecessary files." | The extraction is intra-file — both functions live in the same file. The cost is two function declarations; the gain is a directly testable pure function. | Extract within the same file. No new file needed unless the pure module warrants its own file (as in `artifact-matching.ts`). |
| "Adding a wrapper coordinator function adds indirection." | The coordinator already existed — it was doing both jobs. Splitting its body into named helpers removes hidden behavior; it does not add a layer. | Name the parts explicitly and call them in sequence. |

## Verification

- [ ] Every function that mixes computation with I/O has been split: one `compute*` function (pure), one effect function (`log*`/`write*`/`store*`/`record*`).
- [ ] The `compute*` function contains no DB writes, network calls, event emissions, or log statements.
- [ ] The effect function contains no non-trivial computation — it may format a simple argument but must not perform conditional logic or scoring.
- [ ] The coordinator calls both explicitly in sequence (compute, then effect) so the effect site is visible at the call site.
- [ ] Any deviation is explicitly documented under `## Exceptions` with rationale and bounds.
