---
name: evolve-candidate
description: >-
  Procedural skill for generating, evaluating, and shaping evolution proposals
  for Canon's trace-driven evolution loop (Phase 1 mutator pipeline, plus the
  Gap 3 Layer 3 retire/reinforce pass). Orchestrates select_mutation_targets →
  evaluate_candidate → shapeMutationProposal for each selected target, and
  attribute_outcomes → select_mutation_targets (scores mode) → evaluate_candidate
  → shapeMutationProposal for trust-weighted retire/reinforce candidates. Loaded
  by the learner agent.
user-invocable: false
---

# canon:evolve-candidate — Mutator Pipeline Procedural Skill

This skill defines the step-by-step procedure for the learner to produce evolution
proposals from a completed build's attribution data. Load this skill when asked to
run the "evolve-candidate" or "mutation pass" as part of the trace-driven evolution
loop.

**Read-only constraint inherited from the learner:** you may write to `.canon/` and
workspace paths, but NEVER modify project source code, principles, or agent-rules
directly. Proposals are emitted and routed via the orchestrator.

There are TWO independent passes described below. Run either or both, per the
orchestrator's instruction:

- **Rewrite pass** (Steps 1–5) — the original Phase 1 mutator pipeline: a single
  build's violation-based attribution nominates targets for a full-file/span rewrite.
- **Retire/reinforce pass** (Step 0) — Gap 3 Layer 3: corpus-wide trust-weighted
  scores (`attribute_outcomes`) nominate principles to retire (invalidate-don't-delete)
  or reinforce (confidence bump, informational). Independent of any single build.

---

## Pre-conditions

Before running this skill, verify:

1. A workspace or archive_id is available (from a completed build with attribution data) —
   required for the rewrite pass only; the retire/reinforce pass is corpus-wide.
2. `mcp__canon__select_mutation_targets` is in your tools allowlist.
3. `mcp__canon__evaluate_candidate` is in your tools allowlist.
4. `mcp__canon__attribute_outcomes` is in your tools allowlist — required for Step 0 only.
5. The project root (`project_dir`) is known.

---

## Step 0 — Retire/reinforce pass (Gap 3 Layer 3, run independently of Steps 1–5)

This pass answers "which principle actually earns its keep?" from the whole
decisions/RunSummary corpus, not a single build. It NEVER auto-applies — like the
rewrite pass, it only emits gated candidates to `.canon/proposed-learnings/`.

### Step 0.1 — Score the corpus

Call `mcp__canon__attribute_outcomes` with `project_dir` (optionally `archive_ids`/`now`
to scope or pin the corpus):

```
mcp__canon__attribute_outcomes({ project_dir: <path> })
```

Read `scores[]` — each entry is `{ principle_id, net_score, positive_weight,
negative_weight, corroboration, tier_breakdown, contributing_builds }`. Also log
`unattributed_positive[]`, `unattributed_negative[]`, and `flagged[]` for observability
(informational — never block on them).

### Step 0.2 — Select retire/reinforce targets

Call `mcp__canon__select_mutation_targets` in **scores mode** — pass `scores` (the
array from Step 0.1) instead of `workspace`/`archive_id`:

```
mcp__canon__select_mutation_targets({
  project_dir: <path>,
  scores: <scores[] from Step 0.1>
})
```

A `net_score <= -3` nominates a `retire` target; `net_score >= +3` nominates a
`reinforce` target (the threshold mirrors the learner's `weighted_instance_count >= 3`
minimum-evidence convention as a symmetric net-score band — override via
`retirement_reinforcement_threshold` only with an explicit reason). Scores inside the
neutral band are silently not nominated — that is the expected, common case.

Read the result exactly as in Step 1 below: `targets[]` (each carries `proposal_kind:
"retire"|"reinforce"` and `score_provenance`), `skipped[]` (`artifact_unresolved` —
the principle_id has no resolvable `principles/**` file; `not_gate_eligible`).

If `targets` is empty, stop here: emit "No retire/reinforce candidates this pass."

### Step 0.3 — Produce candidate text

For each target:

- **`retire`**: produce the WEAKENED/invalidated artifact — the original
  `baseline_body` with retirement markers added (e.g. a `status: retired` /
  `portable: false` note in the frontmatter and a short note explaining why). This is
  **invalidate-don't-delete**: the candidate is never empty and never a deletion —
  it is the same artifact, marked retired.
  - Given `proposal_kind: "reinforce"` in the writer's routing, describe why the
    principle proves out. But **the invalidate-don't-delete constraint applies
    ONLY to `retire`** — never propose deleting content for either kind.
- **`reinforce`**: produce the UNCHANGED `baseline_body` as the candidate text — no
  content change is proposed; this pass is informational.

### Step 0.4 — Evaluate each candidate (holdout gate — same gate as Step 3)

Exactly Step 3 below, called per target from Step 0.2/0.3: `mcp__canon__evaluate_candidate`
with `candidate_text`, `target_path: target.target_path`, `project_dir`,
`splits: ["holdout"]`. **`evolution-hard-gate` invariant unchanged**: only proceed to
Step 0.5 when `accepted === true`. A `retire` candidate that regresses the holdout is
NEVER emitted — the artifact stays as-is.

### Step 0.5 — Shape and emit accepted retire/reinforce proposals

Exactly Step 4 below (same proposal shape — `proposal_kind`/`score_provenance` are
part of the canonical frontmatter), with two differences from the rewrite path:
- `apply_channel` is always `"writer"` for both `retire` and `reinforce` (regardless
  of `artifact_class`).
- The `## Impact` section states invalidate-don't-delete for `retire` (writer marks
  the artifact retired, never deletes it) or that the change is informational-only
  for `reinforce`.

