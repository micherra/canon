<!-- Persisted from .canon/history/fresh-architect-review-of-claude-code-workflow-tool — explore flow 2026-06-07; competition: 3 proposals, 3 judges, synthesis ratified at HITL -->
# JUDGE 1 — Feature Richness & User Value Lens

> Judge 1 of 3. Primary lens: **feature richness & user value** (dimension 1 weighted
> double in the ranking). Verified against `research/workflow-tool-spec.md` and
> `CAPABILITY-REVIEW.md`; proposals' self-assessments were NOT taken at face value.
> Scores are independent — no hedging toward a tie.

## 1. Scorecard

Dimensions: D1 Feature richness & user value (×2) · D2 Constraint compliance ·
D3 Shippability & migration realism · D4 Risk profile & rollback ·
D5 Canon-identity coherence · D6 Determinism & resume soundness.
Weighted total = 2×D1 + D2 + D3 + D4 + D5 + D6 (max 70).

| Proposal | D1 (×2) | D2 | D3 | D4 | D5 | D6 | **Weighted total** |
|---|---|---|---|---|---|---|---|
| **A — Determinism Maximalist** | 7 | 7 | 6 | 6 | 8 | 8 | **49** |
| **B — Leverage-per-Primitive Pragmatist** | 9 | 9 | 9 | 9 | 8.5 | 8 | **61.5** |
| **C — Workflow-Native Rethink** | 7 | 8.5 | 8 | 8 | 9 | 9 | **56.5** |

No proposal violates a hard limit from the constraint ledger (all three: pure-literal
`meta`, no clock/randomness, no fs/MCP from script, `isolation:'worktree'` banned,
count-based bounds, null-policy specified, `budget.total &&` guards). No score cap
applies. Gate-catalog fidelity issues found (below) are Canon-protocol concerns, not
tool hard-limit violations.

---

## 2. Per-proposal assessment

### Proposal A — Determinism Maximalist

