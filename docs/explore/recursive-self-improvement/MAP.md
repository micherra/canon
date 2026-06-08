# Recursive Self-Improvement in Canon — Map & Gap Analysis

## Status: Complete

Map-first exploration (2026-06-08). Inventory of Canon's existing
self-improvement loops, classified by where each loop is **closed**, **open**,
or **broken (dead-wired)**. Gap analysis is the deliverable; candidate next
loops are secondary, framed as "candidate next loops to close" — not committed
work.

All claims below are grounded in the actual repo state at HEAD (`8aad9241`),
verified by reading source — not assumed from project memory. Where a
project-memory "dead-wire" claim was checked against code, the verdict (CONFIRMED
/ REFINED / DISPROVEN) is noted.

---

## 1. RSI Framework Summary

Source: Anthropic, *"When AI Builds Itself"*
(https://www.anthropic.com/institute/recursive-self-improvement).

The article's core distinction, applied to dev tooling:

| Article term | Meaning | Dev-tooling translation |
|---|---|---|
| **"The doing"** | Executing a task; now "costs almost nothing in human time" | Agents write code, run gates, mine patterns |
| **"Direction-setting"** | Choosing *what* to improve and *whether* it worked | The human gate — PM approval, plan approval, promotion review |
| **"Research taste"** | The judgment to pick good directions; still absent in AI | What every Canon human gate substitutes for |
| **"Closing the loop"** | The terminal stage — the system designs its own successor | A loop where the improvement feeds back to make the *next* improvement cycle better/faster |
| **Amdahl's law** | As one component accelerates, the bottleneck shifts to the slowest remaining one | When mining is automated, the human promotion gate becomes the bottleneck |

The article frames RSI as **"an AI system capable of fully autonomously
designing and developing its own successor"** — where the same capabilities that
automate development "turn inward." The key compounding claim: improvements to
the *improver* make each subsequent cycle measurably better or faster.

**Operational test used in this map** — for each loop, the decisive column is:
*does the output of one cycle change the machinery such that the next cycle of
**this same loop** improves?*

- **Iterative**: improves an artifact once (e.g. learner promotes one
  convention). The improver is unchanged; cycle N+1 is no better at improving
  than cycle N.
- **Recursive**: improves the improvement machinery (e.g. a build outcome
  changes how stringently the *next* build is gated, or a mined pattern changes
  how the *miner* mines). Gains compound.

The article's safety framing is abstract but names three risks directly relevant
to a system that edits its own principles/agents: **loss of oversight**
("humans play a substantially diminished role"), **compounding misalignment**
("misalignment... could compound as the models build their successors, growing
more frequent but less understood"), and **legibility collapse** ("we can't
build, integrate, and verify the tools we'd need to understand which trendline
we are on"). It does **not** discuss reward hacking — Section 6 supplies that.

---

## 2. Inventory Table

Columns: **Loop** | **Trigger** | **Signal source** | **Analysis step** |
**Proposed-change step** | **Gate** | **Feeds-back-to-improve-the-improver?**

| Loop | Trigger | Signal source | Analysis | Proposed change | Gate | Recursive? |
|------|---------|---------------|----------|-----------------|------|------------|
| **L1 — Learner promotion ladder** | `learn` step (every build) | `.canon/learning.jsonl` (122 entries), `get_drift_report`, `get_cross_run_analysis`, live Grep/Glob | `agents/learner.md` + `references/learner-dimensions.md` dimensions; `.canon/proposed-learnings/` (223 files) with CONSOLIDATE staleness pass | watch → suggestion → convention → strong-opinion → rule; exact text emitted | **Human** (writer applies via `content-flow/learn-apply`) | **Iterative-only** (see §3) |
| **L2 — Drift detection** | Reviewer findings; build steps | JSONL drift store / `drift.db`; `get_drift_report` | Confidence decay (`computeConfidenceAnnotation`), recurring-violation aggregation in `cross-run-analyzer.ts` | Surfaces violations to learner + reviewer + `get_context(include:["drift"])` | **Auto** (feeds analysis); human at promotion | **Partially recursive** — drift → learner → principle → fewer future violations is a real chain, but each hop is human-gated |
| **L3 — Cliff detection** | Agent write-cliff (dies mid-artifact) | `reconcile_workspace` dual-writes `cliff_events` to `drift.db` | `computeCliffEventsDimension` / `cross-run-cliff-events.ts`; learner "Write-cliff telemetry" dimension (watch_BBBBB1 consumer) | Pattern watch on repeat-cliffing step/agent types | **Human** (surface, no auto re-spawn) | **Iterative-only** — telemetry consumed by learner report, but does not change agent/step machinery automatically |
| **L4 — Craft drift** | Review step (6-dim craft profile, PR #301 v2) | `craft-profile-dao.ts` rows in `drift.db` | `computeCraftDrift` / `cross-run-craft-drift.ts` | Craft-trend entry in learning report; `/canon:craft-audit` | **Human** | **Iterative-only** |
| **L5 — Autonomy tier** | After `init_workspace` | `gatherSignals` reads **real `build_history` from `drift.db`**: `recent_runs`, `clean_review_rate`, `avg_retry_count`, `recent_failure_rate` | `confidence-scorer.ts` `computeConfidence` (pure, fixed-weight penalties) | Tier: autonomous / light-touch / supervised → gates skipped or active | **Auto** (gate selection); human override available | **CLOSED / recursive-leaning** — past build outcomes lower future-build gate stringency. The one loop where output mechanically changes the next cycle's behavior with no human in the path. |
| **L6 — Escalation cascade** | Agent failure / `isStuck` | `get_next_escalation_strategy` advances state in execution store | Fixed sequence: add_primer → increase_budget → escalate_model → narrow_scope → hitl | Applies next strategy | **Auto** (advance); HITL terminal | **Open** — emits `auto_decision` events but **nothing reads them** to reorder/learn the cascade (see §3, dead-wire) |
| **L7 — Principle → agent behavior** | Principle/convention edit (writer) | `scope_tags`, `wiki_lint` (`checkScopeTags`), agent `rules:`/`references:` preload | `resolve_agent_skills` injects principle text into spawn prompts; reviewer enforces | Agent behavior changes next build | **Human** (writer + review) | **Partially recursive** — changed principles change agent behavior, which generates new drift/review signal that *can* refine principles (the L1↔L7 macro-loop), but every hop is human-gated |
| **L8 — Canon builds Canon (dark factory)** | User build request targeting Canon's own agents/principles/hooks | The full pipeline (architect→engineer→reviewer→learner) | The pipeline itself; build digests; MP-1..MP-7 meta-process series | New/edited Canon agents, principles, hooks, MCP tools | **Human** (PM + plan approval + review verdict — always-on per tier protocol) | **Recursive in principle, human-gated in practice** — the most literally recursive surface; Canon's pipeline improves Canon's pipeline, but direction-setting and verdict remain human |
| **L9 — Agent metrics** | Every step (`record_agent_metrics`) | Merged into `execution_states.metrics` JSON | — | — | — | **DEAD-WIRED** — written every step; `buildRunSummary` does **not** read `execution_states.metrics`; no analysis consumes it (see §3) |
| **L10 — `decision_summaries`** | Archive (`buildRunSummary`) | Hardcoded `[] as const` | — | — | — | **VESTIGIAL** — honestly retained empty for `version: 1` backward compat; not a live dead-wire, but a dead field |

---

## 3. Closed vs Open vs Broken

**Closed (loop completes and the output mechanically changes the next cycle):**

- **L5 — Autonomy tier.** This is the single genuinely closed self-improving
  loop in Canon. `gatherSignals` (`confidence-scorer.ts:389`) reads real build
  history from `drift.db` — clean-review rate, retry count, failure rate — and
  `computeConfidence` turns that into a tier that **mechanically** skips or
  activates gates on the *next* build, with no human in the path (override
  available but not required). Past outcomes → future gate stringency. That is a
  compounding feedback loop. Caveat: the weights are **fixed constants**
  (`cleanPenalty = (1-rate)*30`, `retryPenalty = min(retry*5, 20)`,
  `failurePenalty = rate*10`). The loop is closed but the *improver* (the weight
  function) is itself static — it doesn't learn better weights. So L5 is
  recursive at the gate level, iterative at the meta level.

**Open (a stage is missing — signal logged but no analysis consumes it, or no
auto-apply):**

- **L1 — Learner ladder.** Every analysis stage exists and is well-built (drift
  ingestion, cross-run weighting via JUDGE `weighted_instance_count`, CONSOLIDATE
  staleness). But the loop **does not compound**: a promoted convention improves
  *future builds' artifacts*, not *the learner's ability to mine*. Cycle N+1 of
  the learner is no better at learning than cycle N. The promotion gate is human
  (writer applies). This is the textbook iterative-not-recursive case — and it's
  Canon's flagship "self-improvement" loop. **The gap is at the top of the
  ladder, not the bottom.**
- **L6 — Escalation cascade.** Strategies are applied in a **fixed order**. The
  `auto_decision` events log only the *attempted* strategy (`strategy`,
  `reasoning`, `attempts_so_far`, `time_elapsed_ms` —
  `get-next-escalation-strategy.ts:74`); no later event records whether that
  strategy actually **resolved** the failure. So reordering the cascade based on
  what works needs *two* added stages, not one: first an outcome-capture step
  (stamp each `auto_decision` with its eventual resolution), then a reader that
  reorders on the captured rates. The resolution signal isn't write-only — it
  isn't recorded at all yet. Open, not broken — but costlier than a pure
  reader/reorder.
- **L3 / L4 — Cliff & craft drift.** Both compute real dimensions and surface
  them in the learner report, but the report is read by a human. No mechanical
  feedback to agent/step machinery. Open.

**Broken / dead-wired (wired in name, output never read):**

- **L9 — Agent metrics. CONFIRMED dead-wire.** `record_agent_metrics`
  (`features/diagnostics/tools/record-agent-metrics.ts`) merges performance
  counters into `execution_states.metrics`. **Nothing reads them back.**
  `buildRunSummary` (`run-summary-builder.ts:36`) ingests `stepOutcomes`,
  `reviewResults`, `plannerContext`, `artifactInventory` — **not**
  `execution_states.metrics`. So per-agent performance counters are recorded
  every step and never enter any analysis. This is the literal dead-wire the
  project memory flagged (`project_ruflo_reaudit_2026_06_04`), now verified in
  source. The MP-5 efficiency index (`turns_per_file_changed`) and MP-3
  threshold-calibration dimension — which would have been the *consumers* of this
  data — return **no matches** in `mcp-server/src` (grep for
  `turns_per_file`/`threshold_calibration` → empty). They are documented in build
  digests and project memory but **not implemented**. The producer ships without
  the consumer.

- **L10 — `decision_summaries`. DISPROVEN as a dead-wire.** Project memory listed
  `decision_summaries` alongside the dead-wire class. In code it is hardcoded
  `[] as const` with an explicit comment: "always empty — retained for
  version: 1 backward compatibility" (`run-summary-builder.ts:62-63`,
  `history-types.ts:104`). This is an honestly-documented vestigial field, not a
  silently-broken wire. Correct disposition: a dead *field* to eventually remove,
  not a dead *loop* to reconnect.

- **`get_cross_run_analysis` consumption — REFINED.** The analyzer is rich
  (recurring violations, fix-cycle patterns, agent-performance trends, craft
  drift, cliff events). But its **only non-test, non-doc consumer is
  `agents/learner.md`**, and the learner reads only two fields:
  `recurring_violations[].weighted_instance_count` and `cliff_events`. The
  "agent-performance trends" the analyzer computes (`cross-run-analyzer.ts:5`)
  are produced but **not read by any agent or orchestrator step**. So part of the
  analyzer's output is itself a partial dead-wire — built, but only ~2 of its
  dimensions are consumed.

---

## 4. The Recursion Gap

**Central finding:** Canon is overwhelmingly **iterative, not recursive**, and
it has exactly **one** genuinely closed compounding loop (L5, autonomy tier).
Every other "self-improvement" surface is a human-gated iterative loop wearing a
self-improvement label — valuable, but it does not improve the improver.

The recursion gap has a precise location. Canon has automated **"the doing"** of
improvement extremely well: mining (learner), measuring (drift, craft, cliff,
cross-run), and even building Canon with Canon (L8). Per Amdahl's law, that
automation has shifted the bottleneck entirely onto **"direction-setting"** —
the human promotion/verdict gate — and onto a structural fact: **the artifacts
Canon improves and the machinery that improves them are different objects.** The
learner improves *conventions consumed by builds*; it does not improve *the
learner's own dimensions, weights, or thresholds*. Cycle N+1 of the learner is
not better at learning because of cycle N. That is the definition of iterative.

The single highest-leverage loop-closure: **make build-and-review outcomes feed
back to tune the improvement machinery's own parameters, automatically.**
Concretely — the dead-wired agent metrics (L9) plus the unconsumed
agent-performance / cross-run dimensions are exactly the signal needed to:
(a) reorder the escalation cascade (L6) by what actually resolves failures,
(b) re-weight the confidence-scorer penalties (L5's static weights) from
observed clean-vs-failed outcomes, and (c) adjust learner promotion thresholds
(MP-3) from whether promoted conventions actually reduced future drift.

Closing **L9→consumer** is therefore the keystone: it is the one move that
converts three currently-iterative loops (L5 meta, L6, L1 thresholds) into
recursive ones, because it reconnects already-produced signal to the parameters
of the improver itself. It is also the lowest-risk because the producer already
exists and ships data every build — the missing half is a consumer, not a new
collection mechanism.

---

## 5. Candidate Next Loops to Close

Ranked by **leverage × feasibility**. Each is a candidate, not committed work.
"Net-new" vs "dead-wire closure" flagged.

1. **Wire agent-metrics into cross-run analysis (close L9).** *[Dead-wire
   closure — highest leverage, lowest risk.]* Make `buildRunSummary` ingest
   `execution_states.metrics` so per-agent counters (turns, retries, duration)
   enter the history store, then surface them as a learner dimension. This is the
   missing consumer for an already-shipping producer. Unlocks MP-3/MP-5 (both
   currently unimplemented). Feasibility high — one read path, one schema field,
   one dimension. Leverage high — it is the keystone of §4.

2. **Escalation-cascade outcome learning (close L6).** *[Dead-wire closure.]*
   Read the `auto_decision` events that `get_next_escalation_strategy` already
   emits, compute per-strategy resolution rates, and reorder the cascade (or skip
   strategies that rarely resolve a given failure class). Today the events are
   write-only. Converts a fixed heuristic into a learned policy. Feasibility
   medium (need a reader + a reorder hook); leverage medium-high (directly
   recursive — the recovery machinery learns to recover better).

3. **Confidence-weight calibration from outcomes (deepen L5).** *[Net-new on top
   of a closed loop.]* L5 already reads build history but with **fixed** penalty
   weights. Periodically fit those weights to observed tier-vs-outcome pairs
   (did "autonomous" builds actually stay clean?). This makes the one closed loop
   *learn its own gate function* — turning L5 from recursive-at-gate to
   recursive-at-meta. Feasibility medium; leverage high; **risk: this is the
   first loop that tunes its own gate stringency — must be human-reviewed
   (see §6).**

4. **Promotion-efficacy feedback (close the top of L1).** *[Net-new.]* After a
   convention is promoted, measure whether the matching drift/violation rate
   actually fell in subsequent builds. Feed that back as a promotion-threshold
   signal (MP-3 territory) and as a *demotion* trigger for promotions that didn't
   help. This is the move that makes the learner ladder genuinely recursive: the
   ladder learns which kinds of promotions pay off. Feasibility medium (needs
   before/after drift attribution); leverage high.

5. **Consume the analyzer's agent-performance trends (partial dead-wire
   closure).** *[Dead-wire closure.]* `cross-run-analyzer.ts` already computes
   agent-performance trends that no agent reads. Surface them in the architect's
   wave-assignment or the orchestrator's model/budget choices (e.g. an agent type
   trending toward more retries gets a larger default budget). Feasibility high
   (data exists); leverage medium.

6. **Cliff-pattern → machinery feedback (deepen L3).** *[Net-new.]* Today cliff
   telemetry is a human-read report. If a specific step_id cliffs across 3+
   workspaces, *mechanically* raise that step's budget or split its scope by
   default next time. Converts L3 from iterative to recursive. Feasibility medium;
   leverage medium; depends on candidate 1's metrics plumbing.

**Ranking rationale:** Candidates 1, 2, 5 are dead-wire closures — they reconnect
signal Canon *already produces*, so they are cheap and de-risked. Candidates 3,
4, 6 are net-new recursion and higher-value but require new attribution logic
and (especially 3) carry self-tuning-gate risk. The recommended sequence is
**1 → 2/5 → 3/4** : plumb the metrics first (keystone), then the two cheap
dead-wire closures that depend on it, then the two genuinely recursive net-new
loops under human review.

---

## 6. Risks (RSI-specific, for a system that edits its own principles/agents)

The article's three named risks map directly onto Canon's surface, plus two
Canon-specific failure modes the article does not cover (reward hacking,
promotion entrenchment).

- **Loss of human legibility / oversight** (article: "humans play a
  substantially diminished role"; "we can't... verify the tools we'd need").
  Canon's strongest safeguard is structural and already in place: **plan
  approval and review verdict are always-on regardless of autonomy tier**
  (CLAUDE.md tier protocol). Every recursive candidate in §5 must preserve a
  human-legible audit trail. The dead-wire-closure candidates are safe here —
  they feed *analysis*, not *auto-apply*. Candidate 3 (self-tuning gate weights)
  is the one that erodes legibility most, because it changes *why* a build was
  gated; it should emit a human-readable weight-change rationale every time it
  re-fits.

- **Compounding misalignment / runaway drift** (article: "misalignment could
  compound as models build their successors"). Canon's literal analogue:
  L8 (Canon builds Canon) editing its own agents/principles/hooks. A bad
  principle promoted into L7 changes agent behavior, which generates
  self-confirming drift signal, which the learner could read as *confirmation*
  and promote further. The promotion ladder's human gate is the firebreak —
  candidates 3 and 4, which would let outcome data move promotions/demotions
  automatically, **must not bypass it**. Recommend: outcome feedback may
  *propose* a threshold change or demotion, never *apply* one.

- **Reward-hacking the craft metric** (article does NOT cover this — Canon
  must). The craft score (L4, v2 6-dim, reviewer-judged) is a candidate
  optimization target. If any loop is ever allowed to optimize *for* craft
  score, agents/principles will drift toward whatever the reviewer-LLM scores
  highly rather than actual quality — Goodhart. The redefinition from v1
  (finding-count, killed as confounded) to v2 was the right instinct;
  the safeguard is to keep craft score **diagnostic-only**, never a direct
  optimization objective in any closed loop. Candidate 4 (promotion efficacy)
  must measure against *drift/violation reduction*, an externally-grounded
  signal, not against craft score.

- **Promotion-feedback entrenchment.** The watch→...→rule ladder with
  `weighted_instance_count` (JUDGE) weights confirming builds above neutral. A
  pattern that happens to co-occur with clean builds for unrelated reasons gets
  promoted and then *enforced*, manufacturing its own future "evidence." The
  CONSOLIDATE staleness pass + confidence decay are partial mitigations
  (promotions can decay/archive). Closing candidate 4 (efficacy feedback with a
  demotion trigger) would strengthen this — but only if demotion is symmetric
  with promotion and not itself reward-hackable.

- **Loss of the firebreak under autonomy tiers.** L5 already *mechanically*
  skips gates for high-confidence builds. Candidate 3 would let the system tune
  *how easily* it grants itself that autonomy. This is the one place Canon could
  bootstrap toward less oversight on its own. Hard recommendation: the tier
  weight-function may be re-fit but the **fitted weights must require human
  ratification before taking effect**, and "autonomous" tier must retain its
  always-on plan-approval + review-verdict floor. The system may learn to gate
  *more*, but loosening its own gate floor must stay human-ratified.

---

*End of map. This is map-first: gap analysis (§4) and ranked candidates (§5) are
the deliverables. No design or implementation planning beyond candidate framing.*
