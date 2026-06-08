<!-- Persisted from .canon/history/fresh-architect-review-of-claude-code-workflow-tool — explore flow 2026-06-07; competition: 3 proposals, 3 judges, synthesis ratified at HITL -->
# JUDGE 2 of 3 — Shippability, Risk & Engineering Realism Lens

> Judge 2 scorecard. Primary lens: dimensions 3 (Shippability & migration realism) and
> 4 (Risk profile & rollback) are weighted double in the ranking. Spot-checks performed
> against the live mcp-server codebase (see §Verification notes). Scored independently;
> no hedging toward a tie.

## 1. Scorecard

Weighted total = (D1 + D2 + 2×D3 + 2×D4 + D5 + D6) / 8.

| Dimension | A — Determinism Maximalist | B — Leverage Pragmatist | C — Workflow-Native Rethink |
|---|---|---|---|
| 1. Feature richness & user value | 9 | 8 | 9 |
| 2. Constraint compliance | 8 | 9 | 9 |
| 3. Shippability & migration realism (×2) | 6 | 9 | 8 |
| 4. Risk profile & rollback (×2) | 6 | 9 | 8 |
| 5. Canon-identity coherence | 9 | 9 | 9 |
| 6. Determinism & resume soundness | 9 | 8 | 9 |
| **Weighted total** | **7.38** | **8.75** | **8.50** |

No proposal violates a hard limit; the cap-at-5 rule fires for none of them. All three
correctly avoid `isolation:'worktree'`, place every gate at workflow boundaries, ban
clock/randomness, keep journal writes harness-tool-only, and carry concrete A1/A2 probes.

## Verification notes (spot-checks against the repo)

- `mcp-server/src/features/orchestration/tools/` contains `write-review.ts` (483 lines),
  `write-test-report.ts`, `write-implementation-summary.ts`, `write-plan-index.ts`,
  `orchestration-journal.ts` (645 lines, `log_step`/`batch_log_steps`), and
  `reconcile-workspace.ts` — B's consolidator-node claim ("agents call existing MCP
  write tools") and F12 claim ("`log_step` outcome gains `workflow_run_id`") check out
  as small additive changes to existing surfaces.
- `mcp-server/src/shared/lib/dag-validator.ts` exists (225 lines, pure validator) —
  A's `validateWorkflowPlan` and C's `validateSegmentPlan` "extends the lineage" claims
  are honest: it is a sibling-pattern, not a literal extension; new validators are new
  code of comparable or larger size.
- A's `ingest_segment_trace` and C's `ingest_workflow_run` are NEW tools that must
  expand a workflow trace into per-vocabulary-step journal entries — synthesizing
  fields that today come from real spawns (agent_id, artifacts_actual, timestamps).
  Real but moderate work; both proposals' S–M labels for it are plausible, A's "M" for
  the full projection grain is on the light side.
- No `workflows/` directory exists anywhere in the repo or plugin tree — all three
  proposals create the distribution path from scratch (plugin install → `.claude/workflows/`).
  All three correctly flag verifying name-resolution in their Increment-0/M0 probes.
- `mcp-server/src/shared/schema/` exists — C's proposed schema-library home (M0) is real.

---

## 2. Per-proposal justifications and fatal flaws

### Proposal A — Determinism Maximalist (7.38)

**D1 = 9.** Deepest transformation on offer: full runbook compilation including the
supervised tier, DAG scheduling on Workflow with per-task ready-set dispatch (finer
than waves), trace-projected journaling, structural renderer/tail, resume-first
recovery, plus diagnostics (F12). The end state is the most feature-complete of the
three.

**D2 = 8.** All six HCs are resolved credibly and the constraint ledger is visibly
respected in the runner excerpt (no clock, `budget.total &&` guards, no-silent-caps,
null-policy everywhere). Two soft dings: the unspecified args-size ceiling is an
acknowledged assumption that the whole IR-in-args shape leans on (mitigated by env-path
indirection, but the IR itself still rides in `args`), and the `hitl_answers`
forward-only rule depends on template discipline that only the compiler can enforce —
a correctness obligation A names but does not show machinery for.

