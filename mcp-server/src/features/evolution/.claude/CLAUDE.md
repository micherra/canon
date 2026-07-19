# features/evolution/ — Trace-Driven Evolution Bounded Context

<!-- last-updated: 2026-07-19 -->

## Purpose

The `evolution/` feature module implements Canon's trace-driven evolution
pipeline (Phase 1 + Gap 3 trust-weighted attribution). It provides seven MCP tools:
- `evaluate_candidate` — offline fitness gate (§7 strict-holdout, ADR-0022/ADR-0025 dual injection)
- `attribute_failure` — attribution consumer: joins recorded `context_provenance` with review violations + cliff events to localize each failure to the in-context artifact (ADR-0024)
- `select_mutation_targets` — deterministic (no model calls) selection layer: composes `attribute_failure`, applies policy + budget, returns construction-ready `MutationTarget[]` for the learner; also accepts a `scores` input mode (Gap 3 L3) that selects retire/reinforce targets from `attribute_outcomes` scores
- `attribute_outcomes` — trust-weighted, two-sided (positive `honored[]` + negative violations/cliff) per-principle scorer over the decisions/RunSummary corpus; offline, deterministic, derive-on-read — no new drift.db table (ADR-0051, Gap 3 L1+L2)
- `record_applied_evolution` — authoritative/fail-closed apply-provenance write to drift.db `applied_evolutions` (ADR-0034)
- `get_evolution_outcomes` — fail-open, target-scoped, apply-anchored regression HYPOTHESIS reader
- `backfill_applying_commit` — observable-best-effort back-fill of `applied_evolutions.applying_commit` from `Canon-Evolution:` git trailers (Inc-3, ADR-0034)

All tools are **offline** — never called on the build hot path.

## Architecture

