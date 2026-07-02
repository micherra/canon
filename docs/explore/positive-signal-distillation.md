# Positive-Signal Distillation — Can Canon's learner mine what went *right*?

**Date:** 2026-06-29
**Type:** Exploration / design-altitude analysis. No code, no workspace.
**Parent:** `docs/explore/agentkb-transferable-ideas.md` §3.3 + §5 (thread R4).
**Premise:** Canon's automated distillation loop is *failure-driven* — it localizes
failures (review violations, write-cliff events) and distills lessons from what went
*wrong*. AgentKB's human-run synthesis can also fold in *positive* signal — "this approach
was elegant / this taste is worth keeping" — which a failure-attribution pipeline
structurally cannot see. This doc maps the gap honestly and recommends a disposition.

---

## 1. The gap, precisely stated

Canon's distillation pipeline has exactly two failure inputs, and nothing else feeds it:

- `attribute_failure` consumes **only** `review_violations` (parsed from `REVIEW.md`) and
  `cliff_events` (from `drift.db`). Grounded: `attribution-failure-sources.ts:32-35` —
  `type FailureSources = { violations: ReviewViolation[]; cliffEvents: CliffEventRow[] }`.
  There is no third, positive source. `attribution-types.ts:35` — `FAILURE_KINDS =
  ["review_violation", "cliff_event"]`. Every attribution is a failure localized to an
  in-context artifact.
- `select_mutation_targets` ranks targets by `attributed_violation_count` **descending**
  (`mutation-selection.ts`) — i.e. it surfaces the artifacts most implicated in failures.
- `evaluate_candidate` is sign-agnostic (a holdout fitness gate), but it only ever sees
  candidates that the failure-driven selector chose to mutate.

So the generative end of the loop — *what gets proposed as a learning* — is fed exclusively
by failure localization. The "elegant resolution / taste worth keeping" axis enters nowhere.

**Where the positive signal physically exists and is then dropped:**

1. **156 of 232 build digests (67%) are clean builds** — 0 violations AND 0 fix
   iterations (measured across
   `~/.claude/projects/-Users-michelle-Documents-canon/memory/build-digest-*.md`). This is
   a large, real corpus of "this build went well." Nothing in the learner consumes the
   *clean* digests as positive signal; the digest exists for human/Auto-Dream reading, not
   for the distillation loop.
2. **The build digest has no qualitative "what went right" field.** `digest-writer.ts`'s
   `DigestData` (lines 33-47) records only metrics: steps, fix iterations, review verdict,
   violation count, duration, and a free-text `outcome` lifted from the planning brief.
   Grep across all 232 digests for `elegant` / `what went right` / `went well` → **0 hits**.
   The taste is never written down at digest time.
3. **The architect's DESIGN.md "why" and the engineer's SUMMARY decisions/deviations** —
   the prose that actually contains "this approach is clean because…" — are read by the
   digest writer's extractors only for the *outcome* string and for *violations*
   (`run-summary-extractors.ts`: `parsePlanningBrief`, `parseReviewFile`). The rationale
   prose is never mined for reusable positive patterns.

---

## 2. What Canon already partially captures (the honest part)

Canon is **not blind** to positive signal. Two existing mechanisms give "what went right" a
real — but strictly *modulating*, never *generative* — role:

**(a) `computeOutcomeWeight` (`judge-weight.ts`) already uplifts clean builds.** A CLEAN or
`approve` verdict yields a verdict sub-weight of **1.15** (`VERDICT_WEIGHTS`, lines 52-57);
0 fix iterations incurs no penalty; a high test-pass-rate adds up to **1.1**. The product is
clamped to `[0.4, 1.2]`. This weight multiplies `RecurringViolation.weighted_instance_count`
in the `convention-lifecycle` dimension (`learner-dimensions.md:117-119`): a task-convention
pattern that recurs across **clean** builds crosses the weighted ≥ 3 promotion threshold
faster than the same pattern seen in blocking builds. So positive build outcome already
**accelerates promotion of an already-counted pattern**. What it cannot do: surface a *new*
pattern. It is a multiplier on a count the failure/convention path already produced, never a
producer of its own.

**(b) `get_drift_report.honored[]` already encodes "this guardrail is working."**
`analyzer.ts:98-100` aggregates `times_honored` per principle. `principle-health` promotes
high-compliance principles; `artifact-retirement`'s **defer-to-demotion** gate
(`learner-dimensions.md:266`) explicitly refuses to prune any still-firing principle. So the
*guardrail-reinforcement* flavor of positive signal — "keep this rule, it's load-bearing" —
is **already covered**. This matters for ranking the mechanisms below: a symmetric
"attribute_success" tool would largely re-derive `honored[]`.