**D3 = 6 (primary).** This is where A loses the competition under my lens. Increment 1
("W4 tail segment, no compiler yet") claims to be a cheap PoC but runs "through the
real `canon-segment-runner`" with "`ingest_segment_trace` v0" — i.e., Increment 1
already requires the two largest novel artifacts (a working IR interpreter and the
journal-projection tool) plus the IR schema and the env-freezer conventions. The
"increment 1 secretly requires increment 3/5 infrastructure" pattern is exactly the
failure mode this lens penalizes. Second: A deliberately compiles the supervised tier
("we compile it anyway"), which the prior-art epic deferred for sound arithmetic
reasons — one-step-per-segment compilation multiplies compiler/test surface for
marginal gain and drags the highest-gate-density tier into the first-generation
compiler's blast radius. Third: effort labels are light — `compile_runbook` over the
full 17-step closed vocabulary with G8 tier segmentation, validation, and golden
behavior is a compiler project, labeled "L" once and never decomposed.

**D4 = 6 (primary).** The rollback story (interpretive path never deleted; one-line
routing revert) is genuinely good, and the runner being unit-testable in Node with a
mocked `agent()` is a real risk reducer. But the blast radius is the largest of the
three: the build record pipeline (journal projection), the dispatch substrate, the
review algorithm, escalation, and the tail all change ownership in one architecture;
a compiler defect misroutes builds deterministically; and the largest single
investment in the field (compiler + runner + ingest) is coupled to the newest, least
battle-tested harness primitive. A's own honesty ("assumes the Workflow tool remains
non-experimental... load-bearing... stated as a risk") concedes the point. If the
harness's Workflow surface shifts in year one, A strands the most capital.

**D5 = 9.** Identity survives well — arguably strengthened: gates preserved at every
tier, three-channel consent, provenance audit (F11) turning warn-only trailer checks
deterministic, worktree custody intact, skip reasons validated at write time.

**D6 = 9.** The strongest determinism engineering in the field: byte-stable runner
script maximizes prefix reuse across all builds; env snapshots referenced by *path*
keep `args` compact and cache-stable; forward-only gate answers; scout nodes for live
state. The PAUSED_BUDGET early-return before mid-loop throws is a nice touch.

**Fatal flaw (strongest rival attack):** *"Your migration is a cliff dressed as a
ramp."* Increment 1 requires the real runner, the IR schema, and the ingest tool;
Increment 3 requires a compiler over the entire 17-step vocabulary; and you chose to
compile the supervised tier against prior-art advice. Nothing in A's plan is cheaply
de-riskable in the way it claims — the first independently valuable artifact already
sits on top of the architecture's three biggest bets, so "rollback at every increment"
really means "rollback after paying most of the cost."

### Proposal B — Leverage-per-Primitive Pragmatist (8.75)

