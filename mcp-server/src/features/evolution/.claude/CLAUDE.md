# features/evolution/ — Trace-Driven Evolution Bounded Context

<!-- last-updated: 2026-07-01 -->

## Purpose

The `evolution/` feature module implements Canon's trace-driven evolution
pipeline (Phase 1). It provides five MCP tools:
- `evaluate_candidate` — offline fitness gate (§7 strict-holdout, ADR-0022/ADR-0025 dual injection)
- `attribute_failure` — attribution consumer: joins recorded `context_provenance` with review violations + cliff events to localize each failure to the in-context artifact (ADR-0024)
- `select_mutation_targets` — deterministic (no model calls) selection layer: composes `attribute_failure`, applies policy + budget, returns construction-ready `MutationTarget[]` for the learner
- `record_applied_evolution` — authoritative/fail-closed apply-provenance write to drift.db `applied_evolutions` (ADR-0034)
- `get_evolution_outcomes` — fail-open, target-scoped, apply-anchored regression HYPOTHESIS reader

All tools are **offline** — never called on the build hot path.

## Architecture

```
features/evolution/
├── tools/
│   ├── evaluate-candidate.ts       # MCP tool handler — dual-mode dispatch via isGuardrailTarget()
│   ├── attribute-failure.ts        # MCP tool handler (thin wrapper over attribution services)
│   └── select-mutation-targets.ts  # MCP tool handler — composes attribution pipeline + selectMutationTargets()
├── services/
│   ├── eval-runner.ts          # parseSummary, decideGate, runSplit (pure + one I/O fn)
│   ├── candidate-injection.ts  # withInjectedCandidate (ADR-0022) + withInjectedGuardrailCandidate (ADR-0025) + isGuardrailTarget()
│   ├── mutation-types.ts       # Pure types: MutationTarget, GateIneligibleTarget, SkippedAttribution, SelectMutationTargetsResult, MutationProposal, ArtifactClass; budget constants DEFAULT_MAX_TARGETS_PER_PASS, CANDIDATES_PER_TARGET
│   ├── mutation-selection.ts   # selectMutationTargets() — pure join+rank+filter; PLUGIN_ARTIFACT_ROOTS eligibility check; derivePrincipleId() keys agent-def targets off the violated principle, not the agent name (Codex P2 #2)
│   ├── mutation-proposal.ts    # shapeMutationProposal() — shapes accepted eval result into MutationProposal
│   ├── attribution-types.ts    # Mutator-facing output types: FailureKind, AttributedArtifact, FailureAttribution, AttributeFailureResult
│   ├── attribution-join.ts     # attributeFailures() — pure join of provenance + failure sources; review_violation attributes via BOTH the rule edge (principle_id==artifact_id) and the code-author agent-def edge (ADR-0032)
│   ├── attribution-provenance-source.ts  # readProvenance() — reads live workspace or archived RunSummary
│   ├── attribution-failure-sources.ts   # collectFailureSources() — reads review violations + cliff events
│   ├── artifact-path-resolver.ts  # resolveArtifactReadPath() — pure cross-root re-read resolver: project_dir-first, pluginDir-fallback for trusted plugin-tier artifacts (Codex P2 #1)
│   └── frontmatter-guard.ts    # checkFrontmatterImmutable() — pure runtime frontmatter-immutability guard (ADR-0031 amendment)
└── __tests__/
    ├── decide-gate.test.ts
    ├── parse-summary.test.ts
    ├── evaluate-candidate.test.ts
    ├── candidate-injection.test.ts
    ├── guardrail-injection-integration.test.ts  # Integration: guardrail sandbox build + isGuardrailTarget predicate
    ├── mutation-proposal.test.ts
    ├── mutation-selection.test.ts
    ├── mutation-selection-principle-id.test.ts  # derivePrincipleId(): agent-def -> violated principle_id, cliff agent-def -> null, rule/cliff-on-rule unchanged
    ├── mutator-gate-integration.test.ts
    ├── proposal-shape-parity.test.ts    # Proposal frontmatter matches canonical template in SKILL.md
    ├── select-mutation-targets.test.ts
    ├── attribution-join.test.ts           # 17 pure unit tests (happy path, byte-identity, cliff join, lossy paths)
    ├── attribute-failure.test.ts          # 6 integration tests (real SQLite + REVIEW.md)
    ├── attribution-provenance-source.test.ts
    ├── attribution-failure-sources.test.ts
    ├── attribution-join-agent-def.test.ts        # cliff->agent-def + review_violation->agent-def code-author join (7 cases)
    ├── artifact-path-resolver.test.ts            # self-host, foreign-install fallback, overlay never-fallback, fail-closed missing, absolute-as-is
    ├── frontmatter-guard.test.ts                 # 11 pure unit cases for checkFrontmatterImmutable
    ├── evaluate-candidate-frontmatter-guard.test.ts  # 4 handler-wiring cases — asserts zero runShell calls on reject
    └── agent-def-real-path-integration.test.ts   # end-to-end: resolveAgentSkills -> readProvenance -> attributeFailures -> selectMutationTargets -> evaluateCandidate's frontmatter guard, using the REAL emitted path (no hand-written fixture)
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
- `guard_rejection?` — additive-optional; present ONLY when the frontmatter-reject guard rejected an agent-def candidate before any subprocess ran (ADR-0031 amendment). `{ reason: "frontmatter_modified" | "frontmatter_unverifiable"; fields?: string[] }`. Backward compatible — existing consumers already treat `accepted:false` as "do not propose".

**Runtime frontmatter-reject guard (`checkFrontmatterImmutable`, `services/frontmatter-guard.ts`):** when `target_path`'s first segment is `agents` (`isAgentDefTarget`), the handler compares the RAW frontmatter block (`---\n...\n---`, byte-for-byte) of `candidate_text` against baseline BEFORE `checkScriptReachable`/any subprocess. Differing blocks → `accepted:false` + `guard_rejection:{reason:"frontmatter_modified", fields}` (`fields` = best-effort top-level YAML keys that changed — a diagnostic, never the basis of the comparison). Unparseable frontmatter on either side → fail-closed `guard_rejection:{reason:"frontmatter_unverifiable"}`. Never throws. Body-only candidates proceed to normal scoring unaffected.

## Tool: `select_mutation_targets`

**Input (`SelectMutationTargetsInputSchema`):**
- `workspace` (string, optional) — absolute path to a live Canon workspace; exactly one of `workspace` or `archive_id` must be provided.
- `archive_id` (string, optional) — archive ID of a completed build (from `get_build_history`).
- `project_dir` (string, required) — absolute path to the project root.
- `max_targets_per_pass` (number, optional) — override budget cap; default `DEFAULT_MAX_TARGETS_PER_PASS` (3).

**Output (`SelectMutationTargetsResult`):**
- `targets[]` — `MutationTarget[]`: each has `target_path`, `artifact_class`, `baseline_body`, `char_span`, `gate_eligible: true`, `confidence`, `failure_kind`, `principle_id`, `attribution`.
- `gate_ineligible[]` — `GateIneligibleTarget[]`: paths rejected as not gate-eligible (typed bucket, not dropped); `reason` values: `tool_description_not_loadable`, `file_missing`, `path_traversal`, `harness_entrypoint`.
- `skipped[]` — `SkippedAttribution[]`: attributions not promoted before eligibility check; `reason` values: `hash_unverified`, `confidence_below_high`, `budget_exhausted`.
- `meta` — `{ attributions_seen, selected, budget }` for observability.

**`principle_id` semantics (`derivePrincipleId`, Codex P2 #2):** for every `target_artifact.kind` EXCEPT `"agent-def"`, `principle_id === target_artifact.id` (rule/ref/primer/template file ids ARE the principle they carry — unchanged). For `kind:"agent-def"`, `target_artifact.id` is the AGENT NAME (e.g. `"engineer"`), not a principle — `principle_id` is instead the VIOLATED principle from `attributed_violations[0].principle_id`, or `null` for a `cliff_event` agent-def attribution (a write-cliff has no principle). This keeps downstream recurrence/learning keyed by principle even when the mutation target is an agent-def.

**Selection policy (deterministic, in order):**
1. Filter: `hash_verified === true` AND `confidence === "high"`.
2. Gate-eligibility: `target_path` under a `PLUGIN_ARTIFACT_ROOTS` dir and NOT the eval surface or a harness entrypoint; `tool_description_not_loadable` for TypeScript paths.
3. Rank: by `attributed_violation_count` descending, then `weighted_count` (optional secondary), then deterministic tie-break.
4. Budget: take up to `maxTargetsPerPass`; overflow → `skipped[reason="budget_exhausted"]`.
5. Read `baseline_body` from disk (fail-open: empty string on ENOENT).

**No model calls**: verified by `grep -rniE 'anthropic|claude -p|messages.create|model:' select-mutation-targets.ts` — must return empty.

## Injection Contract (ADR-0022 + ADR-0025)

Two injection modes, auto-dispatched from `target_path` via `isGuardrailTarget()`:

**Eval-surface mode (`withInjectedCandidate`) — ADR-0022 (unchanged):**

`withInjectedCandidate(projectDir, candidateText, targetPath, fn)`:

1. `fs.mkdtemp` — creates a fresh temp dir under `os.tmpdir()`.
2. `fs.cp(recursive)` — copies `skills/canon/evals/` into the temp dir (in-process, ~8ms).
3. Writes `candidateText` to the resolved `targetPath` within the temp tree.
4. Path-traversal guard — rejects any `targetPath` that resolves outside the temp root.
5. Calls `fn(tmpDir)` — caller runs the eval harness.
6. `fs.rm(recursive, force)` in `finally` — always cleans up, even on error.

**Guardrail mode (`withInjectedGuardrailCandidate`) — ADR-0025 (new):**

`withInjectedGuardrailCandidate(projectDir, candidateText, targetPath, fn)`:

1. `fs.mkdtemp` — creates a fresh temp dir under `os.tmpdir()`.
2. For each root in `PLUGIN_ARTIFACT_ROOTS` (`.claude-plugin`, `skills`, `agents`, `rules`, `principles`, `templates`, `references`, `primers`): `fs.cp(recursive)`, fail-open for missing roots.
3. Path-traversal + harness-entrypoint guard — same as eval-surface mode.
4. `mkdir(dirname(resolvedTarget), { recursive: true })` — creates parent dirs for new files.
5. Writes `candidateText` at `resolvedTarget`.
6. Calls `fn(tmpDir)` — caller in `eval-runner.ts` sets `EVAL_PLUGIN_DIR=tmpDir` so `run-evals.sh` passes `--plugin-dir <tmpDir> --setting-sources project` to the two activating `claude -p` runs.
7. `fs.rm(recursive, force)` in `finally` — always cleans up.

**Dispatch predicate (`isGuardrailTarget`):** returns `true` when `targetPath`'s first segment is in `PLUGIN_ARTIFACT_ROOTS` AND the path is NOT under `skills/canon/evals/`. Used by both `evaluate-candidate.ts` (dispatch) and `select-mutation-targets.ts` (gate-eligibility check).

**`EVAL_PLUGIN_DIR` env variable:** optional, default unset = prior eval-surface behavior. Set only for the two activating `claude -p` runs within `run-evals.sh` when the variable is non-empty. Not set for baseline runs (no candidate injected).

**Invariants**: the real project tree is NEVER mutated by either mode. The candidate-injection tests snapshot directory hashes before/after and assert equality.

**Known gap — tool-descriptions remain gate-ineligible**: Tool descriptions live in `register-*.ts` (TypeScript source), not in plugin-loaded markdown files. They are NOT copied into the guardrail sandbox and therefore cannot be evaluated by the holdout gate. `GateIneligibleTarget.reason = "tool_description_not_loadable"` is the typed signal. This is a structural constraint of the current plugin-load surface; no workaround in Phase 1.

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
- `select_mutation_targets` reads baseline bodies from disk synchronously (fail-open). The tool is offline; this is acceptable.
- The candidate rewrite (Step 2 of the evolve-candidate skill) is **model-backed** and lives in the learner layer (the `canon:evolve-candidate` skill). It is never a tool or an MCP call. `select_mutation_targets` and `evaluate_candidate` are the tool-layer bookends; the model call between them is the learner's inline `sonnet` rewrite.

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

**Cross-root artifact re-read (`resolveArtifactReadPath`, `services/artifact-path-resolver.ts`, Codex P2 #1):** both `attribute_failure`'s `readCurrentBody` seam and `select_mutation_targets`' baseline-body read resolve provenance paths project_dir-first, falling back to `pluginDir` when the path's first segment is a `PLUGIN_ARTIFACT_ROOTS` dir AND the artifact is absent from `project_dir` AND present under `pluginDir` — closes the cross-root gap where a trusted plugin-tier artifact (e.g. `agents/engineer.md`) absent from `project_dir` under a foreign plugin install was spuriously `hash_unverified`/missing. The committable `project_dir` copy still wins when present (mutation-apply semantics unchanged — this is a READ-path fix only). Untrusted `.canon/` overlay paths never fall back (ADR-0027 trust boundary). `pluginDir` is threaded in as an optional handler param (`attributeFailure(input, pluginDir?)`, `selectMutationTargetsHandler(input, pluginDir?)`), injected from server-state by `register-evolution.ts` — same pattern as `register-agent-teams.ts`. It is NOT a public schema field on either tool's `Input`.

## Tools: `record_applied_evolution` + `get_evolution_outcomes` (ADR-0034)

Post-apply evolution regression detection (Inc 1 + Inc 2). Backed by the drift.db
`applied_evolutions` table (v12 migration) + `AppliedEvolutionsDao`.

**`record_applied_evolution` (`tools/record-applied-evolution.ts`)** — AUTHORITATIVE /
FAIL-CLOSED write. Input carries pre-computed `before_hash`/`after_hash` (the call-site
hashes on-disk content via `hashContent`; the tool never reads files), `principle_id`
(nullable — null for agent-def cliff targets), `holdout_baseline`/`holdout_candidate`,
`apply_base_commit` (optional; the apply does not commit — `applying_commit` stays null,
back-filled later from the `Canon-Evolution:` trailer), `applied_at`, `project_dir`.
Reaches drift.db via `getDriftDb(project_dir).getAppliedEvolutions().record(...)`.
A storage failure returns a `ToolResult` error (`UNEXPECTED`) — NEVER fail-open, since
a lost provenance record is the exact gap this closes. Idempotent on `proposal_id`.

**`get_evolution_outcomes` (`tools/get-evolution-outcomes.ts`)** — FAIL-OPEN read.
Input `{ proposal_id, project_dir }`. Loads the `applied_evolutions` row
(`PROPOSAL_NOT_RECORDED` if absent; `INVALID_INPUT` if `proposal_id` empty), then splits
the TARGET-SCOPED signal into a pre/post cohort anchored on `applied_at`:
principle-carrying targets → `reviews`⋈`violations` filtered by `principle_id`; agent-def
cliff targets (`principle_id` null) → `cliff_events` filtered by the agent derived from
`target_path` (`canon:` prefix stripped). Confidence reuses `deriveTier(score, min(preEvents,
postEvents))` — `insufficient` when either side < 5. Concurrent applies touching the same
signal (via `listAppliedSince`) set `ambiguous:true` + `confounding_proposal_ids[]`, verdict
`ambiguous`. Verdict ∈ `regression_candidate | no_signal_change | improvement_candidate |
ambiguous | insufficient`. Absent signal rows → cohort zeros + `insufficient` (never an error).

**Apply-provenance call-sites**: `record_applied_evolution` is invoked from the
`review-learnings` apply path (Writer arm + Arm M), guarded on `type == "evolution-candidate"`
(legacy proposals — new-convention, severity-change, prune — carry no holdout scores and get
NO record; Arm T / Arm F never write, so never record). The Writer arm captures `before_hash`
from the on-disk target BEFORE spawning the writer (hashing after the edit would make
`before_hash == after_hash`); Arm M reuses the pre-write content it already read for the diff.
The command does not commit, so `applying_commit` is left null at record time (back-filled later
from the `Canon-Evolution:` trailer). The record only writes a drift.db row — no revert/quarantine/merge.
See `skills/canon/commands/review-learnings.md`.

**`Canon-Evolution:` trailer** (`shared/lib/commit-trailers.ts`) — optional `evolutionId?`
on `TrailerOpts` appends a `Canon-Evolution: {id}` line after `Canon-Task` (or after
`Canon-State` when no task). Additive/backward-compatible; enables later back-fill of
`applied_evolutions.applying_commit` from git history.

## Attribution Join Contract (ADR-0024, ADR-0032)

- **`review_violation`** — TWO independent join edges may fire per violation (both can attribute the same violation):
  - `join_basis: "principle_id==artifact_id"` — joined on `violation.principle_id == assembled_artifacts[].id`; inferred, lossy; lossy cases become `unattributed[]` or `ambiguous[]`.
  - `join_basis: "code_author_agent_def"` (ADR-0032) — joined on the DISTINCT `agent-def` artifacts owned by a code-authoring agent (`CODE_AUTHORING_AGENTS = {"engineer"}`) present anywhere in the run's provenance array — no per-violation step-key threading (every engineer step loads the same `agents/engineer.md`, so the mutation target is singular and hash-verifiable regardless of which step produced the reviewed code). Confidence: `high` when `hash_verified` and exactly one distinct code-author agent-def; `medium` + `ambiguous:true` when more than one distinct agent-def is present. A reviewer-only step's agent-def is NOT attributed via this edge (only `CODE_AUTHORING_AGENTS` steps qualify).
- **`cliff_event`** — joined on `cliff.step_id == provenance.step_id` (`join_basis: "cliff_step_id"`); exact, high-confidence; widening `RawArtifact.kind` to include `"agent-def"` was the only change needed — the existing loop already attributes every artifact in a matched step.
- **`test_failure`** — DEFERRED; no durable joinable key in current trace schema. Re-add per ADR-0024 Revisit-If once a `step_id`-keyed test_failure event type is available.
- **content_hash** — re-hashed from the raw (untrimmed) pre-disclosure artifact body via `hashContent`; mismatch → `flagged[]` with `hash_verified: false`; exact match → `hash_verified: true`. Fail-closed: only exact SHA256 match counts. For `agent-def`, the hash covers the WHOLE file (frontmatter included) — `readCurrentBody` byte-identity re-check is unchanged.
- **Hypothesis vocabulary** — all `hypothesis` strings use presence/context vocabulary; "caused"/"causes" are prohibited (verified by grep on every build). This grep now covers BOTH `services/attribution-join.ts` AND `tools/get-evolution-outcomes.ts` — the latter's `hypothesis`/verdict narrative uses candidate-regression/correlation phrasing; the whole file has zero `caus(e|ed|es)` matches (a dedicated unit test greps the source). Note the constraint bans the substring, so "because" is also excluded.
- **`deriveConfidence`** now keys on `join_basis` (was `failureKind`) — `FailureAttribution["join_basis"]` has 3 values: `"cliff_step_id"`, `"principle_id==artifact_id"`, `"code_author_agent_def"`.

## Known Constraints

- `runShell` is `spawnSync` (synchronous) — relevant to `evaluate_candidate` only; `attribute_failure` has no subprocess calls.
- `getTranscriptExcerpt` seam in `attribute_failure` is wired but returns `[]` in v1 (transcript evidence not yet populated).
- `attribute_failure` reads from two Canon stores: execution-store `orchestration.db` (for `context_provenance` events via `getEventsByType`) and drift.db (for cliff events via `CliffEventsDao`). It does NOT write to any Canon storage.

## Mutator Pipeline (Phase 1 complete)

The full mutator pipeline runs in the learner via the `canon:evolve-candidate` skill:

1. `select_mutation_targets` (tool) — selects attribution-backed targets, returns `MutationTarget[]` with `baseline_body`.
2. Inline Sonnet rewrite (learner, model-backed) — generates a full-file candidate text per target; NOT a tool.
3. `evaluate_candidate` (tool) — runs holdout gate; caller passes `splits: ["holdout"]`.
4. `shapeMutationProposal` (pure function in `mutation-proposal.ts`) — shapes accepted result into `MutationProposal`.
5. Write proposal to `.canon/proposed-learnings/` (or workspace plans dir).

Only `accepted === true` survivors are emitted. The learner NEVER applies proposals — it surfaces them for orchestrator routing.

## Future Phases

- Phase 2: evolve loop — orchestrator-level routing of accepted proposals (writer/engineer-build-flow channels).
- Phase 3: multi-candidate generation, ranking by expected holdout improvement.
