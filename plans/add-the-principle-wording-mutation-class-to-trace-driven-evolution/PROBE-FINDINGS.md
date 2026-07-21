# PROBE-FINDINGS — Principle-Wording Mutation Class

All four PRD-flagged UNVERIFIED current-behavior claims were probed by **invoking the real
capability** (running the MCP tool / the shipped injection function / a real `claude -p` in the
ADR-0025 sandbox / reading the deterministic selection source), never environment inspection.
Base commit: `59d944e53db6b3d22b97b9200cd74cf763ea80af`.

---

## Probe 1 — Does the `principle_id` attribution join localize failures to principle files on the real corpus today?

**Method:** ran `mcp__canon__attribute_failure` on the 4 most-recent real archives
(arch_20260716_75797b9c…, …_0712135197…, …_5a90648c…, …_d029f1d6…) and
`mcp__canon__attribute_outcomes` over the whole 594-build corpus.

**Result — PARTIALLY. The join KEY exists and fires corpus-wide, but the single-build
violation→principle rewrite path currently produces ZERO promotable targets:**

- Violations DO carry populated `principle_id` values (`probe-before-build-invoke-not-infer`,
  `fail-closed-by-default`, `durable-record-accuracy`, `simplicity-first`,
  `leave-touched-files-better`, `input-length-bound`, …). The join key is real, not a stub.
- On all 4 recent archives, every principle-keyed violation landed in `unattributed[]` with
  reason `no_in_context_artifact` or `no_provenance` — the violated principle's file was NOT in
  the failing step's recorded provenance (or provenance was empty). `attributions: []` in every case.
- Corpus-wide, `attribute_outcomes` returns **50 principle-keyed scores** (meta:
  `attributions_positive: 37`, `attributions_negative: 187`, `builds_seen: 594`), with 7 principles
  at `net_score <= -3` and 2 at `>= +3`. So the join is alive and rich in AGGREGATE (the
  retire/reinforce `scores` mode, already shipped ADR-0052), but the SINGLE-BUILD violation path
  that the rewrite class depends on rarely has the violated principle in-context at the failing step.

**Implication:** AC#1 (rewrite path emits principle targets) is gated less by "does the join exist"
than by **Probe 3's confidence filter** — even when a single-build principle join fires, it is
confidence-capped below the selection threshold. See Probe 3.

---

## Probe 2 — Does the ADR-0025 full-plugin sandbox load `principles/**` into the eval harness?

**Method (two parts, both real):**
(a) invoked the shipped `withInjectedGuardrailCandidate(worktree, canaryBody,
"principles/conventions/zz-canary-probe.md", fn)` and listed what actually landed in the sandbox;
(b) ran a real `claude -p` inside that sandbox lifecycle with the EXACT `run-evals.sh` guardrail
flags (`--plugin-dir <tmpDir> --setting-sources project`, `--allowedTools "Read Grep Glob"`) and
asked it, tool-free, what plugin content is in its loaded context.

**Result — the sandbox COPIES `principles/**` but the eval session NEVER LOADS principle bodies:**

- (a) Sandbox roots after injection: `.claude-plugin, agents, primers, principles, references,
  rules, skills, templates`. `principles/conventions/` present with 26 files; the injected canary
  file present. **`.canon/` overlay was NOT copied** (`overlayCopied: false`) — as designed
  (PLUGIN_ARTIFACT_ROOTS excludes `.canon/`, ADR-0027).
- (b) The eval session answered: `CANARY_IN_CONTEXT=NO`, `PLUGIN_ROOT_PATH=NONE`,
  `PRINCIPLES_IN_CONTEXT=NO`. Principle markdown is on disk in the sandbox but is **not
  auto-injected into a `claude -p` session's context**, and the eval sessions carry no MCP tools
  (only `Read Grep Glob`) so they cannot pull a principle via `get_principles`.

**Implication (CENTRAL DESIGN FINDING):** Rewording a built-in principle changes a file the eval
session never reads, so it produces **zero holdout delta** on the current intent-classification eval
surface → `decideGate`'s strict `>` never accepts → the holdout gate is **semantically near-inert
for principle-wording**, exactly the same inertness already documented for ADR-0052 retirement
(memory `project_retirement_pipeline_two_bugs`). AC#3 can be satisfied MECHANICALLY (the gate runs;
regressions rejected; never averaged) but the gate cannot meaningfully DISCRIMINATE principle-wording
candidates without a principle-sensitive eval surface (out of scope; see DESIGN Open Question 1).
This is an honest, bounded gap, not a blocker — the PRD's AC#5 explicitly counts a REJECTED verdict
as proving the path.

---

## Probe 3 — Does `select_mutation_targets`' selection policy structurally exclude the review_violation→principle class?

