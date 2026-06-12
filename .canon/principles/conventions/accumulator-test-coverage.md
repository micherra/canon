---
id: accumulator-test-coverage
title: Accumulator Functions Require Multi-Event Test Cases
severity: convention
scope:
  layers: []
  file_patterns:
    - "mcp-server/**"
tags:
  - testing
  - accumulator
---

Accumulator functions — functions that use the `+` operator on an existing field where the added value can be greater than 1 — must have at least one test case that uses an input count greater than 1 and asserts the exact numeric result. Testing accumulators only with single-unit increments (N=1 inputs) cannot distinguish correct accumulation from a lossy boolean coercion.

The trigger condition: **any function with the `+` operator on an `existing.*` field where the added value can be > 1**. When you see this pattern, at least one test must supply a value > 1 and assert the exact number, not just truthiness or inequality.

## Rationale

Commit `41146682` introduced a bug where `hadViolation: boolean` was used where `violationCount: number` was needed. The boolean coerced any count ≥ 1 to `true`, narrowing the stored value to 0 or 1. All existing tests passed because they only ever accumulated one item at a time — `true === true` for N=1 inputs. The bug was invisible until a real review produced N=3 violations and the count was recorded as `1` instead of `3`.

The fix — changing the field type from `boolean` to `number` — was straightforward. The missing tests were the failure mode.

A test suite that only exercises N=1 accumulation gives a false sense of safety. It cannot catch the specific class of bug where a `boolean` replaces a `number`: both produce identical results for N=1. Multi-event test cases are the only way to confirm that quantity is preserved, not just presence.

This convention also applies to capped accumulators (e.g., `min(total_violations, 5)`). Test both below-cap and at-cap inputs with exact numeric assertions to confirm the cap boundary, not just relative ordering.

## Examples

**Bad — test with only N=1 inputs (cannot detect boolean coercion):**

```typescript
test("records violation", () => {
  // Only one violation supplied — a boolean coercion bug passes this test
  signals.upsertFileViolation({
    file_path: "src/foo.ts",
    principle_id: "deep-modules",
    violation_count: 1,
    first_seen: "2026-04-01T00:00:00.000Z",
    last_seen: "2026-05-01T00:00:00.000Z",
  });

  const result = signals.getFileViolationHistory(["src/foo.ts"]);
  expect(result[0].violation_count).toBe(1); // passes even if stored as `!!1 === true`
});
```

**Good — test with N=3 inputs and exact numeric assertion:**

```typescript
test("records exact violation count when count is greater than 1", () => {
  // Three violations supplied — a boolean coercion bug fails this test
  signals.upsertFileViolation({
    file_path: "src/foo.ts",
    principle_id: "deep-modules",
    violation_count: 3,
    first_seen: "2026-04-01T00:00:00.000Z",
    last_seen: "2026-05-01T00:00:00.000Z",
  });

  const result = signals.getFileViolationHistory(["src/foo.ts"]);
  expect(result[0].violation_count).toBe(3); // fails if stored as `true`
});
```

**Good — capped accumulator with below-cap, at-cap, and above-cap inputs:**

```typescript
test("scorePathEffect caps total_violations contribution at 5", () => {
  const rowBelow = makePathEffectRow({ total_violations: 3, violation_streak: 0 });
  const rowAtCap = makePathEffectRow({ total_violations: 5, violation_streak: 0 });
  const rowAbove = makePathEffectRow({ total_violations: 8, violation_streak: 0 });

  // Below cap: exact value used
  expect(scorePathEffect(rowBelow)).toBe(3);
  // At cap: capped to 5
  expect(scorePathEffect(rowAtCap)).toBe(5);
  // Above cap: still 5 (not 8)
  expect(scorePathEffect(rowAbove)).toBe(5);
});
```

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "The unit test already covers the accumulator." | If all inputs are N=1, boolean coercion produces identical results. Coverage metrics don't detect this gap. | Add at least one test with N>1 and assert the exact number. |
| "This is a typed language — TypeScript would catch a boolean/number mismatch." | TypeScript cannot catch bugs where a `boolean` is explicitly declared but a `number` was intended. The original bug *had* a `boolean` type that passed compilation. | Types are not a substitute for behavioral tests with realistic inputs. |
| "The cap is just a math formula — it's obviously correct." | Capped accumulators need both below-cap and at-cap test cases to confirm the boundary. Relative ordering tests (`score5 === score100`) only confirm capping happens, not the exact capped value. | Assert exact numeric results for below-cap, at-cap, and representative above-cap inputs. |
| "We'll add multi-event tests when we find a bug." | The entire point of this convention is to find the bug before it reaches production. By the time you find it, the damage is done (incorrect stored data, wrong prioritization in agent context). | Write the multi-event test at the same time as the accumulator function. |

## Verification

- [ ] For each accumulator function touched: confirm at least one test case uses an input value > 1 and asserts the exact numeric result (not just a boolean truthy check).
- [ ] For capped accumulators: confirm tests cover below-cap, at-cap, and above-cap inputs with exact numeric assertions.
- [ ] The test name describes the specific count scenario (e.g., "records exact count of 3 violations" not "records violations").
- [ ] If only N=1 test inputs exist, that is a gap — document why the accumulator cannot receive N>1 inputs, or add the missing test.
