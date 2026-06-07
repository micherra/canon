<!-- Persisted from .canon/history/fresh-architect-review-of-claude-code-workflow-tool — explore flow 2026-06-07; competition: 3 proposals, 3 judges, synthesis ratified at HITL -->
# JUDGE 3 — Canon-Identity Coherence & Long-Term Architecture Lens

> Judge 3 of 3. Primary lens: does Canon remain Canon — principles enforced, HITL gates
> meaningful, every action auditable, worktree lifecycle controlled, no second source of
> truth, no recreated dead wires? Dimensions 5 (identity coherence) and 6
> (determinism/resume) are weighted double in the ranking. Scores verified against
> `research/workflow-tool-spec.md` and `CAPABILITY-REVIEW.md`, not the proposals'
> self-assessments.

## 1. Scorecard

Weighted total = D1 + D2 + D3 + D4 + 2×D5 + 2×D6 (max 80).

| Dimension | A — Determinism Maximalist | B — Pragmatist Portfolio | C — Workflow-Native Rethink |
|---|---|---|---|
| D1 Feature richness & user value | **9** | **7** | **8** |
| D2 Constraint compliance | **4** ⚠ | **9** | **9** |
| D3 Shippability & migration realism | **7** | **9** | **8** |
| D4 Risk profile & rollback | **7** | **9** | **8** |
| D5 Canon-identity coherence (×2) | **5** | **7** | **9** |
| D6 Determinism & resume soundness (×2) | **9** | **7** | **9** |
| **Weighted total** | **55/80** | **62/80** | **69/80** |
| Hard-limit violation cap | **YES — capped at 5/10 overall** (see A fatal flaw) | No | No |

---

## 2. Per-proposal justifications

### Proposal A — Determinism Maximalist (55/80, capped)

**D1 = 9.** The broadest end-state of the three: compiled supervised tier, post-segment
provenance audit (F11), `compile_remainder` for cross-session re-entry, skip-reason
validation at ingest time, saved diagnostics. The killer demo's mid-build-kill resume is
the single most compelling user-value moment in any proposal.

**D2 = 4 — and this is an actual hard-limit violation, capping the overall score at 5.**
Constraint ledger #2: "Plan approval + initial review verdict are mandatory at ALL Canon
tiers and **cannot be compiled away**." A's runner (§3.3 `reviewFixLoop`) computes the
review verdict in code and, on BLOCKING, **auto-runs fix iterations inside the segment
before any human sees a verdict**. A's own killer demo step 7 confirms it: "Verdict
computes to BLOCKING(2) in code... One fix iteration runs (bound 3); re-review returns
WARNING. ... Segment returns" — the user is then presented the *post-fix* WARNING, never
the initial BLOCKING verdict. In Canon as-built (CLAUDE.md Autonomy Tier Protocol), even
the autonomous tier presents the initial verdict and the user authorizes the fix; only
*CLEAN-after-fix re-review* auto-proceeds. A inverts this: the machine decides to fix,
the human ratifies the outcome. §3.5's own justification ("the review-fix loop fits
inside one segment even under supervised, because the catalog's checkpoints are per
major step, not per iteration") shows this is deliberate design, not an oversight. Both
rival teams independently avoided this shape — B explicitly states "the verdict gate
sits inside the loop, so folding the whole loop into one run would violate HC-2"; C
compiles the fix loop as a *separate segment parameterized by the gate answer*. A stands
alone against the gate. Everything else in A's compliance story is excellent (probe
design, three-channel opt-in, IR schema banning `isolation`, compiler invariant refusing
plans not segmented at both mandatory gates — an invariant its own runner then defeats
from the inside).

**D3 = 7.** Increments are well-ordered and each is standalone-valuable, but Increment 5
(supervised compilation + W8) is a large bet whose payoff the prior Deterministic Spine
epic already judged marginal, and the full compiler lands only at Increment 3.

**D4 = 7.** Interpretive fallback retained, IR is substrate-neutral, probes degrade
safely, args-size risk honestly owned and mitigated (path indirection). Compiling the
supervised tier enlarges blast radius for the least benefit.

**D5 = 5 (×2).** Genuinely strong auditability machinery — trace-ledger projection with
runId cross-references, deterministic provenance audit, skip-reasons validated at write
time, journal race deleted by single-writer construction. But the identity question is
not "is the record auditable" — it is "do the gates govern." A's philosophy ("supervised
compiles anyway; segment size is a tier parameter, not a viability cliff") subordinates
supervision to determinism, and the in-segment fix loop converts Canon's highest-value
checkpoint into a post-hoc rubber stamp. That is identity erosion at the exact point the
PM identity exists to protect. Canon-with-A is more auditable and less supervised.