**D1 = 7 (Feature richness & user value).** A's inventory is large (F1–F13) but is
overwhelmingly *re-plumbing*: the same builds, executed more reliably. The user-felt
novelties reduce to three — background `/workflows` UX, prefix-cached resume (the
demo's genuine money moment), and structurally-unforgettable renderer/tail. Those are
real, but every one of them is also delivered by C, and B delivers the resume/background
value on its flagship regions too. Nothing in A gives a Canon user an *analysis
capability* they lack today — no adversarial verification of all findings, no
convergent sweeps, no judge panels, no security harness. For a competition whose
sponsoring user asked for the most feature-rich integration, A optimizes the wrong
axis: it maximizes determinism per feature, not features per build.

**D2 = 7 (Constraint compliance).** All 6 HCs are addressed and the A1/A2 probes with
degradation paths are sound. Two real dings. (1) **Gate erosion in the review-fix
loop**: §3.5 claims "the review-fix loop fits inside one segment even under supervised,
because the catalog's checkpoints are per major step, not per iteration" — and the
killer demo confirms it: a BLOCKING(2) verdict is computed in code, a fix iteration
runs, and the user is shown only the post-fix WARNING. CLAUDE.md's tier table makes the
*initial* review verdict mandatory at ALL tiers ("the highest-value checkpoints where
wrong assumptions are caught"), and CLEAN-after-fix auto-proceed is an autonomous-tier
privilege only. A auto-fixes before the user ever sees the verdict. That is a mandatory
gate being functionally swallowed, on a light-touch build, by design. (2) The
soft-gate story leans on re-invoking with changed `args.hitl_answers` *plus*
`resumeFromRunId`; the spec documents resume as `{scriptPath, resumeFromRunId}` and is
silent on changing args at resume. The forward-only-answers reasoning (pre-gate prompts
byte-identical → prefix holds) is probably right per the (prompt, opts) matching rule,
but it is the least-verified mechanism any proposal depends on.

**D3 = 6 (Shippability).** Increments 0–2 are sound, but the full transpiler arrives at
Increment 3 — before the DAG substrate (Increment 4) is proven — and the largest
engineering items (F1 runner+IR+compiler: L; F4: M; F2: M) stack early. Compiling the
supervised tier (Increment 5) is admitted to degenerate toward one-step-per-segment:
maximum machinery, minimum payoff.

**D4 = 6 (Risk & rollback).** The interpretive fallback is retained (good, and doubles
as the no-consent path), but compiler+runner are load-bearing from Increment 3 onward
and harness-evolution risk concentrates in a single component. The honest residual-risk
list is to its credit.

**D5 = 8 (Canon identity).** Strong: mandatory gates as compiler *invariants*
(`compile_runbook` refuses to emit a plan that doesn't segment at both) is the best
single identity idea in the field; F11 provenance audit strengthens auditability beyond
today's warn-only trailer hook; worktree discipline and journal doctrine preserved. The
review-fix gate erosion (D2) is the one identity wound.

**D6 = 8 (Determinism & resume).** Forward-only answers, the enrichment freezer
(file-path indirection keeps args small AND prompts byte-stable), scout-node pattern —
all sound. Docked one point for the args-change-at-resume ambiguity above.

**Fatal flaw (strongest rival attack):** *"Your entire feature inventory is
re-plumbing — F1 through F13 give a Canon user zero capabilities they don't already
have; they give them the same build with fewer drift bugs — and to get it you swallow
the one gate Canon calls its highest-value checkpoint: under your own demo, the user
never sees the BLOCKING verdict before the fix runs."* The combination is lethal in
this competition: the biggest engineering bet in the field, the least user-visible new
capability, and the only architectural erosion of a mandatory gate.

### Proposal B — Leverage-per-Primitive Pragmatist

**D1 = 9 (Feature richness & user value).** The clear winner on the primary lens.
B's portfolio is dominated by *net-new capabilities a user would actually feel*:
- **100% adversarial verification of every review finding** (F2) vs today's top-5
  minority-probe cap — verified against CLAUDE.md's Team Dispatch Protocol; the
  upgrade claim is accurate, and the demo's "all 9 findings, 3 refuters each, 3
  majority-refuted false positives killed" is a quality jump no current Canon mechanism
  can produce.
- **Loop-until-dry multi-modal sweeps** (F3) directly targeting a *known, named* defect
  (watch_WWWWWW1 sweep under-detection) with the spec's own convergence pattern.
- **Judge-panel competitions as one call** (F5) — automating exactly the manual
  ceremony that produced these proposals; self-demonstrating value.
- **Security audits as multi-stage harnesses** (F6), **N-skeptic re-review** (F8),
  **pre-scored learner mining** (F9), **user-invocable diagnostics** (F11 — which also
  opens the named-invocation opt-in channel).
- The schema library (F1) is the same Tier-2 typed-status win A and C claim, shipped
  standalone in Increment 1 with value even if no workflow ever runs.
Docked one point because B's richness has a coverage hole: the ordinary multi-task
implement step is untouched (see fatal flaw), and background/resume value accrues only
to library-backed regions.

**D2 = 9 (Constraint compliance).** The cleanest in the field. Every workflow is
authored to fit one inter-gate region; no gate is moved, removed, or softened — B is
the *only* proposal that explicitly keeps the verdict gate inside the fix loop and
names folding the loop as an HC-2 violation. Null-policy table is the most carefully
reasoned (refuter null → abstain, never silently counts as refuted or confirmed —
correct treatment of the `/workflows` skip semantics). A1/A2 probe gates exactly the
features that need it; read-only majority proceeds regardless. Args envelope satisfies
HC-5; CI lint bans `isolation:` and banned APIs.

**D3 = 9 (Shippability).** Eight increments, no increment depends on a later one,
no compiler, no IR, rollback = delete one runbook field mapping. Effort estimates
(mostly S/M, one L) are credible because each script is choreography-only. The
before/after probe table commitment in Increment 3 honors the empirical-comparison
discipline.

**D4 = 9 (Risk & rollback).** Smallest blast radius by construction: thin scripts,
opt-out by omission, nothing here can fail in a way that takes Canon down. Harness
evolution hits a library of small files, not an engine.

**D5 = 8.5 (Canon identity).** All gates, worktree discipline, artifact shapes, and
journal doctrine survive bit-identical; consolidator nodes write through existing MCP
tools. Docked half a point because the identity-threatening *drift class* (manual
journal choreography, prose merge protocol on regular DAG builds, forgettable
obligations) persists everywhere the library doesn't reach — B protects identity by
not touching it rather than by hardening it.

**D6 = 8 (Determinism & resume).** Static script text is the strongest possible
prefix-cache posture (script never varies per build), and the frozen envelope + scout
nodes are correct. Not higher because resume value is bounded by workflow size (small
regions = small replays) and B's journal story deliberately stays coarse — the
intra-run grain lives only in the harness journal.

**Fatal flaw (strongest rival attack):** *"You left the patient's actual disease
untreated: the bread-and-butter multi-task implement step still runs on an
experimental, env-gated TeamCreate substrate whose wave tooling was deleted in PR #167
— F7 covers only the migration build class — and the journal choreography, merge
protocol, and skip-reason discipline on every ordinary build remain L1 prose executed
by the least reliable component in the stack. The drift catalog that motivated this
entire competition survives your proposal intact outside eight scripts."* This is
true, and B's only defense is sequencing ("the transpiler remains open as a later
consumer of the same library") — a deferral, not an answer.

### Proposal C — Workflow-Native Rethink

**D1 = 7 (Feature richness & user value).** C's user-felt value is A's (background
builds, instant resume, always-rendered HTML, phase names mirroring runbook step IDs —
a nice observability touch) plus a thin pattern-adoption feature (F13) that gestures at
B's portfolio without delivering it: no sweep workflow, no compete workflow, no
security harness, no learner mining. The 19-mechanism survives/replaced table is
superb *analysis* but analysis is not a user feature. On the primary lens, C is a more
disciplined A, not a richer one. Its own rival-criticism #3 concedes the point: the
flagship machinery targets the autonomous tier, which has the least usage today —
meaning the mode most users live in (supervised) receives only the per-step
mechanisms, i.e., roughly B's increments 1–3 worth of value.

**D2 = 8.5 (Constraint compliance).** The most rigorously argued overall: both A1 AND
A2 contingency branches, `runner_min_version` handshake, the debate-stays-on-teams
exception (SendMessage need — the sharpest substrate observation in the field), the
supervised carve-out honestly conceding where compilation adds nothing, and the
cleanest HC-2 treatment (HAS_QUESTIONS as a first-class early-return status). Docked
half a point for one tier-table error: M3 compiles the fix loop "for
autonomous/light-touch" and the demo asserts "Light-touch: CLEAN-after-fix
auto-proceeds" — per CLAUDE.md, CLEAN-after-fix auto-proceed is autonomous-only;
light-touch keeps all gates except build-step checkpoints. Unlike A's erosion this sits
*after* the mandatory initial verdict gate (which C's demo correctly presents before
any fix), so it is a scoping error, not an architectural one — but it would ship a
swallowed gate at light-touch as written.

**D3 = 8 (Shippability).** The best-sequenced of the two compiler proposals:
M0–M4 are essentially B-shaped independent increments (probe, tail, review, fix-loop,
waves), the compiler is deferred to M5 *after* the special-purpose workflows exist to
become its golden-test fixtures — an elegant de-risking A lacks. Docked because M5–M6
remain a large bet whose payoff concentrates in the least-used tier.

**D4 = 8 (Risk & rollback).** Per-build fallback to today's path, probe as a standing
regression canary (re-runnable after every harness upgrade — better than A's and B's
one-shot probes), compiler correctness mitigated by golden fixtures. Residual risks
are owned explicitly, including "A1 failure would gut L4 inside workflows."

**D5 = 9 (Canon identity).** The strongest identity document in the field. The
S1–S19 verdict table proves the design was derived *from* Canon's identity rather than
imposed on it: gate catalog as the segmentation function (load-bearing, not an
obstacle), worktree invariant inviolate, journal doctrine preserved with the write race
dissolved by construction, learner structurally unskippable, tier promoted to compiler
input. C is what A wanted to be, identity-wise.

**D6 = 9 (Determinism & resume).** The cleanest reasoning in the field: gate answers
parameterize the *next* segment's args and never touch a resumable run —
`resumeFromRunId` is reserved exclusively for unchanged-plan/unchanged-args failure
recovery, guaranteeing the 100% prefix-hit case and making cache-invalidation rules
trivial. The compiler additionally enforces that prompts are pure functions of (plan,
scout results, prior node results). No other proposal closes the loop this tightly.

**Fatal flaw (strongest rival attack):** *"Your end-state serves a user who barely
exists: the compiler, the runner, the whole-build segments — M5 and M6, the 'rethink
proper' — apply only where gates don't fire, and you yourself carve supervised (the
dominant, flagship mode) out of segmentation. Strip the deferred bet and your shipped
reality for the first five increments is Proposal B with fewer features: same tail,
same review workflow, same waves — minus the sweeps, the judge panels, the security
harness, and the diagnostics a user would actually notice."*

---

## 3. Verdict — ranked order

**1. B (61.5) — 2. C (56.5) — 3. A (49).**

Under the primary lens this is not close. B is the only proposal whose feature
inventory is dominated by capabilities Canon cannot express today — exhaustive
adversarial finding verification, convergent multi-modal sweeps aimed at a named open
defect, one-call judge panels, security harnesses, user-invocable diagnostics — and it
delivers them with the field's best constraint compliance (the only proposal that
correctly keeps the verdict gate inside the fix loop), the best shippability (no
compiler, every increment independent, rollback by omission), and the smallest blast
radius. C is the better *architecture document* — its determinism reasoning, identity
analysis, and migration sequencing are the strongest in the field — but its genuinely
new user value is thin and concentrated in the least-used tier; it earns second on
soundness, not richness. A finishes third: it makes the largest engineering bet for
the least user-visible novelty, sequences its riskiest component earliest, and is the
only proposal that architecturally erodes a mandatory gate (auto-fixing before the user
sees the initial review verdict). The right reading of the field: ship B's portfolio,
and let C's runner+compiler remain the documented later consumer of the same library —
which B itself explicitly leaves open.

## 4. Graft candidates (best ideas from non-winners worth merging into B)

1. **C/A's single-writer journal ingestion (`ingest_workflow_run` / `ingest_segment_trace`).**
   Upgrade B's coarse `node_log`-in-outcome mapping to notification-time expansion of
   the structured return into per-step journal entries with `runId` cross-references.
   B currently *sidesteps* the journal write race; this *dissolves* it in workflow
   regions, plus moves artifact-presence checks into one deterministic place.
2. **C's resume/gate separation rule.** Adopt as a library authoring law: gate answers
   may only parameterize the next invocation's args; `resumeFromRunId` is reserved for
   unchanged-args failure recovery. Costs nothing, eliminates B's only residual
   cache-invalidation ambiguity.
3. **A's post-run provenance audit (F11).** Ingest-time verification that commit
   trailers are present, declared artifacts exist, and committed paths ⊆ declared file
   lists — the deterministic compensator if the A1 probe comes back false, and a
   strict upgrade over the warn-only trailer hook even if it comes back true.
4. **C's probe-as-standing-canary.** Make B's Increment-0 probe a saved, re-runnable
   `canon-probe` workflow executed after every harness upgrade, not a one-shot —
   harness-evolution is B's own top residual risk and this is its cheapest detector.
5. **A's enrichment freezer file-indirection.** When preloads/context snapshots are
   large, write them to immutable per-invocation files under
   `${WORKSPACE}/.../env/` and pass *paths* in the args envelope — keeps args small,
   keeps prompts byte-stable, and hedges the unspecified args-size ceiling A flagged.
6. **C's version handshake.** Add an `envelope_version` to B's standard args envelope
   and a first-line compatibility check in each library script, returning a structured
   `INCOMPATIBLE_ARGS` — prevents silent skew between plugin-shipped scripts and an
   orchestrator composing envelopes from a different Canon version.

## 5. Convergence / divergence observations

**Independent convergence (strong signal — treat as settled):**
- **Never execute model-generated code**: all three independently mandate hand-written,
  versioned, code-reviewed scripts with per-build variation as data (`args`/IR).
  Unanimous → this should be a non-negotiable in the synthesized design.
- **HC-1 resolution is identical in all three**: never use the `isolation:'worktree'`
  flag; agent-managed `canon-task/{id}` worktrees per worker-prompt pattern; a dedicated
  merge-agent node running the existing alphabetical `--no-ff` protocol; conflicts
  early-return to the existing merge-conflict HITL.
- **Three-channel opt-in stack** (skill instruction + plan-approval consent line +
  named invocation) appears nearly word-identically in all three — HC-4 is solved.
- **Schema-validated status/findings/verdict contracts as the single
  highest-leverage feature** — all three rank it Very High and all three note it ships
  standalone value (the typed-status epic item) even without workflows.
- **`canon-tail` as the first live workflow** — unanimous choice of lowest-risk,
  most-rigid region; also unanimous that it complements (not replaces) the X4 Stop-hook.
- **Count-based bounds replacing the cascade's 2-minute wall clock**, **A1/A2 settled
  by an Increment-0/M0 empirical probe**, and **notification-time single-writer
  journal writes** (A, C explicit; B coarse variant) — all convergent.
- **TeamCreate demotion**: A and C replace it outright; B replaces it for the migration
  class and leaves the door open — all three treat the experimental teams dependency as
  a liability, with the SendMessage-needing `debate` step as the lone survivor (C's
  observation, consistent with B's compete/debate carve-out).

**Genuine divergence (the real decisions for synthesis):**
- **Compiler/IR vs static library** — A and C bet on runner+IR; B refuses it for this
  horizon. The judge-panel structure of this competition exists to resolve exactly this
  split; my lens resolves it toward B-now, C-shaped-later.
- **Fix-loop placement** — A folds the whole review→fix loop pre-gate (eroding the
  mandatory initial verdict); C compiles it post-verdict for lower tiers (with one
  tier-table error); B keeps it orchestrator-driven. Three different answers to the
  same gate is a flag for the synthesis agent: the HITL catalog's per-iteration verdict
  semantics need to be stated explicitly in whatever ships.
- **Supervised tier** — A compiles it anyway (machinery without payoff), C carves it
  out (honest), B ignores the question (its features are tier-agnostic). B's framing
  wins by dissolving the problem rather than answering it.
- **Ambition of journal integration** — full per-step trace projection (A) vs
  runId-cross-referenced coarse grain (B) vs per-step ingestion with reconcile
  integration (C). Graft #1 resolves this: B's invocation model with C's ingestion
  depth.

---

### Status

DONE

**Artifact**: `${WORKSPACE}/plans/fresh-architect-review-of-claude-code-workflow-tool/JUDGE-richness.md`

**Summary**: Ranked B (61.5) > C (56.5) > A (49) under a double-weighted feature-richness
lens. B wins on genuinely new user-felt capabilities (exhaustive adversarial review
verification, convergent sweeps, judge panels, security harness, diagnostics) plus the
field's best compliance and shippability; C is the soundest architecture (best
determinism/identity reasoning) but thin on new features; A makes the largest bet for
the least novelty and architecturally erodes the mandatory initial review-verdict gate
(auto-fix before verdict presentation — verified against CLAUDE.md's tier table). Six
graft candidates identified; unanimous convergence points (no generated code, HC-1/HC-4
resolutions, schema contracts, canon-tail first, count-based bounds, A1/A2 probes)
flagged as settled for synthesis.