**Method:** read the deterministic selection source
(`mcp-server/src/features/evolution/services/mutation-selection.ts` `filterAndPartition`) and the
confidence derivation (`attribution-join.ts` `deriveConfidence`).

**Result — YES, structurally excluded, by the confidence filter, NOT the gate-eligibility filter:**

- `filterAndPartition` drops any attribution with `confidence !== "high"`
  (`skipped[reason: "confidence_below_high"]`).
- `deriveConfidence` for a `join_basis: "principle_id==artifact_id"` join returns `"high"` ONLY
  when `!ambiguous && hasTranscript`; otherwise `"medium"`. But `getTranscriptExcerpt` is wired
  but returns `[]` in v1 (transcript evidence unpopulated — documented Known Constraint). So
  `hasTranscript` is **always false** → a principle_id==artifact_id join can never exceed `"medium"`
  → it is **always filtered out** before selection.
- Gate-eligibility is NOT the problem: `classifyArtifact("principles/…")` already returns
  `"principle"` and `isGateEligible`/`isGuardrailTarget` already admit built-in `principles/**`
  (probe: `isGuardrailTarget_builtin: true`). Overlay `.canon/principles/**` is a separate case
  (`isGuardrailTarget_overlay: false` — first segment `.canon` not in PLUGIN_ARTIFACT_ROOTS; also
  mis-classified as `"rule"` by the fallback). See DESIGN for both.

**Implication:** The design decision the PRD asked to surface (Open Question 2, sug-probe-3) is
**per-class selection relaxation vs. join-confidence improvement.** DESIGN recommends a narrow,
class-scoped relaxation in `filterAndPartition` (admit `medium` when
`join_basis === "principle_id==artifact_id"`) — this keeps the attribution's honest MEDIUM label
(the join is genuinely inferred/lossy per ADR-0024) while separately deciding that SELECTION admits
it. It does NOT touch `deriveConfidence` (which would silently up-rank the join for every consumer).

---

## Probe 4 — What `apply_channel` values do proposals record, and what does `/canon:review-learnings` do with them today?

**Method:** grepped every real + fixture proposal under `.canon/proposed-learnings/**` and read
`skills/canon/commands/review-learnings.md` end-to-end plus `shapeMutationProposal`.

**Result — the built-in principle apply channel ALREADY EXISTS; the genuine gap is the writer's
type-mapping and the overlay tier:**

- `shapeMutationProposal` already routes `artifact_class === "principle" || "rule"` (rewrite kind)
  → `apply_channel: "writer"`. Observed real values across the corpus: `writer`,
  `engineer-build-flow`, plus test-fixture values (`foobar` → Arm F, one stray `principles`).
- `/canon:review-learnings` already has a full apply consumer: **Writer arm** (writer channel +
  legacy), **Arm M** (primer/agent/template direct-write), **Arm T** (tool-description surface-only),
  **Arm F** (fail-safe), **Arm R/Arm N** (retire/reinforce). The Writer arm already spawns the
  writer in `apply-proposal` mode AND records apply-provenance (`record_applied_evolution` +
  producer commit + `backfill_applying_commit`) for `type: evolution-candidate`.
- **The real gap:** the writer's `apply-proposal` Mode (Step 2, `write-principle/SKILL.md:276`)
  maps only `new-principle | new-agent-rule | edit | prune-candidate→retire`. It does NOT recognize
  `type: evolution-candidate` + `proposal_kind: rewrite` (a full-file principle-body rewrite from the
  `## Proposed Change` block, frontmatter byte-preserved). The Writer arm hands such a proposal to a
  writer that has no mapped action for it. This is the concrete AC#4 build work for built-in principles.
- **Overlay apply:** no path writes an evolved `.canon/principles/**` file. `.canon/` is gitignored,
  so an overlay apply is a project-local write with NO producer commit / NO `record_applied_evolution`
  git-trailer step. This is new apply-path work (DESIGN Arm-writer overlay branch).

---

## Summary of what these findings change vs. the PRD's stated shape

| PRD assumption | Probe verdict | Design consequence |
|---|---|---|
| Selection excludes principle class (probe 3) | TRUE — via **confidence filter**, not gate-eligibility | Narrow class-scoped `filterAndPartition` relaxation (AC#1) |
| Sandbox already loads `principles/**` (probe 2) → AC#3 may be wiring | Sandbox COPIES but eval session never LOADS principles | Gate is mechanically wired but semantically inert; document honestly (AC#3 mechanical; AC#5 dry-run → expected REJECT) |
| `principle_id` join localizes on real corpus (probe 1) | Key exists; single-build path rarely in-context; aggregate rich | Rewrite path needs the confidence relaxation to fire at all |
| Apply-channel enrichment deferred (probe 4) | Writer/engineer arms ALREADY BUILT; gap is writer type-mapping + overlay | AC#4 = writer `apply-proposal` evolution-candidate mapping + overlay project-local branch |