```
features/evolution/
├── tools/
│   ├── evaluate-candidate.ts       # MCP tool handler — dual-mode dispatch via isGuardrailTarget()
│   ├── attribute-failure.ts        # MCP tool handler (thin wrapper over attribution services)
│   ├── select-mutation-targets.ts  # MCP tool handler — composes attribution pipeline + selectMutationTargets(); scoresModeHandler() for the Gap 3 L3 `scores` input mode
│   ├── attribute-outcomes.ts       # MCP tool handler (Gap 3 L1+L2, ADR-0051) — enumerates archives, reads RunSummary + cliff events per build, calls aggregateOutcomes(); thin
│   └── backfill-applying-commit.ts # MCP tool handler — parseEvolutionTrailers (pure) + backfillApplyingCommit (Inc-3, ADR-0034)
├── services/
│   ├── eval-runner.ts          # parseSummary, decideGate, decideCompositeGate (holistic veto, 2026-07-06), resolveAgentEvalRoot + resolveHolisticEvalRoot (per-agent + holistic suite resolution, 2026-07-06), runSplit (pure + one I/O fn, agentEvalRoot/evalRootOverride options)
│   ├── candidate-injection.ts  # withInjectedCandidate (ADR-0022) + withInjectedGuardrailCandidate (ADR-0025) + isGuardrailTarget()
│   ├── mutation-types.ts       # Pure types: MutationTarget, GateIneligibleTarget, SkippedAttribution, SelectMutationTargetsResult, MutationProposal, ArtifactClass; MutationProposalKind ("rewrite"|"retire"|"reinforce"), ScoreProvenance/ScoreProvenanceContribution (Gap 3 L3); MutationTarget gained optional trust_tier/holdout_exempt (ADR-0063, principle-wording mutation class); budget constants DEFAULT_MAX_TARGETS_PER_PASS, CANDIDATES_PER_TARGET
│   ├── mutation-selection.ts   # selectMutationTargets() — pure join+rank+filter; PLUGIN_ARTIFACT_ROOTS eligibility check; classifyArtifact() maps .canon/principles/** -> "principle" (overlay tier, data-driven PREFIX_ARTIFACT_CLASS table); isOverlayPrincipleTarget() — pure predicate, overlay .canon/principles/** eligibility, separate from isGateEligible; filterAndPartition narrowly admits attr.confidence:"medium" when join_basis is the inferred principle join (dc-01, ADR-0063 — the review_violation->principle join can never exceed medium); derivePrincipleId() keys agent-def targets off the violated principle, not the agent name (Codex P2 #2); selectRetirementReinforcementTargets() + RETIREMENT_REINFORCEMENT_NET_SCORE_THRESHOLD (Gap 3 L3, ADR-0052)
│   ├── mutation-proposal.ts    # shapeMutationProposal() — shapes accepted eval result into MutationProposal; proposalKind-branched (rewrite/retire/reinforce, ADR-0052); evalResult accepts null for the ungated reinforce path; buildOverlayImpactSection() — dedicated Impact section for an overlay .canon/principles/** target (trust_tier:"untrusted-project-local"/holdout_exempt:true), documents the never-gated/HITL-is-the-gate posture (ADR-0063)
│   ├── attribution-types.ts    # Mutator-facing output types: FailureKind, AttributedArtifact, FailureAttribution, AttributeFailureResult
│   ├── attribution-join.ts     # attributeFailures() — pure join of provenance + failure sources; review_violation attributes via BOTH the rule edge (principle_id==artifact_id) and the code-author agent-def edge (ADR-0032)
│   ├── attribution-provenance-source.ts  # readProvenance() — reads live workspace or archived RunSummary
│   ├── attribution-failure-sources.ts   # collectFailureSources() — reads review violations + cliff events
│   ├── positive-attribution.ts # attributeHonored() (Gap 3 L1, ADR-0051) — parses honored[] `**{id}**` prefixes (trailing colon optional) at read time, charset-validated by the shared `isPrincipleIdShaped` guard imported from platform archive extractors, joins to in-context provenance artifacts; mismatch/missing artifact -> flagged only, never attributed (asymmetric with the negative path)
│   ├── attribution-weight.ts   # computeTrustWeight() (Gap 3 L1) — pure sign x roleTier x corroboration x decay x computeOutcomeWeight composite; TrustTierSlot ("internal"|"codex", codex reserved/v1-unused per ADR-0052)
│   ├── outcome-attribution.ts  # aggregateOutcomes() (Gap 3 L2, ADR-0051) — pure two-sided per-principle aggregation over BuildRecord[]; TrustWeightedScore, AggregateOutcomesResult
│   ├── artifact-path-resolver.ts  # resolveArtifactReadPath() — pure cross-root re-read resolver: project_dir-first, pluginDir-fallback for trusted plugin-tier artifacts (Codex P2 #1)
│   └── frontmatter-guard.ts    # checkFrontmatterImmutable() — pure runtime frontmatter-immutability guard (ADR-0031 amendment); checkPrincipleFrontmatterImmutable() — field-level (not raw-block) principle guard, tolerates archived:true ONLY when the caller asserts isRetire (fail-closed default rejects it as a rewrite) — ADR-0063
└── __tests__/
    ├── decide-gate.test.ts               # decideGate + decideCompositeGate (holistic veto, 2026-07-06)
    ├── parse-summary.test.ts
    ├── evaluate-candidate.test.ts
    ├── evaluate-candidate-holistic-gate.test.ts  # handler-wiring for the holistic composite gate (split out of evaluate-candidate.test.ts on file-length grounds)
    ├── candidate-injection.test.ts
    ├── guardrail-injection-integration.test.ts  # Integration: guardrail sandbox build + isGuardrailTarget predicate
    ├── mutation-proposal.test.ts         # rewrite/retire/reinforce proposal shapes; gated:boolean, nullable holdout fields
    ├── mutation-selection.test.ts
    ├── mutation-selection-principle-id.test.ts  # derivePrincipleId(): agent-def -> violated principle_id, cliff agent-def -> null, rule/cliff-on-rule unchanged
    ├── mutation-selection-relaxation.test.ts    # classifyArtifact(.canon/principles/**), isOverlayPrincipleTarget(), the narrow medium-confidence relaxation (ADR-0063)
    ├── retirement-selection.test.ts      # selectRetirementReinforcementTargets: threshold, retire/reinforce/neutral-band, artifact_unresolved skip (Gap 3 L3)
    ├── retire-candidate-emission.test.ts # dc-04 end-to-end: selection -> evaluate_candidate (REAL gate) -> shapeMutationProposal -> emission, principles/** never mutated; reinforce bypasses evaluate_candidate entirely
    ├── mutator-gate-integration.test.ts
    ├── proposal-shape-parity.test.ts    # Proposal frontmatter matches canonical template in SKILL.md (rewrite + reinforce fixtures)
    ├── select-mutation-targets.test.ts  # includes scores-mode: INVALID_INPUT when combined with workspace/archive_id, retire/reinforce emission, unresolvable principle_id -> skipped
    ├── attribution-join.test.ts           # 17 pure unit tests (happy path, byte-identity, cliff join, lossy paths)
    ├── attribute-failure.test.ts          # 6 integration tests (real SQLite + REVIEW.md)
    ├── attribution-provenance-source.test.ts
    ├── attribution-failure-sources.test.ts
    ├── attribution-join-agent-def.test.ts        # cliff->agent-def + review_violation->agent-def code-author join (7 cases)
    ├── positive-attribution.test.ts       # attributeHonored: happy path, unparseable honored line, no in-context artifact, hash mismatch, artifact missing, empty inputs
    ├── attribution-weight.test.ts         # computeTrustWeight: role tier, adversarial step, corroboration, decay, sign, codex tier slot, errors-are-values, determinism
    ├── outcome-attribution.test.ts        # aggregateOutcomes: corroboration counting, decay wiring, tier_breakdown, two-sided dc-03, determinism dc-01, agent-def no-principle skip, flagged pass-through, meta.decisions_seen
    ├── attribute-outcomes.test.ts         # fixed-corpus score assertion, determinism dc-01, two-sided dc-03, fail-open (no archives), INVALID_INPUT, no-LLM grep
    ├── artifact-path-resolver.test.ts            # self-host, foreign-install fallback, overlay never-fallback, fail-closed missing, absolute-as-is
    ├── frontmatter-guard.test.ts                 # 11 pure unit cases for checkFrontmatterImmutable
    ├── evaluate-candidate-frontmatter-guard.test.ts  # 4 handler-wiring cases — asserts zero runShell calls on reject
    ├── agent-def-real-path-integration.test.ts   # end-to-end: resolveAgentSkills -> readProvenance -> attributeFailures -> selectMutationTargets -> evaluateCandidate's frontmatter guard, using the REAL emitted path (no hand-written fixture)
    └── backfill-applying-commit.test.ts          # 10 cases: 6 parseEvolutionTrailers unit tests (charset guard, dedupe, first-seen-wins) + 4 handler integration tests (happy path, no-op, INVALID_INPUT, fail-safe) — Inc-3
```

Registered via `src/app/register-evolution.ts` → `createCanonServer()`.

## Tool: `evaluate_candidate`

**Input:**
- `candidate_text` (string) — The artifact text to evaluate.
- `target_path` (string) — Path relative to `project_dir` where the candidate
  is injected (e.g. `skills/canon/evals/eval-set.json`).