**(c) `codebase-patterns` dimension is positive-pattern discovery — but outcome-blind.** It
mines the *live* codebase (Grep/Glob) for consistent good patterns to formalize as
conventions (`learner-dimensions.md:67-100`). This is the closest existing analogue to
AgentKB's taste-capture, but it reads the *current code state*, divorced from build outcome.
It can say "this pattern is in 8 files at 90% consistency"; it cannot say "this pattern
correlates with clean builds" or "the *way this build solved X* was elegant."

**Net:** the genuine gap is narrow and specific — a **generation gap, not a primitive gap**.
Canon has the weighting (a), the guardrail-reinforcement signal (b), a pattern generator (c),
the sign-agnostic gate (`evaluate_candidate`), and the HITL/cooling-off discipline
(`.canon/proposed-learnings/`). What is missing is a *producer that points the existing
generator at the clean-build corpus with a positive lens* — "across these N clean builds, this
recurring resolution is worth keeping as a convention."

---

## 3. Candidate mechanisms (ranked by leverage / cost)

### M1 — `success-pattern` learner sub-dimension + a "notable resolution" digest field  *(fold into learner — recommended)*

- **What:** Add a `success-pattern` sub-analysis (homed under `convention-lifecycle`, beside
  Sub-analysis A) that reads the *clean-build* corpus — clean digests plus their
  `DESIGN.md` "why" and engineer `SUMMARY` decisions/deviations — and proposes conventions for
  **recurring** elegant resolutions, cross-checked against existing conventions/principles.
  Enrich `digest-writer.ts` with one small qualitative field (`notable_resolution`, sourced
  from the engineer SUMMARY `decisions`/`deviations` or architect DESIGN rationale) so the
  learner mines a structured line, not full transcripts.
- **Artifacts touched:** `references/learner-dimensions.md` (new sub-analysis spec),
  `agents/learner.md` (dimension wiring), `mcp-server/src/features/orchestration/services/digest-writer.ts`
  (+ `run-summary-extractors.ts` for the new field), output to `.canon/proposed-learnings/`.
- **Type:** learner-dimension extension (+ a tiny producer change). **No new MCP tool, no new
  attribution primitive.**
- **Leverage/cost:** Highest leverage per unit cost. Reuses the weighted-count discipline
  (which already encodes "don't trust a single instance"), the cooling-off N-of-M gate, and
  the proposed-learnings HITL — so it inherits the anti-noise machinery for free. The gate on
  **recurrence across multiple independent clean builds** is exactly what stops a single
  trivially-clean build from minting a bogus "best practice."

### M2 — `attribute_success`: the symmetric structural sibling of `attribute_failure`  *(decline — mostly redundant)*

- **What:** Mirror `attribute_failure` — join `context_provenance` ⋈ *clean* builds
  (verdict=clean, 0 violations, 0 fix) to report "these in-context artifacts were present for
  builds that went clean N times" → a reinforcement / protect-from-pruning signal.
- **Artifacts touched:** new `features/evolution/services/attribution-success-sources.ts`,
  a new `reinforce_targets` tool; consumes the same provenance store.
- **Why it ranks low:** It splits into two halves, and **both fail**. The *guardrail-health*
  half ("this rule is working, protect it") is already produced by `honored[]` +
  `principle-health` promotion + the defer-to-demotion prune gate — net redundant. The
  *taste-capture* half ("the way this build solved X was elegant") is the actual gap, but it
  is a **qualitative judgment a structural join cannot make** — presence-in-context of an
  artifact during a clean build says nothing about whether the *solution* was elegant. So the
  structural tool delivers the redundant half and cannot deliver the half that matters.

### M3 — Symmetric "positive Mutator" with its own holdout loop  *(decline — over-engineered)*

- **What:** A full positive-attribution → positive-candidate-generation → holdout-gate loop
  mirroring the failure Mutator.
- **Why it ranks lowest:** No new primitive is needed. The generative step already exists
  (`codebase-patterns` / `convention-lifecycle` in the learner); `evaluate_candidate` is
  already sign-agnostic and can gate a positive candidate as-is. Building a parallel loop
  duplicates the learner and the gate for no capability gain — and contradicts the parent
  doc's standing verdict (§4) that Canon should not regress its automated, gated loop into a
  second hand-built mechanism.

---

## 4. Recommendation

**Fold into the learner (M1). Decline M2 and M3.**

Rationale:

1. **The gap is a generation gap, not a primitive gap.** Canon already owns every piece
   except a producer that reads clean builds with a positive lens. M1 adds exactly that
   producer and nothing more.
