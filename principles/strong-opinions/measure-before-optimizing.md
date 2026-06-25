---
id: measure-before-optimizing
title: Measure Before Optimizing
severity: strong-opinion
portable: true
scope:
  layers: []
tags:
  - performance
  - ai-code-quality
---

Performance changes must be preceded by measurement proving the optimization is needed. Profile, benchmark, or trace before changing code for speed.

## Rationale

AI agents default to premature optimization. An LLM asked to "make this faster" will rewrite functions, introduce caches, and add concurrency without knowing whether those code paths are hot. The result is complexity added speculatively — which may worsen performance, introduce bugs, or solve a non-problem entirely.

Unmeasured optimizations are guesses. A guess that adds code is a net negative: it increases maintenance burden and makes future performance investigation harder by obscuring the real bottleneck. Measurement first means changes are targeted, bounded, and verifiable.

## Examples

**Bad — optimizing without profiling:**

```typescript
// "This looks slow" — rewrites string concatenation to array join without data
function buildReport(items: Item[]): string {
  const parts: string[] = [];
  for (const item of items) {
    parts.push(formatItem(item));
  }
  return parts.join("\n");
}
```

This change may be irrelevant. The hot path might be `formatItem`, not string concatenation.

**Good — profile first, then optimize the actual bottleneck:**

```bash
# 1. Profile under realistic load
node --prof server.js
node --prof-process isolate-*.log > profile.txt

# 2. Read the profile — formatItem accounts for 78% of CPU time
# 3. Optimize formatItem specifically, with a benchmark before and after
```

```typescript
// Only after the profile shows formatItem is the bottleneck
function formatItem(item: Item): string {
  // targeted optimization with measured before/after
}
```

The optimization is scoped to the measured hot path, and the before/after benchmark proves it helped.

## Exceptions

- **Obvious algorithmic improvements**: Replacing O(n²) with O(n) when the data set is known to be large (e.g., sorting 10,000 records). The complexity math is the measurement.
- **Removing dead code**: Deleting unused code paths cannot worsen performance and needs no profiling.
- **Security-motivated timing changes**: Constant-time comparisons for secrets are required regardless of measured impact; timing side-channels are not optional to fix.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "This is obviously slow — I can tell just by reading it." | Intuition about performance is consistently wrong. Modern runtimes optimize patterns in ways that contradict human intuition, and the "obvious" bottleneck is rarely the actual one. | Profile or benchmark to confirm before changing anything. Take 10 minutes to measure — it costs less than undoing a wrong optimization. |
| "Benchmarks take too long to set up for this change." | The time spent on a benchmark is almost always less than the time spent debugging a performance regression introduced by an unmeasured change. | Start with a simple timing wrapper or an existing test under `console.time`. A rough measurement beats no measurement. |
| "The user reported it's slow, so this code path must be the problem." | User reports identify symptoms, not causes. A user saying "the dashboard loads slowly" does not identify which of dozens of code paths is responsible. | Use the report as a starting point for profiling, not as a diagnosis. Trace the slow request from entry point to response. |
| "I know this pattern is faster — I've seen it in performance guides." | General patterns apply in general contexts. The pattern may be irrelevant to this codebase's actual bottleneck, or already handled by the runtime. | Verify the pattern applies here with a benchmark. If the benchmark shows no improvement, revert and keep looking. |

## Related

[[simplicity-first]] is the natural precondition — prefer the simplest solution until measurement proves a faster one is needed. Optimizing without measuring violates both principles: it adds complexity without evidence that the complexity buys anything. [[no-hidden-side-effects]] is a structural guard — performance "improvements" that cache results or introduce shared mutable state create hidden side effects that are harder to debug than the original bottleneck.

## Verification

- [ ] Every performance-motivated change has a corresponding before/after measurement (profile output, benchmark result, or timing log) committed alongside the code.
- [ ] No speculative optimizations exist in the diff — every changed code path was identified as a bottleneck by measurement, not by intuition.