- `splits` (optional array of `"train"|"val"|"holdout"`) — Defaults to all three.
- `project_dir` (string) — Absolute path to the project root.
- `proposal_kind` (optional `"rewrite"|"retire"|"reinforce"`, ADR-0063) — distinguishes a wording-REWRITE candidate from an ADR-0052 RETIRE candidate; only affects the `principles/` frontmatter guard's `archived:true` exception (see below). Omitted/`"rewrite"`/`"reinforce"` all fail-closed-reject an `archived` flip; only `"retire"` tolerates it.

**Output (`EvaluateCandidateResult`):**
- `baseline_score` / `candidate_score` — Holdout pass counts (convenience fields).
- `per_split` — `{ train, val, holdout }` each with `{ baseline_passed, candidate_passed, total }`.
- `accepted` — `true` iff `candidate_holdout > baseline_holdout` (strict, §7 gate).
- `regressed` — `true` iff candidate regressed holdout.
- `size_delta` — Candidate length minus baseline file length (chars). Signal only, not a gate.
- `judge_votes_holdout` — Always `3` (documents AC#7, evaluate-candidate-04).
- `guard_rejection?` — additive-optional; present ONLY when a fail-closed guard rejected the candidate before any subprocess ran. `{ reason: "frontmatter_modified" | "frontmatter_unverifiable" | "overlay_not_sandboxable"; fields?: string[] }` (`"overlay_not_sandboxable"` added ADR-0063). Backward compatible — existing consumers already treat `accepted:false` as "do not propose".

**Overlay fail-closed reject (`isOverlayTarget`, ADR-0027/ADR-0063):** checked FIRST, before any file read or subprocess. When `target_path`'s normalized first segment is `.canon` (case-insensitive), the handler immediately returns `guard_rejection:{reason:"overlay_not_sandboxable"}` — defense-in-depth on top of the guardrail sandbox's own `PLUGIN_ARTIFACT_ROOTS` exclusion of `.canon/` (ADR-0027: untrusted overlay content must never enter the eval sandbox, even in principle).

**Runtime frontmatter-reject guard (`checkTargetFrontmatterImmutable`, `services/frontmatter-guard.ts`):** dispatches per `target_path` (pure, no I/O):
- `agents/` (`isAgentDefTarget`) → `checkFrontmatterImmutable` — RAW frontmatter block (`---\n...\n---`, byte-for-byte) comparison, unchanged (ADR-0031 amendment).
- `principles/` (`isPrincipleDefTarget`, built-in only — overlay `.canon/principles/**` is already rejected above) → `checkPrincipleFrontmatterImmutable` — FIELD-LEVEL comparison; every top-level key must stay byte-identical EXCEPT `archived`, which is tolerated only when `proposal_kind === "retire"` (ADR-0063). Fail-closed default (omitted/`"rewrite"`/`"reinforce"`) treats a flipped `archived` as a modification.
- every other target → `{ ok: true }` (no guard; unchanged).

The dispatcher runs BEFORE `checkScriptReachable`/any subprocess. Differing (non-tolerated) fields → `accepted:false` + `guard_rejection:{reason:"frontmatter_modified", fields}` (`fields` = best-effort top-level YAML keys that changed — a diagnostic, never the basis of the comparison). Unparseable frontmatter on either side → fail-closed `guard_rejection:{reason:"frontmatter_unverifiable"}`. Never throws. Body-only candidates proceed to normal scoring unaffected.

## Tool: `select_mutation_targets`

**Input (`SelectMutationTargetsInputSchema`):**
- `workspace` (string, optional) — absolute path to a live Canon workspace; exactly one of `workspace`, `archive_id`, or `scores` must be provided.
- `archive_id` (string, optional) — archive ID of a completed build (from `get_build_history`).
- `scores` (`TrustWeightedScore[]`, optional, Gap 3 L3) — output of `attribute_outcomes`. When provided, dispatches to `scoresModeHandler` instead of the attribution pipeline; not used with `workspace`/`archive_id`.
- `project_dir` (string, required) — absolute path to the project root.
- `max_targets_per_pass` (number, optional) — override budget cap; default `DEFAULT_MAX_TARGETS_PER_PASS` (3). Not used in `scores` mode.

**`scores` mode (Gap 3 L3, ADR-0052):** `scoresModeHandler(scores, resolveArtifact, project_dir)` calls `selectRetirementReinforcementTargets(scores, resolveArtifact, { threshold? })` (`services/mutation-selection.ts`) — a pure, deterministic nomination over `net_score`:
- `net_score <= -RETIREMENT_REINFORCEMENT_NET_SCORE_THRESHOLD` (default 3) → `proposal_kind: "retire"`.
- `net_score >= +RETIREMENT_REINFORCEMENT_NET_SCORE_THRESHOLD` → `proposal_kind: "reinforce"`.
- Between the two (exclusive) → neutral band, not nominated.
- Each nominated `principle_id` is resolved to its on-disk artifact via `loadAllPrinciples` (scope: `principles/{rules,strong-opinions,conventions}/*.md` only — NOT the top-level agent-behavior `rules/*.md` class); unresolvable → `skipped[reason: "artifact_unresolved"]`; not-gate-eligible → `skipped[reason: "not_gate_eligible"]`. Never thrown.
- Every returned `MutationTarget` carries `score_provenance: { net_score, contributing_builds }` (the auditable trace) and `attribution: null` / `failure_kind: null` (no single violation backs a corpus-wide score).
- `meta`: `{ attributions_seen: scores.length, budget: scores.length, selected: targets.length }`.

**Output (`SelectMutationTargetsResult`):**
- `targets[]` — `MutationTarget[]`: each has `target_path`, `artifact_class`, `baseline_body`, `char_span`, `gate_eligible: true`, `confidence`, `failure_kind`, `principle_id`, `attribution`.
- `gate_ineligible[]` — `GateIneligibleTarget[]`: paths rejected as not gate-eligible (typed bucket, not dropped); `reason` values: `tool_description_not_loadable`, `file_missing`, `path_traversal`, `harness_entrypoint`.
- `skipped[]` — `SkippedAttribution[]`: attributions not promoted before eligibility check; `reason` values: `hash_unverified`, `confidence_below_high`, `budget_exhausted`.
- `meta` — `{ attributions_seen, selected, budget }` for observability.

**`principle_id` semantics (`derivePrincipleId`, Codex P2 #2):** for every `target_artifact.kind` EXCEPT `"agent-def"`, `principle_id === target_artifact.id` (rule/ref/primer/template file ids ARE the principle they carry — unchanged). For `kind:"agent-def"`, `target_artifact.id` is the AGENT NAME (e.g. `"engineer"`), not a principle — `principle_id` is instead the VIOLATED principle from `attributed_violations[0].principle_id`, or `null` for a `cliff_event` agent-def attribution (a write-cliff has no principle). This keeps downstream recurrence/learning keyed by principle even when the mutation target is an agent-def.

**Selection policy (deterministic, in order):**
1. Filter: `hash_verified === true` AND (`confidence === "high"` OR the narrow ADR-0063 relaxation — `confidence === "medium"` AND `attribution.join_basis === "principle_id==artifact_id"`; every other `join_basis`/class stays high-only. Motivated by the `review_violation`→principle join structurally capping at `medium` — `deriveConfidence` itself is unchanged, only SELECTION admits the honest medium label.)
2. Gate-eligibility: `target_path` under a `PLUGIN_ARTIFACT_ROOTS` dir and NOT the eval surface or a harness entrypoint (`isGateEligible`) OR an overlay `.canon/principles/**` target (`isOverlayPrincipleTarget`, ADR-0063 — a dedicated predicate, deliberately not folded into `isGateEligible`); `tool_description_not_loadable` for TypeScript paths.
3. Rank: by `attributed_violation_count` descending, then `weighted_count` (optional secondary), then deterministic tie-break.
4. Budget: take up to `maxTargetsPerPass`; overflow → `skipped[reason="budget_exhausted"]`.
5. Read `baseline_body` from disk (fail-open: empty string on ENOENT).
6. Stamp `trust_tier`/`holdout_exempt` on each returned `MutationTarget` (`buildMutationTarget`) — `"untrusted-project-local"`/`true` for an overlay `.canon/principles/**` target, `"trusted"`/`false` for every other target (ADR-0063).

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

## Holistic Composite Gate: decideCompositeGate (added 2026-07-06)

```ts
function decideCompositeGate(
  perStage: PerSplit,
  holistic: PerSplit | null,
): { accepted: boolean; regressed: boolean } {
  const perStageDecision = decideGate(perStage);
  if (holistic === null) return perStageDecision; // no holistic suite -> unchanged decideGate result
  const h = holistic.holdout;
  const holisticNonRegress = h.candidate_passed >= h.baseline_passed;
  const holisticRegressed = h.candidate_passed < h.baseline_passed;
  return {
    accepted: perStageDecision.accepted && holisticNonRegress, // veto, not a second strict-improvement term
    regressed: perStageDecision.regressed || holisticRegressed,
  };
}
```

- ANDs the unchanged per-stage strict `>` (`decideGate`) with a holistic **non-regression veto** (`>=`) — never a second strict-improvement term. A stage-targeted mutation usually leaves most golden-PR whole-file verdicts unchanged; requiring holistic to also strictly improve would make acceptance practically impossible. The composite can only make acceptance STRICTER than the per-stage decision alone, never looser.
- Only runs for the **holdout** split — train/val are never read by the composite decision.
- Motivated by the PR #332 incident (a new WARNING-assigning sub-check added without updating the Verdict table) — the mandatory Goodhart guard (G4, watch_VVVVV2) for per-agent candidate evaluation.
- Wired into `evaluate_candidate` (`tools/evaluate-candidate.ts`): `resolveHolisticEvalRoot(tmpDir, agentEvalRoot)` resolves the holistic sub-suite path (e.g. `agents/reviewer/evals/holistic`) when `<agentEvalRoot>/holistic/eval-set.json` exists in the sandbox; absent → `null`, holistic run skipped, composite equals the per-stage-only decision. When present, `runSplit`'s `evalRootOverride` option points `--eval-root` at the holistic subdir while the invoked script stays `agentEvalRoot`'s `run-agent-evals.sh` (the script always lives at the suite root, one level above `holistic/`).

## Per-Agent Eval Suite Resolution: resolveAgentEvalRoot (added 2026-07-06)

`resolveAgentEvalRoot(tmpDir, targetPath)` (`services/eval-runner.ts`, pure) resolves an agent-def `target_path` (`agents/<name>.md`) to its per-agent eval suite root (`agents/<name>/evals`) when that directory exists in the injected sandbox; returns `null` for non-agent-def targets (e.g. `skills/canon/evals/eval-set.json`) or when the agent has no per-agent suite. `tools/evaluate-candidate.ts` threads the resolved root into `runSplit`'s `agentEvalRoot` option, which dispatches to `agents/<name>/evals/run-agent-evals.sh --eval-root agents/<name>/evals` instead of the global `skills/canon/evals/run-evals.sh`. Only `runOneSplit` is threaded through — `checkScriptReachable` (the cheap dry-run sanity check) still probes the global `run-evals.sh`, which is always present in the guardrail sandbox. Currently only `agents/reviewer.md` has a per-agent suite (`agents/reviewer/evals/`).

Both `run-evals.sh` and `agents/reviewer/evals/run-agent-evals.sh` source a shared judge/vote/split core extracted to `skills/canon/evals/lib/eval-core.sh` — byte-identical global behavior, no duplicated judge logic.

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

## Tool: `attribute_outcomes` (ADR-0051, Gap 3 L1+L2)

**Input** (`AttributeOutcomesInputSchema`):
- `archive_ids` (string[], optional) — defaults to every archive registered in drift.db for `project_dir` (via `db.getArchiveManifests()`).
- `now` (ISO string, optional) — threaded into decay. Defaults to the build corpus's max `completed_at`/`archived_at` (`resolveNowMs`) — **NEVER `Date.now()`**; determinism (dc-01) requires a single `now_ms` resolved once at the handler boundary and threaded down into the pure aggregator.
- `project_dir` (string, required) — `INVALID_INPUT` when absent.

**Output (`AggregateOutcomesResult`):**
- `scores: TrustWeightedScore[]` — one per attributed `principle_id`: `net_score`, `positive_weight`, `negative_weight`, `corroboration` (summed distinct-owning-step count), `tier_breakdown: Record<TrustTierSlot, number>`, `contributing_builds: ContributingBuild[]` (`{ archive_id, sign, weight }` — the auditable per-build trace).
- `unattributed_positive[]` / `unattributed_negative[]` — typed lossy buckets (unparseable honored line, no in-context artifact, agent-def cliff with no `principle_id`) — never silently dropped.
- `flagged[]` — hash-mismatched/missing artifacts, tagged with `archive_id`.
- `meta`: `{ builds_seen, decisions_seen, attributions_positive, attributions_negative }`.

**Handler** (`tools/attribute-outcomes.ts`) is thin: enumerates `archive_ids` (or all drift.db archives), reads each build's `run-summary.json` + drift.db cliff events (`getCliffEvents().getByWorkspace(slug)`) into a `BuildRecord`, resolves `now_ms`, and calls the pure `aggregateOutcomes()`. Per-archive read failure (missing archive, unparseable/malformed `run-summary.json`) is fail-open — that archive is skipped (`console.warn`), never blocks the rest of the corpus. `readCurrentBody` reuses `resolveArtifactReadPath` (Codex P2 #1, same project_dir-first/pluginDir-fallback resolver as `attribute_failure`/`select_mutation_targets`). `decisions` is injected by `register-evolution.ts` (composition root, `buildDecisionsCorpus`) — `features/evolution/` cannot import `features/orchestration/services/decisions-corpus.ts` directly (`no-cross-feature-internal-import`); typed `readonly unknown[]`, threaded ONLY to `meta.decisions_seen` in v1 (reserved-but-unused, mirroring the `codex` `TrustTierSlot` precedent).

**`aggregateOutcomes` (`services/outcome-attribution.ts`)** — pure, two-sided per-principle aggregation over `BuildRecord[]` (a build's `RunSummary` + cliff events). Composes `attributeHonored` (positive) and the reused `attributeFailures` (negative, from `attribution-join.ts`) per build, then folds each attribution's signed `computeTrustWeight` contribution into a running `TrustWeightedScore` per `principle_id`. Deterministic: identical input → identical (deep-equal) `scores`, sorted ascending by `principle_id`. Never throws — every lossy path lands in a typed bucket.

**Two-sided net score (dc-03):** `net_score = Σ(computeTrustWeight(contribution))` across BOTH signs — a principle with many honored citations and few violations nets positive; the reverse nets negative. `positive_weight`/`negative_weight` are the separately-summed magnitudes (for display/debugging), `net_score` is `positive_weight - negative_weight` in sign-weighted terms (not a simple subtraction of the two — each contribution already carries its own sign through `computeTrustWeight`).

**Consumed by:** `select_mutation_targets`'s `scores` input mode (Gap 3 L3) — see below.

## Tools: `record_applied_evolution` + `get_evolution_outcomes` + `backfill_applying_commit` (ADR-0034)

Post-apply evolution regression detection (Inc 1 + Inc 2) plus the Inc-3 back-fill that
closes the `applying_commit` inert seam. Backed by the drift.db `applied_evolutions` table
(v12 migration) + `AppliedEvolutionsDao`.

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
`target_path` (`canon:` prefix stripped). Confidence reuses `deriveTier(score,
min(pre.reviews_or_runs, post.reviews_or_runs))` keyed on the cohort OBSERVATION count
(reviews/runs), NOT the event count — `insufficient` when either side < 5 observations (a
rise-from-zero on an adequately-observed target still reaches a candidate verdict). Concurrent applies touching the same
signal (via `listAppliedSince`) set `ambiguous:true` + `confounding_proposal_ids[]`, verdict
`ambiguous`. Verdict ∈ `regression_candidate | no_signal_change | improvement_candidate |
ambiguous | insufficient`. Absent signal rows → cohort zeros + `insufficient` (never an error).

**`backfill_applying_commit` (`tools/backfill-applying-commit.ts`, Inc-3)** — OBSERVABLE-BEST-EFFORT
(not fail-closed like `record_applied_evolution`). Input `{ project_dir, max_commits? }`
(default `max_commits` 2000). Runs `git log --grep='^Canon-Evolution:'` via `git-adapter.ts`,
parses `{proposal_id, sha}` pairs out of the commit bodies via the pure, unit-tested
`parseEvolutionTrailers` (one pair per commit; deduped by `proposal_id`, first-seen/most-recent
sha wins; a trailer value failing the `^[A-Za-z0-9._-]+$` charset guard — dc-05, the same guard
enforced at the producer commit sink — is skipped, never surfaced as a pair), then applies them
via `AppliedEvolutionsDao.backfillApplyingCommit(pairs)`. Returns `{ updated, scanned }`. A git
or storage failure returns a `ToolResult` `UNEXPECTED` error; the caller (`review-learnings.md`)
surfaces a warning but never blocks or undoes an apply on this tool's failure —
`record_applied_evolution` stays the sole authoritative write path; this tool only reconciles a
nullable column. `backfill_applying_commit` is the SOLE writer of `applying_commit`.

**Apply-provenance call-sites**: `record_applied_evolution` is invoked from the
`review-learnings` apply path (Writer arm + Arm M), guarded on `type == "evolution-candidate"`
(legacy proposals — new-convention, severity-change, prune — carry no holdout scores and get
NO record; Arm T / Arm F never write, so never record). The Writer arm captures `before_hash`
from the on-disk target BEFORE spawning the writer (hashing after the edit would make
`before_hash == after_hash`); Arm M reuses the pre-write content it already read for the diff.
**Producer commit (Inc-3):** immediately after each `record_applied_evolution` call, both arms
create ONE git commit carrying a `Canon-Evolution: {proposal_id}` trailer — guarded by the same
dc-05 charset check and skipped (with a surfaced warning, apply left standing) on `main`/`master`
(no auto-commit on those branches). `record_applied_evolution` itself still does not commit, so
`applying_commit` is left null at record time; after all applies, `review-learnings.md` invokes
`backfill_applying_commit` once to populate it from the producer's trailers. The record only
writes a drift.db row / the producer only writes a git commit — neither reverts, quarantines, or
merges anything. See `skills/canon/commands/review-learnings.md`.

**`Canon-Evolution:` trailer** (`shared/lib/commit-trailers.ts`) — optional `evolutionId?`
on `TrailerOpts` appends a `Canon-Evolution: {id}` line after `Canon-Task` (or after
`Canon-State` when no task). Additive/backward-compatible; consumed by `backfill_applying_commit`'s
`parseEvolutionTrailers` (Inc-3) to back-fill `applied_evolutions.applying_commit` from git history.

## Attribution Join Contract (ADR-0024, ADR-0032)

- **`review_violation`** — TWO independent join edges may fire per violation (both can attribute the same violation):
  - `join_basis: "principle_id==artifact_id"` — joined on `violation.principle_id == assembled_artifacts[].id`; inferred, lossy; lossy cases become `unattributed[]` or `ambiguous[]`.
  - `join_basis: "code_author_agent_def"` (ADR-0032) — joined on the DISTINCT `agent-def` artifacts owned by a code-authoring agent (`CODE_AUTHORING_AGENTS = {"engineer"}`) present anywhere in the run's provenance array — no per-violation step-key threading (every engineer step loads the same `agents/engineer.md`, so the mutation target is singular and hash-verifiable regardless of which step produced the reviewed code). Confidence: `high` when `hash_verified` and exactly one distinct code-author agent-def; `medium` + `ambiguous:true` when more than one distinct agent-def is present. A reviewer-only step's agent-def is NOT attributed via this edge (only `CODE_AUTHORING_AGENTS` steps qualify).
- **`cliff_event`** — joined on `cliff.step_id == provenance.step_id` (`join_basis: "cliff_step_id"`); exact, high-confidence; widening `RawArtifact.kind` to include `"agent-def"` was the only change needed — the existing loop already attributes every artifact in a matched step.
- **`test_failure`** — DEFERRED; no durable joinable key in current trace schema. Re-add per ADR-0024 Revisit-If once a `step_id`-keyed test_failure event type is available.
- **content_hash** — re-hashed from the raw (untrimmed) pre-disclosure artifact body via `hashContent`; mismatch → `flagged[]` with `hash_verified: false`; exact match → `hash_verified: true`. Fail-closed: only exact SHA256 match counts. For `agent-def`, the hash covers the WHOLE file (frontmatter included) — `readCurrentBody` byte-identity re-check is unchanged.
- **Hypothesis vocabulary** — all `hypothesis` strings use presence/context vocabulary; "caused"/"causes" are prohibited (verified by grep on every build). This grep now covers BOTH `services/attribution-join.ts` AND `tools/get-evolution-outcomes.ts` — the latter's `hypothesis`/verdict narrative uses candidate-regression/correlation phrasing; the whole file has zero `caus(e|ed|es)` matches (a dedicated unit test greps the source). Note the constraint bans the substring, so "because" is also excluded.
- **`deriveConfidence`** now keys on `join_basis` (was `failureKind`) — `FailureAttribution["join_basis"]` has 3 values: `"cliff_step_id"`, `"principle_id==artifact_id"`, `"code_author_agent_def"`.

## Trust-Weighted Positive Attribution + Weighting Contract (ADR-0051, Gap 3 L1)

- **`attributeHonored` (`services/positive-attribution.ts`)** — the positive-signal mirror of `attributeFailures`. Parses each `honored[]` line's `**{id}**` prefix (trailing colon optional since 2026-07-16 — real citations carry it only 20.4% of the time; charset-validated by the shared `isPrincipleIdShaped` guard imported from `run-summary-extractors.ts`, not a re-declared regex — one closed domain, one writer) at READ TIME — `extractHonoredSection`/the archive extractor is untouched (ADR-0051 Option B), so old and new archives parse identically; the relaxation is retroactive across all builds with zero archive writes (ADR-0059). Joins the parsed `honoredId` against in-context provenance artifacts (`artifact.id === honoredId`), exactly like the negative join.
- **Asymmetric flagged handling**: a hash-mismatched or missing artifact on the POSITIVE path lands in `flagged[]` ONLY — it is never also emitted as an attribution (unlike the negative path, which still attributes at lower confidence on mismatch). Rationale: a drifted honored artifact should not boost a principle's trust score, whereas a violation remains evidence of a problem regardless of drift.
- **`computeTrustWeight` (`services/attribution-weight.ts`)** — pure, IO-free: `sign × roleTierWeight(agent_name, is_adversarial_step, tier) × corroborationWeight(distinct_owning_steps) × decay(signal_age_ms) × computeOutcomeWeight(outcome)`. `signal_age_ms` is ALWAYS caller-threaded — never `Date.now()` (dc-01/dc-05). Role tiers: security/reviewer (1.3) > engineer/author (1.0) > other (0.7); `ADVERSARIAL_STEP_MULTIPLIER` (1.2) rewards a FRESH non-author adversarial catch per watch_CCCCCCCCCCCC1; combined role-tier product clamped to `[0.5, 2.0]`. Corroboration is monotonic non-decreasing in distinct owning steps, ceilinged at 1.5. Decay is exponential with a 14-day half-life, floored at 0.05 (a stale signal still counts, just attenuated). `TrustTierSlot` is `"internal" | "codex"` — `"codex"` is a RESERVED, v1-UNUSED tier (PROBE-FINDINGS Q2: no capture seam records external-Codex origin in any offline-readable corpus today); defaults to `"internal"` so a future capture seam can add codex-origin scoring without re-scoring already-recorded history differently. `computeOutcomeWeight` is composed from `@shared/lib/outcome-weight.ts` (relocated from `features/history/services/judge-weight.ts`, see mcp-server root CLAUDE.md Shared libs). Deterministic (identical input → identical `===` output) and errors-are-values (non-finite/negative inputs degrade to neutral sub-weights, never throw).

## Retire/Reinforce Proposal Contract (ADR-0052, Gap 3 L3)

`MutationProposal`/`MutationTarget` (`services/mutation-types.ts`) gained:
- **`proposal_kind: "rewrite" | "retire" | "reinforce"`** — defaults to `"rewrite"` at every existing construction site (backward-compatible, parity-tested).
- **`score_provenance?: ScoreProvenance`** (`{ net_score, contributing_builds: ScoreProvenanceContribution[] }`) — present ONLY for retire/reinforce targets; the auditable trust-weighted trace backing the candidate (invalidate-don't-delete posture: a retirement carries WHY, never a silent drop).
- **`gated: boolean`** on `MutationProposal`, with nullable `holdout_baseline`/`holdout_candidate` (null exactly when `gated:false`).
- `MutationTarget.attribution`/`.failure_kind` widened to nullable — a retire/reinforce target has no single `FailureAttribution` to join to (a corpus-wide score, not a violation).

**Retire semantics**: `shapeMutationProposal` marks the writer target `archived: true` (the loader-honored flag `shared/matcher.ts`'s `principleMatchesFilters` already excludes — NOT `status`/`portable`, which the matcher does not check). Every RETIRE candidate is still gated by the REAL `evaluate_candidate` holdout run — an `archived:true` candidate that the eval sandbox actually drops from loading genuinely differs from baseline, so the existing strict `decideGate` `>` is meaningful (not structurally inert). A retirement that regresses holdout is rejected, never emitted.

**Reinforce semantics**: a REINFORCE candidate is byte-identical to its own baseline — no holdout run can ever distinguish it from itself, so it is emitted UNGATED (`gated:false`, `evalResult:null` passed to `shapeMutationProposal`) as a pure HITL confidence signal. `evaluate_candidate`/`runShell` is never invoked for a reinforce candidate. Never auto-applied.

**Selection threshold**: `RETIREMENT_REINFORCEMENT_NET_SCORE_THRESHOLD = 3` (`services/mutation-selection.ts`) — mirrors the learner's existing `weighted_instance_count >= 3` minimum-evidence convention, applied symmetrically to `net_score` magnitude.

**Routing**: `/canon:review-learnings` (`skills/canon/commands/review-learnings.md`) gained Arm R (retire) and Arm N (reinforce) — both fully inline, explicit invalidate-don't-delete writer-spawn instructions, kept separate from the pre-existing legacy `prune-candidate` Mode: retire path (which still `git rm`s and is intentionally left untouched/unreachable by the new `proposal_kind` track). `skills/canon/skills/evolve-candidate/SKILL.md` gained the matching Step 0.1 retire/reinforce procedure (calls `attribute_outcomes` → `select_mutation_targets` scores mode). `agents/learner.md` was granted `mcp__canon__attribute_outcomes` in its tool allowlist (otherwise the new SKILL.md instruction would be dead-wire from the agent's permission surface).

## Principle-Wording Mutation Class (ADR-0063)

A single-build review violation localized to a `principles/**` (built-in) or `.canon/principles/**`
(overlay) file can now produce a gated (built-in) or ungated-by-construction (overlay), HITL-reviewable
wording-rewrite `MutationProposal` (`proposal_kind: "rewrite"`, the pre-existing default — this is not a
new `proposal_kind` value, it is a new eligible `artifact_class: "principle"` target class).

**Two empirically-probed facts drive the design** (`PROBE-FINDINGS.md`, cited in ADR-0063):
1. The guardrail sandbox (ADR-0025) copies `principles/**` onto disk but never injects principle bodies
   into the eval session's context (`PRINCIPLES_IN_CONTEXT=NO`) — a built-in principle-wording candidate
   therefore produces zero holdout delta on the current eval surface, so `decideGate`'s strict `>` will
   almost always REJECT it. This mirrors the already-shipped ADR-0052 retirement inertness. The gate
   still runs — REJECT is expected and proves the path works end-to-end (PRD AC#5) — see ADR-0063 D3.
2. `.canon/` is never copied into the guardrail sandbox (`PLUGIN_ARTIFACT_ROOTS` excludes it, ADR-0027) —
   an overlay principle candidate cannot enter the eval sandbox even in principle. See ADR-0063 D2.

**Selection**: `classifyArtifact` now maps a `.canon/principles/` path to `artifact_class: "principle"`
(same class as a built-in `principles/` path — the two prefixes are checked via a data-driven
`PREFIX_ARTIFACT_CLASS` table). `isOverlayPrincipleTarget(targetPath)` (`mutation-selection.ts`) is a
dedicated pure predicate — `true` iff the normalized path is under `.canon/principles/` — kept separate
from `isGateEligible` (which also backs the retire/reinforce and register-/tool-description paths) so
widening one doesn't perturb the other. `filterAndPartition` admits `confidence: "medium"` ONLY when
`attribution.join_basis === "principle_id==artifact_id"` (see Selection policy above) — narrow because
the `review_violation`→principle join structurally can never reach `"high"` (transcript evidence is
unpopulated in v1). `buildMutationTarget` stamps `trust_tier`/`holdout_exempt` on every returned target:
`"untrusted-project-local"`/`true` for an overlay target, `"trusted"`/`false` for everything else.

**Gate (`evaluate_candidate`)**: an overlay `.canon/**` `target_path` is fail-closed-rejected
(`guard_rejection.reason: "overlay_not_sandboxable"`) BEFORE any file read or subprocess — defense in
depth on top of the sandbox's own exclusion. A built-in `principles/` target runs the REAL holdout gate
(mechanically-run, semantically-inert per fact 1 above) through `checkPrincipleFrontmatterImmutable` —
field-level, tolerates `archived:true` ONLY when the caller passes `proposal_kind: "retire"` (the
ADR-0052 retire track, narrowed from the prior uniform tolerance to close a gate-vs-apply soundness gap
where a wording-REWRITE that erroneously flipped `archived` would be scored on an artifact the sandbox
excludes from loading).

**Emission (`mutation-proposal.ts`)**: an overlay target's proposal renders via `buildOverlayImpactSection`
instead of the normal Impact section — states `gated: false` by construction, both `holdout_baseline`/
`holdout_candidate` `null`, and that the HITL Accept in `/canon:review-learnings` IS the trust gate.

**Apply routing**: `/canon:review-learnings`'s Writer arm gained an overlay sub-branch — when
`target_path` starts with `.canon/`, the apply-provenance hash capture, `record_applied_evolution` call,
and producer commit (Steps 1/4/5) are ALL skipped (`.canon/` is gitignored: no git provenance is
possible or meaningful). The writer still runs and edits `.canon/principles/**` in place, project-local.
Steps 6–7 (move to `applied/`, `append_learning_record`) still run, with an `overlay: true` marker added
to the appended record. `skills/canon/skills/write-principle/SKILL.md` gained the apply-proposal
`evolution-candidate` rewrite mapping: full-file body replacement, byte-preserving the existing
frontmatter — built-in `principles/**` is the tracked branch (unchanged apply-provenance wrapping),
overlay `.canon/principles/**` is the project-local branch (no git). `agents/writer.md` documents this
loop-closure mapping.

## Known Constraints

- `runShell` is `spawnSync` (synchronous) — relevant to `evaluate_candidate` only; `attribute_failure` has no subprocess calls.
- `getTranscriptExcerpt` seam in `attribute_failure` is wired but returns `[]` in v1 (transcript evidence not yet populated).
- `attribute_failure` reads from two Canon stores: execution-store `orchestration.db` (for `context_provenance` events via `getEventsByType`) and drift.db (for cliff events via `CliffEventsDao`). It does NOT write to any Canon storage.
- `attribute_outcomes` reads the same two stores as `attribute_failure`, PLUS every enumerated build's archived `run-summary.json` (via `getDriftDb().getArchiveById`); still does NOT write to any Canon storage — derive-on-read, no cache (ADR-0051).
- Codex trust-tier scoring is descoped for v1 (ADR-0052) — the reserved `TrustTierSlot` slot exists but no capture seam populates it; PRD AC#2 ships `partial`.

## Mutator Pipeline (Phase 1 complete)

The full mutator pipeline runs in the learner via the `canon:evolve-candidate` skill:

1. `select_mutation_targets` (tool) — selects attribution-backed targets, returns `MutationTarget[]` with `baseline_body`.
2. Inline Sonnet rewrite (learner, model-backed) — generates a full-file candidate text per target; NOT a tool.
3. `evaluate_candidate` (tool) — runs holdout gate; caller passes `splits: ["holdout"]`.
4. `shapeMutationProposal` (pure function in `mutation-proposal.ts`) — shapes accepted result into `MutationProposal`.
5. Write proposal to `.canon/proposed-learnings/` (or workspace plans dir).

Only `accepted === true` survivors are emitted. The learner NEVER applies proposals — it surfaces them for orchestrator routing.

**Retire/reinforce branch (Gap 3 L3, ADR-0052):** `attribute_outcomes` → `select_mutation_targets` (`scores` mode) → `shapeMutationProposal` (`proposal_kind` branched). Retire candidates still pass through the REAL `evaluate_candidate` holdout gate (step 3, unchanged); reinforce candidates skip step 3 entirely (`evalResult:null`) and emit ungated. Routed by `/canon:review-learnings` Arm R / Arm N.

## Future Phases

- Phase 2: evolve loop — orchestrator-level routing of accepted proposals (writer/engineer-build-flow channels).
- Phase 3: multi-candidate generation, ranking by expected holdout improvement.
- Codex trust-tier capture seam — populate the reserved `"codex"` `TrustTierSlot` from the ship-watch PR-comment channel into the decisions ledger (ADR-0052 Consequences).
