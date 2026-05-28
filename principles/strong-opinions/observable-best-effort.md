---
id: observable-best-effort
title: Best-Effort Operations Must Be Observable
severity: strong-opinion
scope:
  file_patterns:
    - "mcp-server/src/**"
  layers: []
tags:
  - observability
  - reliability
  - debugging
---

When an operation is intentionally best-effort (non-fatal on failure), the failure must still be observable: returned to the caller, recorded in a metric, or logged at WARN. "Best-effort" means "don't crash," not "don't tell anyone." A catch block that silently discards the error creates a class of failure that can only be discovered by noticing the absence of an expected result — which can take months.

## Rationale

Canon's transcript capture feature was "fixed" three times over several months. Each round added correct, unit-tested code. Each round silently failed in production because the catch blocks swallowed the errors — `catch { /* best-effort */ }` with no logging, no return value, no metric. The feature's tests mocked the boundaries and passed. The actual runtime path never worked. Nobody noticed because the failure was invisible — the only signal was empty `transcripts/` directories, which nobody checked.

The third round even integrated capture into `logStep` as a "mechanical side effect" — but the side effect silently returned nothing when it failed, and the caller discarded the empty result. Three correct implementations. Zero observable production runs.

This is the failure mode that silent catch blocks produce: bugs that survive code review, survive tests, and survive production deployment. They are only discoverable by noticing what is absent — a category of observation that humans are not wired for. A `console.warn` line turns an invisible ghost into a logged event. A boolean return turns a discarded result into something the caller can act on.

The same pattern was found in 10+ locations across the codebase: event store appends, progress file writes, session persistence, metric recording. Each was individually reasonable ("this isn't critical path"). Collectively they created a system where a large class of failures produced no signal at all.

**Related principles:**

- `fail-closed-by-default` — that principle is about security policy (deny access when checks fail). This principle is about observability (make failures visible even when the operation is non-fatal). Orthogonal.
- `structured-logging-with-levels` — that principle is about log format and level discipline. This principle is about whether to surface failures at all. Complementary: when you decide to log a best-effort failure, `structured-logging-with-levels` governs which level and what format to use.
- `no-hidden-side-effects` — that principle is about API contract visibility (side effects should be declared). This principle is about failure visibility (when a side effect fails, the failure should be observable). Complementary.

## Examples

**Bad — silent catch (the actual pattern found across 10+ locations):**

```typescript
try {
  store.appendEvent("state_completed", payload);
} catch {
  /* best-effort */
}
```

```typescript
async function persistProgressLine(line: string): Promise<void> {
  try {
    await appendFile(progressPath, line);
  } catch {
    // best-effort
  }
}
```

Both examples discard the error entirely. The operation failed. Nothing records it. Nobody knows.

**Good — failure logged at WARN:**

```typescript
try {
  store.appendEvent("state_completed", payload);
} catch (err) {
  console.warn("[canon] event persistence failed:", err instanceof Error ? err.message : err);
}
```

**Good — boolean return so the caller knows:**

```typescript
function persistProgressLine(line: string): boolean {
  try {
    appendFileSync(progressPath, line);
    return true;
  } catch (err) {
    console.warn("[canon] progress write failed:", err instanceof Error ? err.message : err);
    return false;
  }
}
```

**Good — warning returned to caller as a typed field:**

```typescript
async function captureTranscript(input: CaptureInput): Promise<CaptureResult> {
  const sourcePath = resolveTranscriptPath(input.agentId);
  if (!sourcePath) {
    return {
      ok: true,
      entry_count: 0,
      transcript_path: "",
      warning: "Source transcript not found for agent " + input.agentId,
    };
  }
  // ... proceed with capture ...
}
```

The caller receives a `warning` field and can log it, surface it to the user, or count it as a metric. The failure does not crash the caller — it is still best-effort — but it is no longer invisible.

**I/O helpers in service files**: `pure-io-service-split` separates computation from I/O, but some service files contain I/O helpers alongside pure functions (e.g., `doc-gap-detect.ts` has both `detectDocGaps` (pure) and `scanDirectories` (I/O)). `observable-best-effort` applies to ALL catch blocks that swallow errors silently, regardless of whether the file is in `tools/` or `services/`. When a service file contains filesystem reads, DB queries, or process calls, apply the same `console.warn` discipline as tool handlers.

## Exceptions

Truly optional cosmetic operations where failure has zero impact on correctness or user experience (e.g., updating a non-critical UI animation hint in a fire-and-forget context). Even then, prefer logging at DEBUG over total silence — it costs nothing and preserves the ability to diagnose future issues.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "It's best-effort — we don't care if it fails." | "Don't care if it fails" means "don't crash." It does not mean "don't tell anyone it failed." Silent failure makes the feature impossible to verify in production. | Log at WARN, return a boolean, or include a `warning` field. The operation stays non-fatal; the failure becomes visible. |
| "Tests pass, so the implementation is correct." | Tests that mock at the boundary verify the logic path, not the real I/O. A correct implementation of a feature that never runs in production is indistinguishable from a broken one. | Add an observable signal — a log line, a metric, a return value — so production runs confirm the feature is actually working, not just logically correct. |
| "The failure is expected and not interesting." | If the failure is expected, logging it at DEBUG costs nothing. If it is not expected, you need the log. The cost of adding one `console.warn` is zero; the cost of debugging an invisible production failure is measured in hours or months. | Log the failure. If it produces too much noise, tune the log level — do not remove the signal entirely. |
| "The caller doesn't need to know — it's a background operation." | The caller not crashing is not the same as the system working. Background operations that fail silently accumulate into features that quietly stopped working months ago. | Give background operations at least one observable signal: a WARN log, a metric increment, or a result field the scheduler can check. |
| "We'll add logging when we need to debug it." | You will need to debug it when the feature is already broken in production and has been for weeks. The time to add observability is when writing the code, not after a production incident. | Add the `console.warn` now. One line. It will be there when you need it. |

## Verification

- [ ] Every `catch` block either re-throws, logs at WARN or higher, returns a failure result, or is explicitly annotated with a comment that names the cosmetic-only exception reason.
- [ ] Functions that perform best-effort operations return a typed result (`boolean`, `Result`, or an object with a `warning` field) rather than `Promise<void>` when the caller could meaningfully react to failure.
- [ ] No catch block contains only a comment (`/* best-effort */`, `// ignore`, `// non-critical`) with no logging and no return value change.
- [ ] Background tasks and side-effect helpers (progress writes, metric flushes, event store appends) produce at least one observable signal on failure — grep for `catch` blocks in non-domain utility code and confirm each one logs or returns.
