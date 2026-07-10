---
name: team-dispatch-protocol
description: >-
  Full team dispatch protocol for Canon review fan-out, covering both fan-out
  axes. Horizontal: Phase 1 (partition by blast radius), Phase 2 (spawn N
  reviewers in parallel, one per disjoint file group), Phase 3 (consolidate
  with minority-finding verification probes). Vertical: Phase 1V (assign
  diverse concern lenses), Phase 2V (spawn N reviewers over the full file set,
  one per lens), Phase 3V (consolidate with single-lens-first-class,
  overlap-as-agreement, any-juror-blocks semantics). Includes a Mode Selection
  preamble and a capped hybrid escape hatch.
---

# Team Dispatch Protocol

<!-- Managed by Canon. Manual edits are preserved. -->

**Purpose**: Full partition → spawn → consolidate protocol for team-dispatched reviews, covering both fan-out axes — **horizontal** (disjoint file partitions, same lens) and **vertical** (full shared file set, diverse concern lenses). Read BEFORE spawning a team-dispatched review step. See `CLAUDE.md` § Team Dispatch Protocol for the fan-out threshold and inline one-liner.

## Mode Selection

Pick exactly one mode per team-dispatched review, in this order:

1. **Single reviewer** — below the horizontal fan-out threshold (see Phase 1) AND no ADR-0044 sensitive-path floor. Spawn one `canon:reviewer` with the full file list.
2. **Horizontal** file-partition fan-out — aggregate blast radius > ~50, OR 2+ files with `impact_score > 0.7`, OR 3+ layers with cross-layer dependencies (unchanged threshold, see Phase 1). Go to Phase 1–3 below.
3. **Vertical diverse-lens jury** — `compute_autonomy_tier` returned the ADR-0044 sensitive-path deny-list floor (`require_security: true` + `require_adversarial: true`, ADR-0044). Go to Phase 1V–3V below.
4. **Capped vertical×horizontal hybrid** — BOTH condition 2 AND condition 3 hold (sensitive-path floor AND blast-radius>50). A bounded escape hatch, not the default: partition files horizontally into K groups AND assign the M lenses, spawning M×K reviewers (each reviewer gets one partition's files and one primary lens). Because vertical does not amortize cost, M×K MUST be hard-capped (e.g. cap total reviewers at a fixed ceiling and fall back to vertical-only, dropping the horizontal partition, if the product would exceed it) — this mode exists for the rare case both triggers fire, not as an upsize of either axis alone.

## Horizontal Fan-Out

#### Phase 1 — Partition

Before spawning a team-dispatched review step, call `get_file_context` for each changed file and examine blast radius data (`in_degree`, `impact_score`, `blast_radius`). The fan-out decision is based on **aggregate blast radius** — NOT a fixed file count threshold. Signals that warrant fan-out:

- Total blast radius entries across all changed files exceeds ~50 (many downstream dependents affected)
- Multiple changed files have `impact_score > 0.7` (high-centrality changes)
- Changed files span 3+ layers with cross-layer dependencies

When fan-out is warranted, partition files into N groups (typically 2–3). Partitioning rules:

- Files in the same dependency cycle stay together
- High `in_degree` files get smaller groups (more attention per reviewer)
- Files in the same directory/module stay together when possible
- Co-change partners (from `co_change_partners`) stay together

When fan-out is NOT warranted, spawn a single reviewer with the full file list (standard single-subagent pattern).

#### Phase 2 — Spawn

Spawn N reviewers in parallel via `Agent()`, each with:

- The standard preloaded context from `resolve_agent_skills`
- `WORKSPACE={workspace_path}` (workspace root, not worktree)
- An explicit diff base: "Diff against commit {base_commit}: use `git diff {base_commit}..HEAD` instead of `git diff main..HEAD`"
- Their assigned file list
- Their reviewer number: "You are reviewer {N} of {total}. Write your review to `${WORKSPACE}/reviews/REVIEW-{N}.md`."
- No `isolation` parameter (reviewers run in the shared workspace, not a worktree)

#### Phase 3 — Consolidate

After all reviewers complete, read all `REVIEW-{N}.md` files and consolidate into the final `REVIEW.md`:

1. **Deduplicate**: Group violations by `(file_path, principle_id, line_number)`. Violations found by 2+ reviewers are confirmed — include them directly.
2. **Identify minority findings**: Violations found by only 1 of N reviewers are minority findings. These are NOT dismissed — they get a verification probe.
3. **Verification probe for minority findings**: For each minority finding:
   a. Spawn a focused verification reviewer (a single `canon:reviewer` subagent) with ONLY the specific file and the minority finding's description: "Verify whether the following finding is a true positive: {violation description} at {file:line}. Grep for the pattern and report CONFIRMED or DISMISSED with evidence."
   b. If CONFIRMED: promote to the consolidated `REVIEW.md` as a verified finding. Tag as `[minority-verified]`.
   c. If DISMISSED: log in the consolidated `REVIEW.md` under a `### Dismissed Minority Findings` section with the dismissal reason. Do NOT silently drop.
   d. **Scope limit**: If more than 5 minority findings exist, prioritize by severity (BLOCKING > WARNING) and blast radius. Probe the top 5; log the remainder as `[minority-unverified]` in the dismissed section.

   **This minority-verification probe is scoped to the HORIZONTAL axis only.** It does NOT apply to vertical single-lens findings (see Phase 3V) — the two axes deliberately treat a lone finding oppositely. On the horizontal axis, reviewers cover disjoint file partitions with the same lens, so a finding seen by only 1 of N reviewers really is a minority of *coverage*, worth double-checking. On the vertical axis, every juror reads the same full file set through a *different* lens, so a lone finding is the EXPECTED case (e.g. the contract lens should be the only one flagging a contract regression) — probing it would fire on nearly every vertical finding and mislabel the design's own premise as suspect.
4. **Union**: Merge honored lists from all reviewers.
5. **Score**: Sum scores across reviewers, adjusting for deduplicated violations.
6. **Verdict**: Take worst-case verdict across all reviewers (BLOCKING > WARNING > CLEAN). Minority-verified findings count toward the verdict.
7. Write using the `write_review` MCP tool.

## Vertical Diverse-Lens Jury

Fires when `compute_autonomy_tier` returns the ADR-0044 sensitive-path floor (`require_security: true` + `require_adversarial: true` — see ADR-0044 and ADR-0045). The **same** full changed-file set goes to every juror; jurors differ by concern **lens**, not by file scope. This composes with ADR-0044: the same trigger already forces supervised tier + a mandatory `canon:security` pass + a fresh adversarial re-review; the jury slots in alongside them.

#### Phase 1V — Assign lenses

Assign three fixed lenses to the changed-file set as a whole (every juror gets every file):

- **`correctness`** — is the code right; does it do what it claims.
- **`contract-compatibility`** — exports, tool-contracts, Zod schemas, discriminant-surface parity, agent→tool reachability, peer-consumer consistency. Weighted primary whenever the change touches exports / tool-contracts / Zod schemas; otherwise still available.
- **`clarity-maintainability`** — principle compliance, naming, public-API docs, gotcha docs.

**Security is NOT a jury lens.** It is delegated to the mandatory `canon:security` pass that ADR-0044 already forces on this same trigger (plus a fresh adversarial re-review) — a security juror would duplicate a whole opus agent that is already running on exactly this change.

#### Phase 2V — Spawn jurors

Spawn N `canon:reviewer` (one per lens — currently N=3), each with:

- The standard preloaded context from `resolve_agent_skills`
- `WORKSPACE={workspace_path}` (workspace root, not worktree)
- An explicit diff base, as in Phase 2
- The FULL changed-file set (not a partition)
- A **lens-primacy directive**: "You are the {lens} juror. Run all six review stages, but weight {lens} as PRIMARY for prioritization, depth, and ordering. Write your review to `${WORKSPACE}/reviews/REVIEW-{lens}.md`."
- No stage-scoping — every juror runs the full six-stage `canon:reviewer` (Stages 1–6), keeping the free correctness scan and cross-requirement coverage; only which stages are weighted primary differs by lens.

Use the reviewer's `M0…MV` module contract table (`agents/reviewer.md:840–889`) as the lens→stage map that the directive names:

| Lens | Primary-weighted modules |
|------|---------------------------|
| `correctness` | M1.5 (correctness scan) + M6 (cross-requirement contradictions) |
| `contract-compatibility` | M2's contract sub-axes (discriminant-surface parity, agent→tool reachability, peer-consumer consistency) + M4 (drift-from-plan) |
| `clarity-maintainability` | M1 (principle compliance) + M2's clarity axes (public-API docs, gotcha docs, naming) |

This reuse is documentary — it tells each juror which modules embody its lens — not structural; each juror stays a single-window topology-C reviewer running all modules, not a per-module spawn.

#### Phase 3V — Consolidate (jury)

Reuse the Phase 3 dedupe MECHANISM — group findings by `(file_path, principle_id, line_number)` — but with corrected, inverted semantics for the vertical axis:

1. **Single-lens findings are promoted FIRST-CLASS.** A finding surfaced by only one lens is NOT routed to the horizontal minority-verification probe (Phase 3, step 2–3) — on the vertical axis a lone finding is the expected case (each lens is authoritative in its own domain), not a suspect minority.
2. **Overlap = N-of-M agreement/confidence signal.** When ≥2 jurors flag the same `(file_path, principle_id, line_number)`, annotate the finding with the agreement count as a confidence boost — it is a signal, not a dedup-and-forget.
3. **Verdict = any-juror-blocks.** Any rule-severity finding from ANY lens → BLOCKING, regardless of whether other lenses also caught it. Agreement across lenses RAISES confidence; disagreement or lack of overlap NEVER downgrades a rule-severity finding below BLOCKING. This strengthens, and never weakens, the existing worst-case-verdict rule (Phase 3, step 6).
4. Union honored lists, sum scores, and write using the `write_review` MCP tool — same mechanics as Phase 3, steps 4–5 and 7.