**D6 = 9 (×2).** Best-in-field determinism engineering: env-snapshot *path indirection*
keeps args compact and prompts byte-stable; forward-only HITL answers preserve pre-gate
prefix caches; `compile_remainder` gives an honest cross-session story; byte-stable
single runner maximizes prefix reuse across all builds.

**Fatal flaw (strongest rival attack):** *"Your compiler enforces that no plan can
compile away the two mandatory gates — and then your runner compiles away the initial
review verdict from the inside by auto-fixing BLOCKING findings before any human sees
them. The user reviews what your machine already decided to do about the review."* This
is a constraint-ledger #2 violation by the proposal's own demo text, and it caps A at 5
overall per the rubric.

### Proposal B — Leverage-per-Primitive Pragmatist (62/80)

**D1 = 7.** The widest *pattern* breadth (adversarial verify, loop-until-dry sweeps,
judge panels, security harness, diagnostics, learner mining) and the only proposal that
fixes a named live defect (watch_WWWWWW1 sweep under-detection). But it deliberately
declines the trunk: no general implement-wave substrate for ordinary DAG builds (F7
covers only the migration class), no relief for journal choreography, ghost steps, or
the renderer obligation outside the review workflow. The drift class that motivated this
whole exercise — the orchestrator as prose interpreter — survives B mostly intact.

**D2 = 9.** Cleanest compliance story. Every HC resolved inside existing doctrine; the
fix loop stays orchestrator-driven across iterations *specifically* to honor the verdict
gate; CI lint bans `isolation:` and clock APIs; probes gate only the code-writing
features; null-policy table is explicit per node class. No violations found on
verification.

**D3 = 9.** The most honest migration path in the competition: no increment depends on a
later one, the flagship lands by Increment 3, rollback is "delete one runbook field,"
and effort estimates are credible (thin choreography scripts, not engines).

**D4 = 9.** "Nothing here can fail in a way that takes Canon down with it" survives
adversarial scrutiny: opt-out by omission, no state migration, no protocol restructure,
harness-evolution exposure limited to thin scripts.

**D5 = 7 (×2).** Gates, journal doctrine, worktree discipline, artifact shapes — all
bit-identical to today; second-source-of-truth risk is minimal because the two journals
never record the same grain. Two deductions. First, **dead-wire exposure**: Canon's
documented defect class is "built but never wired" (evaluate_step, OutcomeStore), and a
13-feature portfolio whose adoption depends on architects remembering to write
`engine: workflow:<name>` reproduces exactly that risk profile for its long tail
(canon-compete, canon-learn-mine, cron maintenance). Second, **review-input dilution**:
B replaces the current confirmation-based consolidation (findings seen by 2+ reviewers
are confirmed *directly*; only minority findings get probed) with refuter-majority-kill
over *every* finding, with refuters prompted "default to refuted=true if uncertain" —
under one-reviewer-per-partition there is no confirmation fast path left, so the
mandatory verdict gate's inputs pass through a filter structurally biased toward
suppression. The HITL gate stays in place but sees less.

**D6 = 7 (×2).** Within workflow regions: sound (static scripts, frozen envelope, scout
nodes, count bounds). But workflows occupy only the leaves; the build's spine — step
sequencing, loop counting, merge conduct for non-migration builds, journal choreography
— remains nondeterministic LLM prose, and resume therefore covers the smallest fraction
of the build of any proposal.

**Fatal flaw (strongest rival attack):** *"You routed every review finding through
skeptics instructed to default-refute, and deleted the 2-reviewer confirmation path that
today admits findings directly. Your flagship feature makes Canon's mandatory verdict
gate better-typed and worse-informed — and after all 8 increments, the least reliable
component in the stack still hand-conducts everything between your workflows."*

### Proposal C — Workflow-Native Rethink (69/80)

**D1 = 8.** Near-A's end-state richness (runner+IR, compiled segments, waves on
`parallel()`, schema contracts, structural renderers, background UX, re-runnable probe
canary) while deliberately not chasing supervised compilation. Slightly narrower
pattern portfolio than B (no security harness, no sweep, no learner mining).

**D2 = 9.** Every HC resolved with the most care in the field: the fix loop is a
*separate post-gate segment parameterized by the user's gate answer* (the compliant
shape A lacks); both A1 and A2 failure branches are designed, not hand-waved; G5's
inexpressibility is owned rather than faked ("we do not fake it"); supervised regions
where compilation degenerates are honestly excluded instead of forced. The
debate-vs-compete split (debate needs SendMessage, which workflow agents lack — stays on
teams; compete maps to judge-panel — migrates) shows the spec was actually read.

