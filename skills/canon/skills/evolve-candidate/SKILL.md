---
name: evolve-candidate
description: >-
  Procedural skill for generating, evaluating, and shaping evolution proposals
  for Canon's trace-driven evolution loop (Phase 1 mutator pipeline).
  Orchestrates select_mutation_targets → evaluate_candidate → shapeMutationProposal
  for each selected target. Loaded by the learner agent.
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

---

## Pre-conditions

Before running this skill, verify:

1. A workspace or archive_id is available (from a completed build with attribution data).
2. `mcp__canon__select_mutation_targets` is in your tools allowlist.
3. `mcp__canon__evaluate_candidate` is in your tools allowlist.
4. The project root (`project_dir`) is known.

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
# Frontmatter keys (all required, serialized in this order)
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
| `writer` | Route to the `canon:writer` agent via `content-flow/learn-apply` for conflict detection, format validation, and the actual edit. |
| `engineer-build-flow` | Handled by `/canon:review-learnings`: primer/agent/template proposals → diff → Accept → direct-write + `sync_indexes`; tool-description proposals → surface-only (manual-apply instructions, no auto-write); unknown artifact class → fail-safe ("manual-apply required"). All arms require explicit reviewer confirmation before any write. |

The learner NEVER applies proposals itself. Surface them and stop.

---

## Constraints

- `evaluate_candidate` may take minutes per target (it runs the full eval harness).
  Process targets sequentially, not in parallel.
- If `evaluate_candidate` returns an error (non-ok result), log it as a warning and
  skip that target — never treat an eval error as an accept.
- Maximum 3 proposals per pass (DEFAULT_MAX_TARGETS_PER_PASS) unless `max_targets_per_pass`
  was overridden in Step 1.
- The `baseline_body` is already in each `MutationTarget` — do not re-read the file.
- Only generate one candidate per target (`CANDIDATES_PER_TARGET = 1`).