**D1 = 8.** Broadest *pattern* coverage of the three — adversarial review verification
at 100% finding coverage (vs today's top-5 cap), loop-until-dry sweeps targeting a
known under-detection watch, security-audit harness, judge-panel competition backend,
learner mining, user-invocable diagnostics — but it deliberately leaves the deepest
prize (compiled inter-gate execution, whole-build background, supervised chattiness)
on the table. For a sponsor who asked for "most feature-rich," B's features are more
numerous but shallower; the orchestration core remains prose-interpreted outside
workflow regions.

**D2 = 9.** Cleanest compliance posture in the field: every HC resolved *within
existing Canon doctrine* with no doctrine changes at all; coarse-grain journal mapping
sidesteps the write-race rather than re-engineering around it; CI lint mechanically
bans `isolation:` and clock APIs in the library; the fix loop is correctly kept
orchestrator-driven because the verdict gate sits inside it (the most precise HC-2
reading of the three).

**D3 = 9 (primary).** The migration path is the most realistic on offer and survives
contact with the codebase as it exists today. Spot-checks confirm every claimed
extension point: consolidator nodes call existing `write_review`/`write_test_report`
tools; F12 is an additive `outcome` field on an existing `log_step` path; the schema
library (Increment 1) delivers standalone value with zero workflow dependency — it is
an already-decided Tier-2 epic item. Increments are genuinely independent ("no
increment depends on a later one"), sequenced so the first three are safe even if A1
is false, and the riskiest item (F7 migrate, the only parallel code-writer) is
explicitly gated on the probe AND on merge-agent validation from Increment 2. Effort
labels (mostly S/M, one L) are credible for hand-written ~100–300-line scripts.

**D4 = 9 (primary).** Smallest blast radius achievable while still shipping real
capability: no protocol restructure, no new engine, no state migration; rollback is
"delete the `engine: workflow:<name>` field" per step; killing any one feature leaves
the rest standing; harness-evolution exposure is spread across thin scripts rather
than concentrated in a compiler. The null-policy table (§3.4) is the most carefully
specified failure semantics of the three — refuter abstention never silently counting
as refuted is exactly the kind of detail that prevents production surprises.

**D5 = 9.** Nothing about Canon's identity moves: gates, worktrees, journal doctrine,
artifact shapes, renderer ceremony all bit-identical; consent is per-build, revocable,
and free. The one soft spot is that enforcement *outside* workflow regions stays
behavioral — B preserves identity partly by preserving today's drift exposure.

**D6 = 8.** Static scripts + frozen args envelope is sound, and per-script CI lint
guards the determinism ban. Two leaks: (1) in the flagship `canon-review-verify`,
dedup and verdict computation are delegated to the consolidator *agent's prompt*
("dedup by file+principle_id+line; verdict = worst severity") rather than computed in
script code — the verdict that drives a mandatory gate re-acquires an LLM in its
critical path, which A and C both eliminate; (2) discipline must be maintained
independently across 8+ scripts rather than enforced once in a compiler.

**Fatal flaw (strongest rival attack):** *"You rebuilt the L1 problem one layer up."*
The portfolio only runs when an architect remembers to write `engine: workflow:*` on a
runbook step and the orchestrator honors it — adoption is exactly the kind of
behavioral, prose-mediated obligation whose drift (forgotten renderers, skipped steps)
motivated this whole initiative. Outside opted-in regions, every current drift class
survives untouched, and B's own flagship leaves verdict computation to a narrated
prompt. B is the easiest proposal to ship and the easiest to quietly stop using.

### Proposal C — Workflow-Native Rethink (8.50)

**D1 = 9.** Reaches essentially A's end state (runner + compiled SegmentPlans +
segment-at-gates + waves on `parallel()` + schema contracts + background builds) plus
B-style pattern adoption (F13) and diagnostics, while making the most explicit
identity audit in the field (the S1–S19 survives/replaced table). Declining
supervised-tier compilation trims ambition slightly but defensibly.

**D2 = 9.** All HCs resolved with the most thorough treatment of the unknowns: the
A1/A2 probe is a *re-runnable saved workflow* (standing regression canary, not a
one-shot) with concrete contingency branches for both failure outcomes — the best
answer in the field to constraint 14. The freeze-or-scout rule with compiler-enforced
prompt purity ("prompts are pure functions of plan, scout results, prior node
results") is the cleanest HC-5 statement. The `workflow()`-nesting rejection (1-level
cap makes nested waves a dead end) shows the limits were actually read.

**D3 = 8 (primary).** C's staging is the smartest structural move in the competition:
M0–M4 are effectively B's portfolio (probe, schemas, tail, review, fix-loop, waves as
special-purpose hand-written workflows), each evidence-gated ("3 green tail runs,"
"REVIEW.md parity on real builds," "multi-task DAG merged clean"), and the
compiler+runner only arrive at M5 with M1–M4 as golden-test fixtures. That defers the
big bet until the cheap increments have paid for themselves. Two realism dings: the
"<400-line runner" estimate is optimistic for six node kinds plus bounded-loop
grammar, budget guards, and telemetry hardening; and M5 is quietly a *rewrite* — the
M1–M4 special-purpose scripts are shaped differently from IR-interpreting runner
nodes, so "unify into compiler outputs" is new construction plus parity testing, not
refactoring, and its M–L/L labels carry the same compiler-project under-decomposition
as A's.