**D3 = 8.** Evidence-gated M0–M6 with explicit promotion gates between increments
("3 green tail runs with clean journals"); M1–M4 are standalone-valuable even if the M5
compiler never lands, and they become the compiler's golden-test fixtures when it does —
the best de-risking of the compiler bet in the competition. Still a larger program than
B, and M5 is where it could stall.

**D4 = 8.** Per-build fallback bit, `runner_min_version` handshake, probe as standing
regression canary, compiler correctness owned as load-bearing with golden tests +
shape-agnosticity lint. Cost: dual-path maintenance (see fatal flaw).

**D5 = 9 (×2).** The strongest identity argument in the competition, and the §3.7
S1–S19 survives/replaced verdict table is precisely the audit this lens demands —
every one of Canon's 19 mechanisms gets an explicit disposition with reasoning. Gates
are not worked around; they are *promoted to the segmentation function* ("the gate
catalog IS the segmentation function"). The initial review verdict is preserved with
the user's answer parameterizing the next segment. Worktree lifecycle is named
"inviolate" and the `isolation` prohibition moves from prose rule to schema-enforced
impossibility. The learner becomes structurally unskippable. Journal: one writer per
store, runId cross-keyed, drift between the two journals *mechanically detectable at
ingestion* (node count vs journal entries) — a stronger reconciliation answer than
either rival. The #151 objection is answered the same way as A (one runner, data not
code, shape-agnosticity lint), and the evidence-gated migration directly counters the
dead-wire defect class. One point deducted: permanent dual execution semantics (fatal
flaw below).

**D6 = 9 (×2).** The cleanest cache-invalidation reasoning in the field: gate answers
*only ever* parameterize the next segment's args; `resumeFromRunId` is reserved
exclusively for unchanged plan+args — "the two mechanisms never interact." The compiler
*enforces* prompt purity (prompts must be pure functions of plan, scout results, and
prior node results — "there is no third source"). Budget RESERVE check returns a
graceful resumable `BUDGET_ABORT` instead of a mid-wave throw. Minor weakness vs A:
frozen enrichment is embedded verbatim in args rather than path-indirected, creating
unbounded args-size pressure A explicitly mitigated.

**Fatal flaw (strongest rival attack):** *"You run two execution semantics forever.
Supervised — the tier Canon actually uses today — stays on the prose path, while
autonomous/light-touch live on your compiler. Every protocol change must now land twice
(CLAUDE.md prose AND compiler/runner), recreating the exact drift class you set out to
kill; and since current usage skews supervised, your compiled spine risks becoming
Canon's next dead wire: built, golden-tested, and rarely exercised."* C partially
pre-answers this (supervised still gets F3/F5/F9/F11/F12 per-step mechanisms), but the
dual-semantics maintenance burden is real and unpriced.

---

## 3. Verdict — ranked order

**1. Proposal C. 2. Proposal B. 3. Proposal A (capped).**

C wins on this lens because it is the only proposal that achieves the deterministic-spine
end-state *without spending Canon's identity to get it*: the gate catalog becomes the
segmentation function rather than an obstacle, the initial review verdict keeps its
decision authority, every one of the 19 mechanisms receives an explicit
survives/replaced verdict, the journal gains a single writer per store with mechanical
drift detection, and the migration is evidence-gated so the compiler bet is taken only
after its fixtures exist. B is the most shippable and most compliant portfolio and would
be the right choice if the goal were quick wins — but under double-weighted coherence
and determinism it loses to C because it leaves the trunk (the prose-interpreting
orchestrator, the journal race, the renderer memory, ordinary DAG dispatch) untouched
and carries the project's documented built-but-never-wired risk across its long tail. A
is the most ambitious determinism engineering in the field — and it disqualifies itself:
its in-segment review→fix loop auto-fixes BLOCKING findings before any human sees a
verdict, violating constraint-ledger #2's "cannot be compiled away" by its own demo
text, which caps it at 5 overall and confirms the lens's core worry: determinism
maximalism, pushed past the gates, stops being Canon.

---

## 4. Graft candidates (from non-winning proposals into C)

1. **A's F9 enrichment-freezer path indirection.** Materialize preloads/context to
   immutable files under `${WORKSPACE}/segments/{id}/env/` and have IR prompts reference
   stable *paths*. Directly fixes C's args-size pressure (C embeds preload text verbatim
   in args) while keeping prompts byte-stable for the prefix cache.
2. **A's F11 post-segment provenance audit at ingest.** Deterministic checks at
   `ingest_workflow_run` time: trailers present, declared artifacts exist on disk,
   committed paths ⊆ IR-declared file lists. Strictly stronger than C's A1-false
   contingencies (which are L2 prompt-level), and valuable even if A1 is true.
