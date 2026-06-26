# features/evolution/ — Trace-Driven Evolution Bounded Context

<!-- last-updated: 2026-06-25 -->

## Purpose

The `evolution/` feature module implements Canon's trace-driven evolution
pipeline (Phase 1). It provides two MCP tools:
- `evaluate_candidate` — offline fitness gate (§7 strict-holdout, ADR-0022)
- `attribute_failure` — attribution consumer: joins recorded `context_provenance` with review violations + cliff events to localize each failure to the in-context artifact (ADR-0024)

Both tools are **offline** — never called on the build hot path.

## Architecture

```
features/evolution/
├── tools/
│   ├── evaluate-candidate.ts   # MCP tool handler (thin wrapper over services)
│   └── attribute-failure.ts    # MCP tool handler (thin wrapper over attribution services)
├── services/
│   ├── eval-runner.ts          # parseSummary, decideGate, runSplit (pure + one I/O fn)
│   ├── candidate-injection.ts  # withInjectedCandidate (ADR-0022 temp-dir injection)
│   ├── attribution-types.ts    # Mutator-facing output types: FailureKind, AttributedArtifact, FailureAttribution, AttributeFailureResult
│   ├── attribution-join.ts     # attributeFailures() — pure join of provenance + failure sources
│   ├── attribution-provenance-source.ts  # readProvenance() — reads live workspace or archived RunSummary
│   └── attribution-failure-sources.ts   # collectFailureSources() — reads review violations + cliff events
└── __tests__/
    ├── decide-gate.test.ts
    ├── parse-summary.test.ts
    ├── evaluate-candidate.test.ts
    ├── candidate-injection.test.ts
    ├── attribution-join.test.ts           # 17 pure unit tests (happy path, byte-identity, cliff join, lossy paths)
    ├── attribute-failure.test.ts          # 6 integration tests (real SQLite + REVIEW.md)
    ├── attribution-provenance-source.test.ts
    └── attribution-failure-sources.test.ts
```

Registered via `src/app/register-evolution.ts` → `createCanonServer()`.

## Tool: `evaluate_candidate`

**Input:**
- `candidate_text` (string) — The artifact text to evaluate.
- `target_path` (string) — Path relative to `project_dir` where the candidate
  is injected (e.g. `skills/canon/evals/eval-set.json`).
- `splits` (optional array of `"train"|"val"|"holdout"`) — Defaults to all three.
- `project_dir` (string) — Absolute path to the project root.