**D4 = 8 (primary).** Strong: per-increment rollback to the documented
orchestrator-conducted equivalent; probe-as-canary explicitly re-run after harness
upgrades; supervised tier kept off the compiler until hook parity exists; TeamCreate
withdrawal treated as an expected event. The residual concentration risk is the same
as A's — compiler correctness becomes load-bearing at M5/M6 — but C both names it and
fences it (schema validation, golden fixtures, shape-agnosticity lint, gates/review
still downstream). One unpriced risk: if M5 stalls, Canon permanently maintains a
B-style portfolio *plus* an unfinished compiler promise — though that resting state is
honestly not a bad place to be.

**D5 = 9.** The survives/replaced verdict table over all 19 mechanisms is the best
identity-coherence artifact any team produced; "debate stays on teams because workflow
agents lack SendMessage channels" is a correct, easily-missed boundary; doctrine
preserved exactly.

**D6 = 9.** Cleanest resume model in the field: gate answers parameterize the *next*
segment's args while `resumeFromRunId` is reserved exclusively for unchanged-args
intra-segment failure — "the two mechanisms never interact" makes cache-invalidation
reasoning trivial. The `ir_version`/`runner_min_version` handshake is the only
version-skew answer any proposal gave.

**Fatal flaw (strongest rival attack):** *"M5 is a rewrite wearing a refactor's
clothes."* The convergence step — turning four differently-shaped special-purpose
workflows into a generic IR interpreter plus compiler — is where C's real cost and
risk concentrate, its effort is under-decomposed, and the runner line-count estimate
is wishful. Everything before M5 is just Proposal B with extra steps; everything after
M5 is just Proposal A with better fixtures. C must defend why the convergence will
actually happen rather than stalling at the comfortable B-shaped plateau.

---

## 3. Verdict

**Ranking: B > C > A.**

Under a shippability-and-risk lens, B wins because it is the only proposal whose every
increment was verifiable against the codebase as it exists today, whose first three
increments are safe under the worst-case A1 outcome, whose rollback is a one-field
deletion, and whose failure modes are partitioned (any feature can die alone). C runs
a close second — its M0–M4 staging is effectively B's portfolio with better evidence
gates, and it converts to the superior end state only after the cheap increments have
proven the substrate — but its weighted score is dragged by the under-priced M5
convergence rewrite and an optimistic runner estimate. A, despite the best determinism
engineering and the most complete end state, front-loads its three biggest artifacts
into "Increment 1," extends the compiler to the supervised tier against prior-art
arithmetic, and concentrates the field's largest capital outlay on the newest harness
primitive — the migration path most likely to crack on contact with reality. Notably,
B and C are not really rivals: C's early increments *are* B; the panel's synthesis
should treat "B now, C's M5 as a later evidence-gated option" as the natural composite.

## 4. Graft candidates (best ideas from non-winning proposals to merge into B)

1. **A's F11 post-segment provenance audit** — deterministic notification-time checks
   (trailers present, artifacts exist, committed paths ⊆ declared file lists). Cheap,
   compensates the A1-false world, and turns today's warn-only trailer hook into a
   hard check for workflow-backed steps.
2. **A's env-snapshot path indirection** — replace B's verbatim preloads-in-args with
   immutable per-invocation snapshot files referenced by path: smaller args, stronger
   cache stability, identical agent-side reads.
