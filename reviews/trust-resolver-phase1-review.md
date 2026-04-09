---
verdict: "WARNING"
agent: canon-reviewer
timestamp: "2026-04-08T19:56:00Z"
files-reviewed: 19
principles-checked: 7
---

## Canon Review — Verdict: WARNING

### Principle Compliance

#### Violations

| Principle | Severity | File | Description | Fix |
|-----------|----------|------|-------------|-----|
| functions-do-one-thing | strong-opinion | `mcp-server/src/features/prompt-pipeline/services/inject-coordination.ts:computeTrustForEntries` | `computeTrustForEntries` (~55 lines of logic) opens a DB, computes insight maps, resolves task scope, lazy-loads the board, iterates agents to build file metrics, computes trust levels, and maps them to permission modes. The "and" test yields: "opens DB **and** resolves board **and** resolves scope **and** computes metrics **and** computes trust **and** maps to permission." Six responsibilities in one function. | Extract board resolution, scope resolution, and per-agent trust computation into named helpers (e.g., `resolveBoard`, `resolveScope`, `computeAgentTrust`). `computeTrustForEntries` becomes an orchestrator that calls them. |

#### Honored

- **fail-closed-by-default**: Exemplary compliance. Every degradation path (no KG DB, KG error, stale KG, empty scope, non-writer agent, failed board lazy load) returns LOW or BLOCKED. The catch block in `computeTrustForEntries` calls `trustPermissionModes.clear()`, ensuring no partial trust leaks. `closeDb` is in a `finally` block. The trust resolver's gate chain (7 gates) is explicitly fail-closed with a LOW fallback that should never reach in practice.
- **deep-modules**: `trust-resolver.ts` exposes 3 functions + 4 types, hiding the multi-signal gate computation, the HIGH_DEGREE_THRESHOLD constant, and the KG_STALENESS_MS constant. Callers pass a `TrustInput` and receive a `TrustResult`. The options object refactor of `resolveToolProfile` also deepens that module's interface.
- **simplicity-first**: The implementation avoids unnecessary abstractions. No interfaces with single implementations, no factory patterns, no class hierarchies. Trust levels are a union type, not an enum class. The pure function approach is the simplest thing that works.
- **information-hiding**: Trust computation thresholds (`HIGH_DEGREE_THRESHOLD`, `KG_STALENESS_MS`) are encapsulated in `trust-resolver.ts`. The KG DB path construction is encapsulated in `computeTrustForEntries`. The `agentHasWriteCapability` check is encapsulated in a helper. No design decisions leak across module boundaries.
- **no-hidden-side-effects**: `computeTrustLevel`, `buildScopeMetrics`, and `trustLevelToPermissionMode` are pure functions with no side effects. `computeTrustForEntries` opens and closes a DB (visible in its name and JSDoc), which is an expected side effect of a function that "computes trust for entries."
- **backward-compatible-schema-changes**: The KG schema v3→v4 migration adds two new tables (`hotspot_scores`, `co_change_edges`) with `CREATE TABLE IF NOT EXISTS`. No existing columns are modified or removed. The migration is additive and idempotent. Existing v3 databases upgrade cleanly.
- **define-errors-out-of-existence**: `closeDb` ignores close errors. `lazyLoadBoard` returns null on error instead of throwing. `computeTrustForEntries` returns an empty map on error. These patterns eliminate error conditions that callers would otherwise need to handle.

#### Score

| Layer | Rules | Opinions | Conventions |
|-------|-------|----------|-------------|
| prompt-pipeline | 1/1 | 4/5 | 1/1 |
| graph (kg-schema) | 1/1 | 1/1 | — |

### Code Quality (Advisory)

#### Suggestions

- **Redundant guard (Gate 5 + Gate 6)**: In `trust-resolver.ts` lines 92-98, Gate 5 checks `!hasHubFile && !hasHighDegreeFile` and returns HIGH. Gate 6 checks `hasHubFile || hasHighDegreeFile` and returns MEDIUM. These two conditions are logically exhaustive — if Gate 5 is false, Gate 6 must be true. The Gate 6 condition is redundant and the fallback at line 102 is dead code. Consider replacing Gate 6's `if` with a direct return: `return { level: "MEDIUM", reason: "Scope contains hub or high-degree files" };`. This makes the exhaustiveness visible and eliminates the dead fallback.

