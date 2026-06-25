# features/evolution/ — Trace-Driven Evolution Bounded Context

## Purpose

The `evolution/` feature module is the seed of Canon's trace-driven evolution
pipeline (Phase 1). It provides the `evaluate_candidate` MCP tool: given a
candidate artifact (text) and a target path, it injects the candidate into an
isolated temp-dir copy of the eval surface, runs the Canon eval harness
(run-evals.sh) per split, and applies the §7 strict-holdout improvement gate.

This is a **write-side / offline gate** — it blocks the build hot path.
It is invoked manually or by the evolution loop, never on every request.

## Architecture

```
features/evolution/
├── tools/
│   └── evaluate-candidate.ts   # MCP tool handler (thin wrapper over services)
├── services/
│   ├── eval-runner.ts          # parseSummary, decideGate, runSplit (pure + one I/O fn)
│   └── candidate-injection.ts  # withInjectedCandidate (ADR-0022 temp-dir injection)
└── __tests__/
    ├── decide-gate.test.ts      # §7 invariant tests (pure, no I/O)
    ├── parse-summary.test.ts    # parseSummary tests (pure, no I/O)
    ├── evaluate-candidate.test.ts  # handler tests (mocks runShell seam)
    └── candidate-injection.test.ts # injection tests (real fs, hash guard)
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

## Future Phases

- Phase 2: candidate generation (propose mutations, rank by expected holdout improvement).
- Phase 3: evolve loop (generation → evaluation → selection → commit cycle).
- Phase 4: attribution integration (trace which prior builds informed which candidates).