3. **In-script verdict/dedup computation (A's F5 / C's F5)** — fix B's one determinism
   leak: compute dedup and worst-case verdict as literal JS in `canon-review-verify`;
   the consolidator agent only writes REVIEW.md from computed inputs.
4. **C's runId-aware `reconcile_workspace` path** — cliff entries for workflow-backed
   steps carry the runId and surface "resume run" as the first HITL disposition;
   concrete and more specified than B's F12 sketch.
5. **C's version handshake** — an `args_version` check at the top of every library
   workflow returning a structured `INCOMPATIBLE_ARGS` instead of misbehaving on skew.
6. **C's evidence-gated increment criteria** — adopt explicit promotion gates ("3
   green tail runs with clean journals," "REVIEW.md parity vs current protocol")
   between B's increments instead of calendar-style sequencing.

## 5. Convergence / divergence observations

**Independent convergence (strong signal — treat as panel-consensus facts):**

- **Static hand-written scripts + per-build variation as `args` data; zero
  model-generated code.** All three reject generated scripts for the same reasons
  (trust, cache thrash, review burden). This is settled.
- **HC-1 resolution is unanimous**: never use the `isolation` flag; worker-prompt
  agent-managed `canon-task/{id}` worktrees; dedicated merge-agent node running the
  existing alphabetical `--no-ff` protocol; conflicts early-return to the existing
  merge-conflict HITL.
- **HC-4 resolution is unanimous and near-verbatim identical**: skill-instruction
  channel + plan-approval gate doubling as explicit per-build consent + named-workflow
  invocation. Settled.
- **HC-5 resolution is unanimous**: freeze enrichment at invocation + scout-node
  pattern for live state (cached scout result reproduces downstream prompts on resume).
- **Single-writer journal at notification time; agents never touch journal.json**;
  count-based bounds replacing the cascade's wall-clock timeout; tail-as-an-early-live
  workflow; probe-first sequencing for A1/A2; demoting/replacing the experimental
  TeamCreate substrate for deterministic fan-out while keeping teams for
  debate/inter-agent messaging. All three, independently.

**Material divergence (the actual decisions the synthesis must make):**

- **Compiler/IR commitment**: A builds it first and compiles everything including
  supervised; C builds it last, evidence-gated, excluding supervised; B never builds
  it (but leaves the door open — library workflows as future `workflow()` children of
  a runner). This is the central axis; my lens orders the postures B > C > A.
- **Journal grain**: A and C expand workflow traces into per-vocabulary-step journal
  entries via a new ingest tool (richer record, more new code, must synthesize spawn
  fields); B logs one step per invocation with a `node_log` array in `outcome`
  (additive, no new write path). Cheap-now vs richer-later.
- **Supervised tier**: A compiles it; C explicitly keeps it orchestrator-driven; B
  declares its gate density a user-chosen property, not a defect. C/B agree against A.
- **Breadth vs depth of pattern adoption**: B uniquely covers sweep/security/compete/
  learner-mining harnesses; A/C concentrate on the build-execution spine. The grafts
  are compatible — pattern breadth is orthogonal to spine compilation.

---

### Status

DONE

**Artifact**: `${WORKSPACE}/plans/fresh-architect-review-of-claude-code-workflow-tool/JUDGE-shippability.md`

**Summary**: Judge 2 (shippability/risk lens, D3+D4 double-weighted) scores B 8.75 >
C 8.50 > A 7.38. No hard-limit violations anywhere; all six HC resolutions credible in
all three. B wins on verified extension points, independent increments, A1-false-safe
sequencing, and one-field rollback; C is a close second whose M0–M4 staging is B's
portfolio with better evidence gates but whose M5 compiler convergence is an
under-priced rewrite; A's migration front-loads its three largest artifacts into
"Increment 1" and extends compilation to the supervised tier against prior-art
arithmetic. Six graft candidates identified; convergence on script-as-static/args-as-
data, HC-1/HC-4/HC-5 resolutions, and single-writer journaling is unanimous and should
be treated as settled by the synthesis agent.