**Output (`EvaluateCandidateResult`):**
- `baseline_score` / `candidate_score` — Holdout pass counts (convenience fields).
- `per_split` — `{ train, val, holdout }` each with `{ baseline_passed, candidate_passed, total }`.
- `accepted` — `true` iff `candidate_holdout > baseline_holdout` (strict, §7 gate).
- `regressed` — `true` iff candidate regressed holdout.
- `size_delta` — Candidate length minus baseline file length (chars). Signal only, not a gate.
- `judge_votes_holdout` — Always `3` (documents AC#7, evaluate-candidate-04).

## Injection Contract (ADR-0022)

`withInjectedCandidate(projectDir, candidateText, targetPath, fn)`:

1. `fs.mkdtemp` — creates a fresh temp dir under `os.tmpdir()`.
2. `fs.cp(recursive)` — copies `skills/canon/evals/` into the temp dir (in-process, ~8ms).
3. Writes `candidateText` to the resolved `targetPath` within the temp tree.
4. Path-traversal guard — rejects any `targetPath` that resolves outside the temp root.
5. Calls `fn(tmpDir)` — caller runs the eval harness.
6. `fs.rm(recursive, force)` in `finally` — always cleans up, even on error.

**Invariant**: the real `skills/canon/evals/` directory is NEVER mutated.
The candidate-injection test snapshots the directory hash before/after and asserts equality.

## §7 Gate: decideGate

```ts
function decideGate(perSplit: PerSplit): { accepted: boolean; regressed: boolean } {
  const h = perSplit.holdout;
  return {
    accepted: h.candidate_passed > h.baseline_passed,
    regressed: h.candidate_passed < h.baseline_passed,
  };
}
```

- **Holdout-only** — train and val numbers NEVER enter the accept decision.
- **Strict `>`** — equal holdout is a rejection ("unchanged holdout is not an accept").
- **Fail-closed** — timeout or subprocess error → `ToolResult` error (NOT an accept).

## ADR-002 Constraint

This feature module MUST NOT import `node:child_process`. All subprocess work
routes through `@platform/adapters/process-adapter.ts` via `runShell`.

Verification: `grep -rn "node:child_process" mcp-server/src/features/evolution/` must
return empty output.

## Known Constraints

- `runShell` is `spawnSync` (synchronous). A full eval run (15 real `claude -p` calls)
  blocks the MCP server event loop for minutes. Acceptable for an offline gate — never
  call `evaluate_candidate` on the build hot path (§8.3).
- Timeout is set to `EVAL_TIMEOUT_MS = 600_000` (10 minutes) to override the 30s default.
- 512KB stdout maxBuffer is sufficient for the summary text; `parseSummary` scans from
  the end to tolerate truncation.

## Tool: `attribute_failure`

**Input** (`AttributeFailureInputSchema`):
- `workspace` (string, optional) — absolute path to a live Canon workspace; exactly one of `workspace` or `archive_id` must be provided.
- `archive_id` (string, optional) — archive ID of a completed build (from `get_build_history`).
- `project_dir` (string, required) — absolute path to the project root; needed for artifact body reads, drift.db cliff events, and archive lookups.

**Output (`AttributeFailureResult`):**
- `attributions[]` — `FailureAttribution` objects: each links one failure to one `AttributedArtifact` with `failure_kind`, `confidence`, `hash_verified`, `join_basis`, `hypothesis`, `transcript_evidence`.
- `unattributed[]` — violations with no matching provenance entry (typed bucket, not dropped).
- `flagged[]` — attributions where `content_hash` mismatched or the artifact file is missing (degraded, not error).
- `ambiguous[]` — violations that matched multiple provenance steps (surfaced, not silently resolved).

**Fail behavior**: fail-open — absent provenance, reviews, or cliff events yield empty sub-arrays, not errors. `INVALID_INPUT` when both or neither of `workspace`/`archive_id` are given.

## Attribution Join Contract (ADR-0024)

- **`review_violation`** — joined on `violation.principle_id == assembled_artifacts[].id`; the only edge the recorded data supports; lossy cases become `unattributed[]` or `ambiguous[]`.
- **`cliff_event`** — joined on `cliff.step_id == provenance.step_id`; exact, high-confidence.
- **`test_failure`** — DEFERRED; no durable joinable key in current trace schema. Re-add per ADR-0024 Revisit-If once a `step_id`-keyed test_failure event type is available.
- **content_hash** — re-hashed from the raw (untrimmed) pre-disclosure artifact body via `hashContent`; mismatch → `flagged[]` with `hash_verified: false`; exact match → `hash_verified: true`. Fail-closed: only exact SHA256 match counts.
- **Hypothesis vocabulary** — all `hypothesis` strings use presence/context vocabulary; "caused"/"causes" are prohibited (verified by grep on every build).

## Known Constraints

- `runShell` is `spawnSync` (synchronous) — relevant to `evaluate_candidate` only; `attribute_failure` has no subprocess calls.
- `getTranscriptExcerpt` seam in `attribute_failure` is wired but returns `[]` in v1 (transcript evidence not yet populated).
- `attribute_failure` reads from two Canon stores: execution-store `orchestration.db` (for `context_provenance` events via `getEventsByType`) and drift.db (for cliff events via `CliffEventsDao`). It does NOT write to any Canon storage.

## Future Phases

- Phase 2: candidate generation (propose mutations, rank by expected holdout improvement).
- Phase 3: evolve loop (generation → evaluation → selection → commit cycle).
