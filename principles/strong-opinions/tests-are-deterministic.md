---
id: tests-are-deterministic
title: Tests Must Be Deterministic
severity: strong-opinion
portable: true
scope:
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

## Cold-start tests need explicit timeouts (watch_TTTTTT1)

Any test that initializes a KG scanner, database connection, git subprocess, or full-project scan from cold state should set an explicit per-test timeout (`{ timeout: 30_000 }`) instead of relying on vitest's 5-second default. That default is calibrated for pre-warmed, in-process unit tests — cold-start initialization is fundamentally slower and its cost varies with host load and merge-time parallel-runner pressure, not just the code under test.

A test that is green at authoring time but sits close to the default timeout is a latent flakiness vector: it stays green until a later, unrelated change (a base-branch merge adding parallel test files, a busier CI runner) tips it over. Placing an expensive cold-start test first in a file — before the process is warm — makes this worse, since its measured cost is a function of system state at that moment. Reference fix: PR #325/#349.

## Subprocess path-determinism in vitest (watch_VVVVVV1)

When a test invokes an external CLI (`depcruise`, `eslint`, `tsc`), use `execFileSync` with an absolute `node_modules/.bin/<binary>` path, an explicit `cwd` (the package root), absolute config/src paths, and an explicit `{ timeout }` (~25_000ms) — not `npm run <script>`. `npm run` spawns a sub-shell that resolves the binary from the ambient PATH, which is non-deterministic when vitest spawns parallel worker threads or when the runner's cwd differs from the package root: the same test can pass in isolation and fail under full-suite parallel load. Reference fix: `ddd-alignment-integration.test.ts`, PR #357.

## Exceptions

Performance benchmarks and load tests are inherently non-deterministic — they measure timing, not correctness. These should be clearly separated from the deterministic test suite (e.g., in a `benchmarks/` directory) and should use statistical thresholds rather than exact assertions. Randomized property-based tests (e.g., fast-check) are acceptable when they use a fixed seed for reproducibility.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "It only fails occasionally — it's probably a real race condition in the code." | A test that fails occasionally is a flaky test until proven otherwise. Diagnosing it as a real bug requires a deterministic reproduction. | Make the test deterministic first (inject clock, use fake timers). If the failure persists under controlled conditions, then it's a real bug. |
| "It works on my machine — CI must have a resource issue." | "Works on my machine" is the definition of non-determinism. CI environments are slower and more variable by design; tests must be written to tolerate this. | Use fake timers and injected clocks. Remove all real-time dependencies. |
| "The timeout is generous — 5 seconds is enough for any machine." | Generous timeouts mask flakiness; they don't eliminate it. A 5-second `setTimeout` is a race condition waiting for a slow CI runner. | Control time explicitly. `vi.useFakeTimers()` and `vi.advanceTimersByTime()` make timing assertions exact on every machine. |
| "Sorting the results would change the behavior being tested." | If test correctness depends on insertion order, the test is asserting implementation details rather than behavior. Unordered collections are non-deterministic. | Use `expect(results).toEqual(expect.arrayContaining([...]))` or sort before asserting on unordered collections. |

## Verification

- [ ] No `Date.now()` or `new Date()` calls in test files — grep for `Date.now()` and `new Date()` in `**/*.test.*` and `**/*.spec.*` files. Each match should use an injected clock, not the real clock.
- [ ] No real `setTimeout` or `setInterval` in tests without fake timers — grep for `setTimeout(` in test files and confirm each is either wrapped in `vi.useFakeTimers()` / `jest.useFakeTimers()` or is an explicit integration test in a `benchmarks/` directory.
- [ ] Cold-start tests (KG scanner, DB connection, git subprocess, full-project scan from cold state) carry an explicit `{ timeout: 30_000 }` rather than relying on the vitest default.
- [ ] Tests invoking an external CLI use `execFileSync` with an absolute `node_modules/.bin/<binary>` path and explicit `cwd`, not `npm run <script>`.

## Related

[[tests-are-independent]] — a non-deterministic test that produces different results on re-run is a special case of order-dependence: the implicit dependency is on timing or environment rather than on another test's side effect. [[one-behavior-per-test]] — deterministic tests that verify one focused behavior are easier to isolate and reproduce when they do fail.
