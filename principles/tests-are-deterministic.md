---
id: tests-are-deterministic
title: Tests Must Be Deterministic
severity: strong-opinion
scope:
  languages: []
  layers: []
  file_patterns:
    - "**/*.test.*"
    - "**/*.spec.*"
    - "**/test/**"
    - "**/tests/**"
    - "**/__tests__/**"
tags:
  - testing
  - reliability
  - lessons-learned
---

A test must produce the same result every time it runs with no changes to the code under test. Tests that depend on wall-clock time, random values, network availability, file system state, or execution speed are flaky — they pass sometimes and fail sometimes, teaching the team to ignore test failures. Every source of non-determinism must be controlled: inject clocks, seed random generators, stub network calls, and use explicit timeouts instead of race conditions.

## Rationale

Flaky tests are worse than no tests. A test suite where 2 out of 200 tests "sometimes fail" trains the team to re-run and ignore failures. When a real bug causes a failure, it gets dismissed as "probably flaky." The entire test suite loses credibility.

Cem Kaner's *Lessons Learned in Software Testing* emphasizes that an unreliable test is not a test — it's noise. Gerald Weinberg's *Perfect Software* reinforces that tests only provide information when their results are meaningful, and non-deterministic results are meaningless.

The most common sources of flakiness in AI-generated tests: using `Date.now()` or `new Date()` instead of injected clocks, `setTimeout` races instead of awaiting events, hardcoded ports that conflict in CI, and assertions on unordered collections without sorting.

## Examples

**Bad — test depends on wall-clock time:**

```typescript
test("token expires after 1 hour", () => {
  const token = createToken({ userId: "123" });

  // Flaky: depends on exact execution timing
  const expiry = token.expiresAt;
  const expected = Date.now() + 60 * 60 * 1000;
  expect(expiry).toBe(expected); // Fails if a few ms pass between lines
});
```

**Good — inject a controlled clock:**

```typescript
test("token expires after 1 hour", () => {
  const now = new Date("2025-01-15T10:00:00Z");
  const token = createToken({ userId: "123", clock: () => now });

  expect(token.expiresAt).toEqual(new Date("2025-01-15T11:00:00Z"));
});
```

**Bad — test depends on execution speed:**

```typescript
test("debounce calls handler after delay", async () => {
  const handler = vi.fn();
  const debounced = debounce(handler, 100);

  debounced();
  await new Promise((r) => setTimeout(r, 150)); // Flaky under CPU load
  expect(handler).toHaveBeenCalledOnce();
});
```

**Good — use fake timers:**

```typescript
test("debounce calls handler after delay", () => {
  vi.useFakeTimers();
  const handler = vi.fn();
  const debounced = debounce(handler, 100);

  debounced();
  vi.advanceTimersByTime(100);

  expect(handler).toHaveBeenCalledOnce();
  vi.useRealTimers();
});
```

## Exceptions

Performance benchmarks and load tests are inherently non-deterministic — they measure timing, not correctness. These should be clearly separated from the deterministic test suite (e.g., in a `benchmarks/` directory) and should use statistical thresholds rather than exact assertions. Randomized property-based tests (e.g., fast-check) are acceptable when they use a fixed seed for reproducibility.