- **Regex construction in hot path**: In `git-intel-config.ts`, `isExcluded` compiles a new `RegExp` for every pattern on every call. If this function is called in a loop over many files, the repeated compilation is wasteful. Consider pre-compiling the regex patterns at module load time or memoizing them.

- **Phase 1 uniform trust limitation is well-documented**: The known limitation that all entries with the same agent type get the same trust level is documented in both `computeTrustForEntries` JSDoc and DESIGN.md. This is the right tradeoff for Phase 1.

#### Strengths

- Pure function design of `trust-resolver.ts` with zero I/O imports makes it trivially testable. 26 tests with excellent boundary coverage.
- The options object refactor of `resolveToolProfile` is a clear improvement over the fragile 4-positional-param signature. Forward-extensible without breaking callers.
- The precedence chain (`overrides.permission_mode > trustPermissionMode > isolation fallback`) is well-documented in both code comments and tests. The three levels of the chain are each tested independently.
- Test quality is high: boundary conditions tested (exactly 3_600_000ms, inDegree exactly 8), gate priority ordering verified (stale KG fires before BLOCKED), backward compatibility tests ensure zero-regression for existing callers.

### Compliance Cross-Check

#### Discrepancies

None. Both implementor summaries declare COMPLIANT for `fail-closed-by-default`, `functions-do-one-thing`, and `deep-modules`. The reviewer agrees on all except `functions-do-one-thing` for `computeTrustForEntries` in inject-coordination.ts.

| Principle | Implementor Declared | Reviewer Found | Assessment |
|-----------|---------------------|----------------|-----------|
| functions-do-one-thing | trust-02: COMPLIANT ("computeTrustForEntries only computes trust") | VIOLATED — function does 6 things | The implementor's summary is technically correct that all the work is "trust computation," but the function has 6 extractable sub-operations with distinct names. The principle's test is: "if you can extract a meaningful sub-function whose name is not just a restatement of the parent function's name." Board loading, scope resolution, and per-agent metric aggregation each have non-restatement names. |

#### Cross-Check Summary

1 discrepancy found — implementor may have interpreted "functions-do-one-thing" at the macro level (the function's purpose) rather than the principle's actual test (can you extract a meaningfully-named sub-function).

### Drift from Plan

**Unplanned files changed:**

- `mcp-server/src/features/knowledge-graph/__tests__/kg-store.test.ts` — schema version updates (mechanical, tied to KG v4 migration)
- `mcp-server/src/features/knowledge-graph/git-intel/__tests__/git-log-parser.test.ts` — new file; not in plan
- `mcp-server/src/features/knowledge-graph/git-intel/git-intel-config.ts` — new file; not in plan
- `mcp-server/src/features/knowledge-graph/git-intel/git-intel-types.ts` — new file; not in plan
- `mcp-server/src/features/knowledge-graph/git-intel/git-log-parser.ts` — new file; not in plan
- `mcp-server/src/graph/__tests__/kg-schema-v4.test.ts` — new file; not in plan
- `mcp-server/src/graph/kg-schema.ts` — schema v4 migration; not in plan
- `mcp-server/src/platform/storage/drift/__tests__/drift-db.test.ts` — new tests for countFlowRunsSince/getLastFlowRunCompletedAt
- `mcp-server/src/platform/storage/drift/drift-db.ts` — new methods; not in plan
- `mcp-server/src/shared/lib/__tests__/config.test.ts` — loadLearnGateConfig tests; not in plan
- `mcp-server/src/shared/lib/__tests__/learn-lock.test.ts` — new file; not in plan
- `mcp-server/src/shared/lib/config.ts` — loadLearnGateConfig; not in plan
- `mcp-server/src/shared/lib/learn-lock.ts` — new file; not in plan

**Assessment**: 13 unplanned files. The 6 core trust-resolver files match the plan exactly. The 13 unplanned files fall into two categories: (a) KG schema v4 migration adding `hotspot_scores` and `co_change_edges` tables plus git-intel infrastructure (7 files), and (b) learn-gate/drift-db infrastructure for future automated learning (6 files). These appear to be Phase 1 infrastructure groundwork committed alongside the trust resolver work. While they don't violate any principles, the scope creep is notable — the plan was strictly 6 files and these add 13 more.

**Missing planned work:** None — all 6 files specified in DESIGN.md and INDEX.md are present in the diff.