2. **The anti-noise discipline already exists and must be inherited, not rebuilt.** Positive
   mining is noisier than failure mining — a clean build does not *prove* its approach was
   good (it may be clean because it was trivial). Homing the sub-analysis inside
   `convention-lifecycle` means it reuses the weighted-instance-count threshold (≥ 3 across
   independent builds, outcome-weighted) and the cooling-off N-of-M gate. Both already encode
   "don't promote from one instance." A standalone tool (M2/M3) would have to re-implement
   this.
3. **It composes with what's already half-built.** `computeOutcomeWeight` already gives clean
   builds an uplift; M1 simply gives the learner a positive *pattern source* for that uplift
   to act on, closing the loop between "this build went well" and "capture why."
4. **It respects the parent doc's verdict.** §3.3 / §4 concluded Canon is *ahead* on the
   distillation *mechanism* and should not adopt AgentKB's manual synthesis; the only honest
   residual was positive coverage. M1 closes that residual with an automated, gated learner
   dimension — not a human transcribe step.

**Suggested guardrails for the M1 spec (when it is built):**
- Promote only on recurrence across ≥ 3 independent clean builds (reuse the weighted-count
  threshold); never from a single elegant-looking build.
- Cross-check every candidate against `.canon/CONVENTIONS.md` + the principle index before
  surfacing (same as `codebase-patterns`).
- Surface-only via `.canon/proposed-learnings/`, HITL-gated through PM → writer — never
  auto-apply (mirrors the failure loop's evolution-hard-gate).
- The "notable resolution" digest field is an *enrichment for mining*, not a promotion source
  on its own — a single self-reported "this was clean" line is not evidence.

---

## Assumptions (per agent-surface-assumptions)

- **`attribute_failure` consumes only review violations + cliff events** — *confidence: high*.
  Verified in `attribution-failure-sources.ts:32-47` (`FailureSources` has exactly two fields)
  and `attribution-types.ts:35` (`FAILURE_KINDS` has exactly two members; `test_failure`
  explicitly deferred).
- **`computeOutcomeWeight` already uplifts clean/approve builds (1.15) and feeds
  `weighted_instance_count`** — *confidence: high*. Verified in `judge-weight.ts:52-57` and
  `learner-dimensions.md:117-119`.
- **No learner dimension currently mines clean builds for positive patterns** — *confidence:
  high*. The 9 dimensions in `analyze-patterns/SKILL.md:22` and `learner-dimensions.md` are
  all failure/health/efficiency/static-pattern oriented; `codebase-patterns` is the only
  positive one and is outcome-blind (live-codebase scan, no build-outcome join).
- **156/232 digests are clean (0 violations, 0 fix iterations) and 0 digests record
  qualitative positive prose** — *confidence: high*. Measured directly by grep/count over the
  digest corpus on 2026-06-29.
- **The architect DESIGN "why" and engineer SUMMARY decisions are not mined for positive
  patterns** — *confidence: medium*. Based on `digest-writer.ts` reading only `parsePlanningBrief`
  (outcome) and `parseReviewFile` (violations); did not exhaustively trace every learner
  Grep path, but no dimension spec names DESIGN/SUMMARY rationale as a positive-pattern source.
- **The guardrail-reinforcement half of `attribute_success` is redundant with `honored[]`** —
  *confidence: medium*. `analyzer.ts:98-100` aggregates `times_honored` and `principle-health`
  + `artifact-retirement` consume it; a structural success-join would re-derive the same
  "this guardrail is working" signal, though not byte-identically.

---

## SUMMARY

**Gap (one line):** Canon's distillation loop is fed exclusively by two *failure* sources
(`review_violations` + `cliff_events`); the 156/232 clean builds and the "elegant resolution"
taste in their DESIGN/SUMMARY prose are never mined as positive patterns — though
`computeOutcomeWeight` already *uplifts* clean builds and `honored[]` already captures
"this guardrail works," so the residual is purely a **generation** gap, not a primitive gap.

**Recommendation:** Fold into the learner — add a `success-pattern` sub-dimension (homed in
`convention-lifecycle`) that mines clean builds for *recurring* elegant resolutions, plus a
small `notable_resolution` digest field to give it structured signal; inherit the existing
weighted-count + cooling-off + proposed-learnings HITL discipline. **Decline** the symmetric
`attribute_success` tool and the parallel positive-Mutator.

**Sharpest insight:** The structural symmetry "if `attribute_failure` exists, build
`attribute_success`" is a trap — presence-in-context during a *clean* build is information-free
about whether the *solution* was good, so a structural success-join can only re-derive the
already-captured guardrail-health signal and cannot touch the actual gap (taste). The taste
gap is irreducibly a *model-read* of clean-build rationale, which is the learner's existing
job — so the right move is to point the learner at the clean corpus, not to mint a new
tool.