3. **A's compiler invariant: refuse to emit any plan not segmented at both mandatory
   gates.** Ironic given A's own runner defeats it, but the invariant itself is the
   right structural guarantee for constraint #2 — C should adopt it verbatim in
   `compile_segments` validation.
4. **B's `engine: workflow:<name>` runbook field as the M1–M4 adoption mechanism.**
   Per-step, architect-owned, opt-out-by-omission selection is a smoother and more
   auditable adoption path during the special-purpose-workflow phase than C's per-build
   consent bit alone; the two compose (consent bit gates the build, engine field selects
   the steps).
5. **B's `canon-sweep` loop-until-dry multi-modal sweep wired to `/canon:check`.** The
   one feature in the field that fixes a named live defect (watch_WWWWWW1 sweep
   under-detection); C has no equivalent and the pattern drops cleanly into C's
   saved-workflow tier (F13).
6. **B's empirical cost discipline for adversarial verification.** Refuter count as a
   tier-scaled param plus a before/after probe table (cost, wall-clock, findings
   survived) shipped with the review workflow increment — and, as a correction to B's
   own flaw, retain the 2+-reviewer confirmation fast path so refuters only filter
   minority findings.

---

## 5. Convergence / divergence observations

**Independent convergence (strong signal — three teams, no coordination):**

- **Never execute model-generated code.** All three converge on hand-written, versioned,
  CI-reviewed scripts with per-build variation flowing exclusively through `args` as
  data. This is as close to a settled question as a 3-way competition can produce.
- **Worktree resolution is identical in all three:** ban the `isolation:'worktree'` flag
  (lint or schema), keep agent-managed `canon-task/{id}` worktrees per the worker-prompt
  pattern, and put merging in a dedicated merge-agent node returning a structured
  report, conflicts early-returning to the existing HITL. HC-1 should be considered
  solved with this exact shape.
- **Three-channel opt-in stack** (skill instruction + plan-approval consent line +
  named-workflow invocation) appears in near-identical wording in all three. HC-4
  likewise solved.
- **Single-writer notification-time journal ingestion** with runId cross-references, two
  journals at different grains, agents never touching journal.json — all three, with A
  and C additionally claiming (correctly) that this dissolves rather than locks the
  known write race in compiled regions.
- **Shared tactical vocabulary:** scout nodes for live state, count-based bounds
  replacing wall-clock, explicit null-policy per node class, an Increment-0 A1/A2 probe,
  the tail as the first live workflow (W4 reshaped), and the schema library as the
  cheapest very-high-leverage item (every team puts typed statuses in its first two
  increments — it should ship regardless of which design wins).

**Divergence (where the real decision lives):**

- **Runner+IR or not.** A and C independently converged on one-trusted-runner +
  compiled-plan-as-args from different philosophies — meaningful evidence the shape is
  sound. B rejects it *for this horizon only* and explicitly leaves its library as a
  future compiler target ("compiled plans could invoke library workflows via
  `workflow()` — one nesting level is exactly enough"). The three proposals are thus
  closer to a sequencing disagreement than an architecture disagreement.
- **The review→fix loop is the sharpest discriminator.** B keeps it orchestrator-driven
  across iterations; C compiles it as a separate post-gate segment; A folds it inside
  the segment ahead of the verdict gate. Two teams independently treated the initial
  verdict as inviolable; one did not. The panel should treat in-segment auto-fix as
  rejected.
- **Supervised tier:** A compiles it (and pays for it), B declines to touch gate density
  on principle ("a user-chosen property, not a defect"), C excludes checkpointed regions
  with arithmetic honesty. B and C agree against A here too.

---

### Status

DONE

**Artifact:** `${WORKSPACE}/plans/fresh-architect-review-of-claude-code-workflow-tool/JUDGE-coherence.md`

**Summary:** Ranked C (69/80) > B (62/80) > A (55/80, capped at 5 overall for a
constraint-ledger #2 violation: its in-segment review→fix loop auto-fixes BLOCKING
findings before the initial review verdict is presented — confirmed by A's own runner
excerpt and killer demo). C wins the coherence lens: gates as the segmentation function,
explicit S1–S19 survives/replaced audit, single-writer journal with mechanical drift
detection, cleanest resume/cache separation, evidence-gated migration. Six graft
candidates identified (A's env-path indirection, provenance audit, mandatory-gate
compiler invariant; B's engine-field adoption mechanism, canon-sweep, empirical refuter
discipline with confirmation fast path restored). Strong 3-way convergence on
no-generated-code, worktree shape, opt-in stack, and single-writer ingestion.