Write the proposal to `.canon/proposed-learnings/${timestamp}/${pad2(index)}-${slug(target_path)}.md`
exactly as Step 4 — same directory, same file-naming convention, same run shares one
timestamp with any rewrite-pass proposals emitted in the same pass.

### Step 0.6 — Surface results

Same shape as Step 5, plus the retire/reinforce split:

```
### Retire/Reinforce Pass Results

- Scores read: N
- Retire candidates: M | Reinforce candidates: K
- Proposals accepted: A | Skipped (not accepted): B
- Skipped (artifact_unresolved / not_gate_eligible): C
```

---

## Step 1 — Select mutation targets

Call `mcp__canon__select_mutation_targets` with:
- `workspace` OR `archive_id` (exactly one)
- `project_dir` — absolute path to the project root

```
mcp__canon__select_mutation_targets({
  workspace: <path>,       # OR archive_id: <id>
  project_dir: <path>,
  max_targets_per_pass: 3  # optional; default is 3
})
```

Read the result:
- `targets[]` — eligible MutationTargets; each has `baseline_body`, `artifact_class`, `failure_kind`, `principle_id`
- `gate_ineligible[]` — paths rejected by the gate (informational; log them)
- `skipped[]` — attributions not promoted (hash_unverified, confidence_below_high, budget_exhausted; informational)
- `meta` — summary counts

If `targets` is empty, stop here: emit "No eligible mutation targets found for this pass."
Log gate_ineligible and skipped for observability.

---

## Step 2 — Generate candidate text (one per target)

For each target in `targets[]`:

1. Read the current `baseline_body` (it's already in the target — no filesystem read needed).
2. Identify the failure signal: what violation pattern does `failure_kind` + `principle_id` point to?
3. Produce a **full-file candidate rewrite** that addresses the failure pattern:
   - If `char_span` is available: focused edit within that span only; rest of file unchanged.
   - If no `char_span` or span is `[0, length]`: rewrite the full file.
   - The candidate must be strictly better according to the attributed principle — address the
     root cause, not symptoms.
4. The candidate text is an in-context string; do NOT write it to disk.

**Guardrail invariant**: the candidate must not contain "caused by" / "causes" language
about other agents or files — it is a text proposal only.

---

## Step 3 — Evaluate each candidate (holdout gate)

For each target + candidate text pair:

Call `mcp__canon__evaluate_candidate` with:
- `candidate_text` — the candidate rewrite from Step 2
- `target_path` — the `target.target_path` field
- `project_dir` — the project root
- `splits: ["holdout"]` — holdout-only is sufficient for the selection pass

```
mcp__canon__evaluate_candidate({
  candidate_text: <string>,
  target_path: <string>,
  project_dir: <path>,
  splits: ["holdout"]
})
```

Read the result:
- `accepted` — ONLY proceed to Step 4 when `accepted === true` (evolution-hard-gate).
- `regressed` — if true, log as "candidate regressed holdout; skipping".
- If not accepted: log the result and move on to the next target.

**evolution-hard-gate invariant**: NEVER produce a proposal for a candidate where
`accepted !== true`. This is a non-negotiable gate — not a soft guideline.

---

## Step 4 — Shape and emit accepted proposals

For each (target, candidateText, evalResult) where `evalResult.accepted === true`:

1. Construct the proposal:

```
proposal = {
  id: `evolve-${ts}-${pad2(index)}`,
  type: "evolution-candidate",
  confidence: <numeric from target.confidence>,
  target: target.principle_id ?? target.target_path,
  target_path: target.target_path,
  artifact_class: target.artifact_class,
  holdout_baseline: evalResult.baseline_score,
  holdout_candidate: evalResult.candidate_score,
  accepted: true,
  failure_kind: target.failure_kind,
  principle_id: target.principle_id,
  join_basis: target.attribution.join_basis,
  hash_verified: target.attribution.target_artifact.hash_verified,
  apply_channel: (artifact_class === "principle" || artifact_class === "rule")
    ? "writer"
    : "engineer-build-flow"
}
```

2. Write the proposal to `.canon/proposed-learnings/${timestamp}/${pad2(index)}-${slug(target_path)}.md`
   where `timestamp` is a UTC compact string (e.g. `20260626T120000Z`) generated once at the
   start of this pass and reused for all proposals written in the same run. Create the directory
   if it does not exist. This path is used in ALL cases — whether or not a workspace is available.

3. The proposal file format — canonical template (machine-parseable; tested by `proposal-shape-parity.test.ts`):

<!-- proposal-shape:begin -->
```yaml
# Frontmatter keys (all required except score_provenance, serialized in this order)
id: example-string
type: evolution-candidate
confidence: 0.9
target: example-string
target_path: example-string
artifact_class: principle
holdout_baseline: 1
holdout_candidate: 2
accepted: true
failure_kind: review_violation
principle_id: example-string
join_basis: example-string
hash_verified: true
apply_channel: writer
proposal_kind: rewrite
```

```text
## Observation
## Proposed Change
## Evidence
## Impact
```
<!-- proposal-shape:end -->

---

## Step 5 — Surface results

After all targets are processed, surface a summary:

```
### Evolution Pass Results

- Targets evaluated: N
- Proposals accepted: M
- Skipped (not accepted): K

#### Accepted proposals
- <filename> — <target_path> (artifact_class: <class>, channel: <channel>)

#### Not accepted
- <target_path>: baseline=<X>, candidate=<Y> (accepted:false)

#### Gate-ineligible (informational)
- <path>: <reason>

#### Skipped attributions (informational)
- <path>: <reason>
```

---

## Routing (apply_channel)

After emitting proposals, surface the routing intent to the orchestrator:

| apply_channel | Next step |
|---|---|
| `writer` | Route to the `canon:writer` agent via `content-flow/learn-apply` for conflict detection, format validation, and the actual edit. For `proposal_kind: "retire"`, `/canon:review-learnings` routes to the writer in **invalidate-don't-delete** mode (mark retired / `portable: false`, never `rm`). For `proposal_kind: "reinforce"`, the writer applies a confidence bump only — no content or deletion. |
| `engineer-build-flow` | Handled by `/canon:review-learnings`: primer/agent/template proposals → diff → Accept → direct-write + `sync_indexes`; tool-description proposals → surface-only (manual-apply instructions, no auto-write); unknown artifact class → fail-safe ("manual-apply required"). All arms require explicit reviewer confirmation before any write. Never used for `retire`/`reinforce` — those are always `writer` (Step 0.5). |

The learner NEVER applies proposals itself. Surface them and stop.

---

## Constraints

- `evaluate_candidate` may take minutes per target (it runs the full eval harness).
  Process targets sequentially, not in parallel.
- If `evaluate_candidate` returns an error (non-ok result), log it as a warning and
  skip that target — never treat an eval error as an accept.
- Maximum 3 proposals per pass (DEFAULT_MAX_TARGETS_PER_PASS) unless `max_targets_per_pass`
  was overridden in Step 1. The retire/reinforce pass (Step 0) has no fixed cap — it is
  bounded by however many scores cross the threshold, each still gated by `evaluate_candidate`.
- The `baseline_body` is already in each `MutationTarget` — do not re-read the file.
- Only generate one candidate per target (`CANDIDATES_PER_TARGET = 1`).
- **invalidate-don't-delete** (Step 0 only): a `retire` candidate is NEVER an empty file
  or a deletion request — it is the original artifact with a retirement marker added.
  Only the writer agent (via `/canon:review-learnings`'s routing, never this skill) may
  mark an artifact retired on disk, and it must never `rm` the file.
