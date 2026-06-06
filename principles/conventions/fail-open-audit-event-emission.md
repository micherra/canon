---
id: fail-open-audit-event-emission
title: Detection/Compute Tools Emit Fail-Open Audit Events from Inside the Tool
severity: convention
scope:
  layers:
    - features
  file_patterns:
    - "mcp-server/src/features/orchestration/tools/**"
tags:
  - observability
  - telemetry
  - orchestration
---

When an orchestration detection or compute tool produces a result worth archiving — a tier assignment, an escalation decision, a cliff detection — it MAY emit a typed event to the execution-store event log **from inside the tool**, gated behind an opt-in `emit_telemetry?: boolean` input flag.

The emission shape has four required properties:

1. **Private named helper** (`emitXyzTelemetry`, `logXyzDecision`) that makes the side effect visible at the tool's call site and satisfies `compute-effect-naming-convention`.
2. **Fail-open catch block** — `try { store.appendEvent(...) } catch (err) { console.warn(...) }` — so a write failure logs WARN (satisfying `observable-best-effort`) and returns `undefined`; the tool's `ToolResult<T>` is returned unchanged regardless.
3. **Event-log only** — the helper appends only to the append-only event log; it never touches the journal or archive.
4. **Typed event registration** — the event type is registered in `FlowEventType` / `FlowEventMap` / `EventPayloadSchemas`. The `satisfies Record<FlowEventType, z.ZodTypeAny>` constraint enforces exhaustiveness at compile time. Forward-compatible passthrough for unregistered types is permitted for legacy `auto_decision` events (existing precedent), but new event types SHOULD be registered.

## Rationale

A behavioral instruction to the orchestrator — "after calling tool X, remember to emit event Y" — has demonstrated 0% reliability in Canon's own operation history (CONVENTIONS.md line 25). Separate post-tool telemetry calls also introduce a transcription seam: the payload must be re-encoded from the tool's return value rather than taken directly from the computed result.

Embedding the emission inside the tool that already computes the relevant data solves both problems: telemetry fires exactly when it should, and the payload is the actual computed result with no transcription seam.

The opt-in `emit_telemetry` flag preserves backward compatibility for existing callers and tests. When the flag is absent or false, the tool emits nothing and its behavior is unchanged. This makes the side effect explicit (satisfying `no-hidden-side-effects`) rather than unconditional.

## Examples

**Bad — separate orchestrator call after tool returns (the demonstrated-unreliable pattern):**

```typescript
// Orchestrator: behavioral instruction that has 0% reliability
const result = await computeAutonomyTier({ workspace, file_paths });
await postEvent({ type: "auto_decision", ...result }); // often skipped, payload re-encoded
```

**Bad — unconditional emission with no opt-in, failing silently:**

```typescript
async function reconcileWorkspace(input: ReconcileInput): Promise<ToolResult<ReconcileResult>> {
  const result = detect(input);
  try {
    await store.appendEvent(input.workspace, { type: "cliff_detected", ...result });
  } catch {
    // silent — violates observable-best-effort
  }
  return ok(result);
}
```

**Good — opt-in flag, private named helper, observable catch, typed event:**

```typescript
// Private helper — named to make the effect visible at the call site
async function emitCliffTelemetry(
  workspace: string,
  result: ReconcileResult,
): Promise<void> {
  try {
    await executionStore.appendEvent(workspace, {
      type: "cliff_detected",
      incomplete_steps: result.incomplete_steps,
      needs_recovery: result.needs_recovery,
    } satisfies FlowEventMap["cliff_detected"]);
  } catch (err) {
    console.warn("[reconcile-workspace] cliff_detected telemetry write failed:",
      err instanceof Error ? err.message : err);
  }
}

async function reconcileWorkspace(
  input: ReconcileInput,
): Promise<ToolResult<ReconcileResult>> {
  const result = detect(input);

  // Opt-in: existing callers and tests are unaffected when flag is absent/false
  if (input.emit_telemetry) {
    await emitCliffTelemetry(input.workspace, result);
  }

  return ok(result);
}
```

**Confirmed instances in this codebase:**

| Instance | File | Event type | Flag | Registration |
|----------|------|-----------|------|-------------|
| `logAutonomyTierDecision` | `tools/compute-autonomy-tier.ts` | `auto_decision` | `emit_telemetry` | legacy passthrough |
| `logAutonomyTierDecision` | `tools/get-next-escalation-strategy.ts` | `auto_decision` | `emit_telemetry` | legacy passthrough |
| `emitCliffTelemetry` | `tools/reconcile-workspace.ts` | `cliff_detected` | `emit_telemetry` | fully registered (FlowEventType + FlowEventMap + EventPayloadSchemas) |

The `cliff_detected` instance (PR #309) is the reference implementation: registered event type, opt-in flag, and extracted named helper — all three properties present.

## Exceptions

Tools whose result has no queryable value (passthrough adapters, schema validators that produce no decision) do not benefit from audit event emission. Do not emit events from pure transformation or formatting tools.

Tools that are integration-tested exclusively via the event log (e.g., a test that calls the tool and then asserts `getEventsByType("cliff_detected").length === 1`) may want `emit_telemetry` to default to `true` in the tool's JSON Schema default — acceptable as long as it remains opt-out for callers that provide the flag explicitly.

**Related:** `observable-best-effort` — the `console.warn` in the catch block satisfies this principle's fail-open observable requirement. `compute-effect-naming-convention` — the `emitXyz`/`logXyz` helper name satisfies the effect-prefix contract. `compute-effect-separation` — the helper extraction satisfies the principle that effects are separated from computation. `no-hidden-side-effects` — the opt-in flag makes the side effect explicit and non-default.

**Not a duplicate of:** `observable-best-effort` (which governs whether failures are visible once an emission is attempted) or `hooks-observable-failures` (which governs shell-level silent swallows in `hooks/**`). This convention governs *whether and how* orchestration tools wire telemetry into their result-compute callsite in the first place.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "The orchestrator will emit the event after calling the tool." | Orchestrator behavioral instructions have demonstrated 0% reliability in Canon's own history. | Embed the emission inside the tool where the computed data already exists. |
| "An unconditional emission is simpler than an opt-in flag." | Unconditional emission breaks existing callers and makes tests that don't want telemetry noise harder to write. | Gate behind `emit_telemetry?: boolean`; existing callers are unaffected. |
| "I don't need to register the event type — the passthrough handles unknown types." | Unregistered types are excluded from the learner's typed `getEventsByType` queries and miss compile-time exhaustiveness checking. | Register the event in `FlowEventType` / `FlowEventMap` / `EventPayloadSchemas`. |
| "The helper is one line — I don't need to extract it." | An inline try/catch inside the tool body hides the side effect at the call site. The named helper makes the emission visible in the tool's main body as a named step. | Extract the private helper. The call site reads: `if (input.emit_telemetry) await emitXyzTelemetry(...)`. |

## Verification

- [ ] Every detection/compute tool that emits to the event log does so via a private named helper (`emitXyz` or `logXyz`).
- [ ] The emission is gated behind `emit_telemetry?: boolean`; default behavior (flag absent/false) emits nothing.
- [ ] The catch block in every emission helper calls `console.warn` — no silent swallows.
- [ ] The tool's `ToolResult<T>` is returned unchanged whether or not the event write succeeds.
- [ ] New event types are registered in `FlowEventType` / `FlowEventMap` / `EventPayloadSchemas` — no unregistered forward-passthrough for new events.
