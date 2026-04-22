---
name: performance
description: Domain primer for performance engineering. Covers "measure-don't-guess," latency as distribution (p99/p99.9), bottleneck migration, cache placement with invalidation, N+1 detection, and premature-async failure modes. Use when optimizing hot paths, responding to a latency regression, sizing a cache, or deciding whether to parallelize.
user-invocable: false
---

# Performance Domain

## Mental Models

**Measure, Don't Guess** — Performance intuition is almost always wrong. The code you think is slow probably isn't; the allocator, the cache, the GC, the network are. A profiler showing real numbers beats a senior engineer's gut reaction every time. Before optimizing, know which line of code or which system call is consuming the budget. Without a measurement, optimization is fan-fiction.

**Latency Is A Distribution, Not A Number** — "The p50 is 50ms" tells you nothing about the user who waited 3 seconds. Performance lives in the tail: p99 and p99.9 are where user experience breaks. Designing for the mean is designing for the users who don't complain. When you change a system, report the tail: a change that improves the mean by 10% but doubles p99 is a regression for users, even if it looks like a win in aggregate.

**The Bottleneck Moves** — Fix the thing that's slow, and the bottleneck is now somewhere else. This is not failure; this is how optimization works. The corollary: the second-slowest thing is where to look next only after you've confirmed the fix worked. Repeatedly optimizing the same subsystem because "it's the slow one" usually means you fixed the wrong thing the first time.

## Decision Frameworks

**Where to optimize** — Hot loops first (N×1000 iterations saves more than 1×N). Allocator pressure in long-running processes (fewer allocations > faster allocations). Serialization at boundaries (the cost scales with traffic). Background jobs last (users don't wait for them, throughput matters more than latency). Do not optimize code that runs once at startup.

**Cache placement** — Cache at the layer where the cost of the cache miss is highest and the invalidation question is tractable. Database query results → application-level cache (invalidation is about writes the app does). HTTP responses → CDN (invalidation is the hard part; design API URLs for it). Computed derivations → memoization in-process (invalidation is lifetime of the process). Caching without an invalidation plan is a correctness bug in waiting.

**When concurrency helps** — Parallelize I/O-bound work (network calls that can run concurrently) — the synchronous baseline is wasting wall time. Parallelize CPU-bound work when the problem is embarrassingly parallel and the units are large enough that scheduling overhead is negligible. Do not parallelize when the work is tiny (thread startup costs more than the work), when it's sequential by nature, or when the shared state makes the locking cost higher than the work.

## Failure Modes

**Optimizing the wrong thing** — Spending a week tuning a query that runs once per user per day, while the request-per-page fan-out calls a slower endpoint a hundred times. The biggest-impact optimization is almost always reducing the number of operations, not making each one faster. Rewrites at the algorithmic level (O(n²) → O(n log n)) dwarf micro-optimizations.

**Cache invalidation bugs** — A cache returns stale data after a write. Users see wrong prices, wrong counts, wrong permissions. The symptom is weird, timing-dependent bugs; the cause is an update path that doesn't invalidate. Every cache entry needs a clear answer to: what makes this entry stale, and who is responsible for removing it?

**N+1 queries** — Loading a list of 100 items, then querying for each item's detail. The "list view is slow" bug that's actually 101 queries instead of one or two. Often invisible in unit tests (one record), catastrophic in production. Log or trace query counts per request; alert when a handler's count changes dramatically.

**Premature async** — Making everything async because async is faster. Every async boundary is a context switch, a stack frame, an error path, and a debug obstacle. Async is for I/O concurrency or for releasing the caller's thread; inside a single hot CPU path, async usually makes things slower. Sync is the right default until there's a reason not to be.

## Guardrails

**Profile everything, optimize nothing** — You should measure before optimizing. If you've spent more time running profilers than reading results, you've crossed into performance theater. Pick one measurement, understand what it says, then decide whether to act.

**Cache by default** — You should cache expensive computations. If every function result is memoized, every response is cached, and you have six layers of cache between the request and the DB, you've built a complexity monument. Cache at the layer where it pays off; the tier hierarchy is a debugging hazard.

**Micro-optimization trap** — You should optimize hot paths. If you're replacing `for` loops with recursive unrolled variants that save microseconds in code that runs at 10 QPS, you've gone too far. The readability cost is real; the performance benefit is in the noise floor.

**Benchmark without load** — You should have benchmarks. If your benchmarks run single-threaded with warm caches against a trivially small dataset and you declare the system fast, you've benchmarked the wrong thing. Load tests need to mimic production traffic shape, concurrency, and dataset size — otherwise they only tell you the best-case performance.
