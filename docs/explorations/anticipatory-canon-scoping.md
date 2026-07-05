# Anticipatory Canon — Scoping

**Status:** exploration / decision aid (not a spec, not a build)
**Date:** 2026-07-05
**Origin:** LoopWM ("Looped World Models") paper, reframed by the user: *a repo is a world — it has state, it evolves, and it is reactive to external systems.*

```
ASSUMPTIONS:
1. The transfer from LoopWM is CONCEPTUAL (predict-then-plan, adaptive depth, bounded
   error), NOT architectural. Canon's "latent" is a discrete symbolic graph + JSONL
   store — there is no continuous transition matrix, so the paper's spectral-norm
   contractiveness mechanism has no faithful counterpart. Any design that puts
   eigenvalues/spectral machinery on the KG is out of scope by construction.
2. The goal of this scoping is to decide whether "anticipatory" is a real capability
   gap worth closing, not to justify a subsystem. A "reacting is fine" verdict is a
   valid deliverable.
3. Scope is the existing surfaces only — no new persistence layer, no new daemon.
→ Correct these before reading the verdicts below; they shape everything.
```

## 1. Origin & framing

The reframe is genuinely productive. In the world-model frame, Canon **already runs a latent
model of the repo**: the knowledge graph + drift store + context-manifest + journal/board are
its state estimate. Three of the paper's ideas map cleanly onto things Canon already has:

| World-model concept | Canon counterpart (already exists) |
|---|---|
| Compounding prediction error | **Staleness** — KG age, doc-freshness, manifest drift (this session's SessionStart pulse: "KG 46h old, 260 commits since last scribe") |
| Contractiveness (force latent back toward truth) | **context-manifest-freshness gate** (`hooks/context-manifest-gate.sh`, PR #448) — fail-closed on corpus drift |
| Observation encoder for exogenous dynamics | **Loops** (`loops/ship-watch.md` et al.) — read-only observers of CI, releases, PR comments, `main` |

The gap the frame exposes: a world model's defining move is **rollout + plan against a predicted
future**. The claim under test is that **Canon is reactive, not anticipatory** — it observes
current state and acts, rather than simulating "if I dispatch this build, here is the predicted
end-state N steps out" and planning against that.

The rest of this document tests that claim against the actual code. The short version: **the
claim is half-right, and the half that's wrong is the important half.**

## 2. What already exists (file-grounded inventory)

### 2a. Endogenous prediction — already present, and stronger than the framing admits

- **`analyzeBlastRadius`** (`mcp-server/src/graph/kg-blast-radius.ts:442`) — a **depth-bounded
  transitive rollout on the dependency graph** (`maxDepth` default 3, `by_depth` histogram).
  This is literally "predict the consequence of changing file X, bounded to N steps." It takes a
  **file list**, not a diff — so it can be run on *predicted* files, not only realized ones.
  This is the closest thing Canon has to the paper's bounded rollout, and it already exists.

- **`compute_autonomy_tier`** (`mcp-server/src/features/orchestration/tools/compute-autonomy-tier.ts`
  + `services/confidence-scorer.ts`) — **pre-dispatch risk prediction.** Before a build runs, it
  forecasts how much supervision it needs from: `build_history.recent_failure_rate` /
  `avg_retry_count` (historical priors), `blast_radius.total_affected_files` / `max_depth`
  (structural rollout), and `compliance`. This is anticipatory by any honest definition — it
  predicts a build's risk from history + structure *before the first line is written*, and
  changes gate behavior accordingly. The framing's "Canon only reacts" is already false here.

- **The architect** already owns endogenous prediction operationally. Per
  `agent-context-budget-dispatch` (rule) and `feedback_architect_owns_execution_strategy`, the
  architect estimates blast radius and input complexity from `get_file_context` / `codebase_graph`
  and **plans the dispatch strategy (subagent vs team, wave partition) against that prediction**
  before any code exists. That is predict-then-plan, today.

- **`show_pr_impact`** (`mcp-server/src/features/pr-review/tools/show-pr-impact.ts`) — blast
  radius, hotspots, subgraph, and **co-change warnings** (`computeCoChangeWarnings`, line 400:
  "files in the diff whose frequent co-change partners are NOT in the diff"). Co-change warning
  is a genuine *prediction* ("you probably also need to touch Y") — but it fires **at review
  time, on a realized diff**, i.e. reactively, not at plan time.

### 2b. Divergence measurement (the "prediction error" surface) — present

- **`get_drift_report`** (`mcp-server/src/features/diagnostics/tools/get-drift-report.ts`) folds
  in `computeDocFreshness` — model-vs-world divergence, surfaced with confidence tiers.
- **`hooks/context-manifest-gate.sh`** — the contractiveness mechanism: fail-closed when the
  committed manifest diverges from the live corpus.
- SessionStart pulse (`hooks/canon-agent-teams/session-start-*.sh`) — surfaces staleness at
  session open.

### 2c. Exogenous observation — present but **strictly after-the-fact**

- **Loops** (`loops/ship-watch.md`, `harness-watch.md`, `session-watch.md`) — read-only,
  transition-triggered observers of the world Canon does not control (CI, releases, PR comments).
  By construction they observe *what already happened* (dc-06, `mutates_build: false`).
- **Reactive patches for a moving `main`:**
  - The base-advance mergeability check (root `CLAUDE.md` → Completion Checklist → Ship →
    "Pre-push mergeability check", watch_YYYY1) — reacts *after* a long build when `origin/main`
    has advanced under it.
  - The Doc-file conflict pre-check (root `CLAUDE.md` → Step Enforcement Contracts) — a mid-build
    reaction to `**/CLAUDE.md` churn on `main`.

  Both are the signature of a reactive system: they patch a world that *already* moved. A
  predictive system would **expect** `main` to advance during a 40-minute build and plan for it.

## 3. Capability delta

Putting 2a–2c together sharpens the claim considerably:

> **Endogenous prediction (the blast radius of my *own* change) is already Canon's — the
> architect and `compute_autonomy_tier` both predict-then-plan against it today. The genuinely
> reactive-not-anticipatory surface is the *exogenous* world: `main` advancing, concurrent
> sessions, CI — and there Canon reacts after the fact every time.**

So the honest capability delta is **not** "Canon can't predict." It is narrower and more real:
**Canon does not roll the *exogenous* state forward.** The one future it cannot control but
could cheaply forecast — where `origin/main` will be when this build tries to merge — it instead
discovers by collision.

That reframe matters because it kills the grand version of the idea. There is no faithful
"imagine a multi-step trajectory and re-plan against it" for Canon, because a Canon dispatch is a
*single planned action* (a runbook), not a trajectory the orchestrator iteratively re-plans. The
only real "rollout N steps" in Canon's world is **the exogenous clock advancing** — and that is
one variable, not a latent vector.

## 4. Candidate mechanisms

Four candidates, each ruled real or cute. Two survive, and one of the two is thin.

### M1 — Plan-time exogenous-conflict forecast  ·  **REAL (thin)**

- **Predicts:** which files this in-flight build will touch that `origin/main` is *also* likely
  to advance during the build window → probable merge conflict / wasted verify+review cycle.
- **Consumes:** the architect's declared `files:` (task-plan frontmatter), the git-intel
  `co_change_edges` + commit-frequency intel already in the KG (`ensureGitIntelFresh`), and
  `git rev-list {base}..origin/main` velocity.
- **Hooks in:** after the architect produces the runbook/task-dag, before dispatch (plan-approval
  HITL). Surfaces "files A, B are hot on `main` right now; expect a re-merge" as advisory.
- **Feasibility:** MEDIUM-HIGH — every input already exists; it's an orchestrator-side read +
  one advisory line.
- **Verdict — REAL but modest.** It converts the two existing *reactive* patches (watch_YYYY1,
  doc-conflict pre-check) into a plan-time *warning*. Honest caveat: the base-advance merge is
  cheap and deterministic *when* it happens, so the only value is avoiding a wasted
  verify+review cycle on the unlucky builds. Worth a cheap advisory; **not** worth a subsystem.

### M2 — Predicted-gate-failure pre-flight  ·  **CUTE (kill)**

- **Predicts:** which deterministic gates (dead-wire, manifest-freshness, phantom-claim) the
  planned change will trip, *before* the engineer writes code.
- **Verdict — over-engineered reframe.** The gates are already deterministic and cheap, and they
  run at the correct time (post-implement — you cannot run dead-wire on code that doesn't exist).
  "You'll add an export, so dead-wire might fire" merely restates the task plan. Reacting is
  correct here. **Kill.**

### M3 — Predicted-blast-radius runbook  ·  **REAL but MOSTLY ALREADY DONE**

- **Predicts:** the blast radius / review partition of the change from the architect's *declared*
  files, before implementation — to pre-size the review team and pick dispatch strategy.
- **Verdict — the capability is genuine, but Canon already has it.** `analyzeBlastRadius` takes a
  file list, and the architect already runs blast/complexity estimation to choose dispatch
  (`agent-context-budget-dispatch`, team fan-out threshold in root `CLAUDE.md`). The only *missing*
  sliver is making that prediction an explicit orchestrator-visible signal at plan-approval rather
  than implicit in the architect's reasoning. That's a surfacing tweak, not a new capability.
  **Fold the sliver into M1's plan-approval advisory; do not build separately.**

### M4 — Staleness-as-prediction-error "divergence budget"  ·  **CUTE (kill)**

- **Predicts:** nothing new. Unifies doc-freshness + KG age + manifest drift into a single
  "model divergence" number with a pre-dispatch threshold.
- **Verdict — this is the *strongest conceptual* transfer from the paper (contractiveness), which
  is exactly why it's tempting and exactly why it adds nothing executable.** The context-manifest
  gate already *forces* freshness fail-closed; the SessionStart pulse already *surfaces* it. A
  unified budget is a dashboard, not a capability. **Kill.**

## 5. Recommendation

**Pursue narrowly, or not at all — and be clear that the grand version is dead.**

The world-model reframe earns its keep as an *analysis lens* (it correctly located the one real
gap: exogenous-state rollout). It does **not** justify a predictive-planning subsystem, because:
- endogenous prediction already exists (`compute_autonomy_tier` + architect dispatch planning);
- there is no faithful multi-step rollout for a single-action dispatch;
- the only genuine exogenous variable (`main` advancing) is cheaply *reacted to* today, and the
  reaction is deterministic when it fires.

If we want to prove-or-kill the anticipatory thesis cheaply, there is exactly one increment worth
running:

### Inc-0 — Plan-time base-advance advisory (proves or kills the thesis for ~1 build's cost)

- At the plan-approval HITL, before dispatch, the orchestrator computes:
  1. `git rev-list {base_commit}..origin/main --count` (is `main` moving?),
  2. the intersection of the architect's declared `files:` with (a) files changed on
     `origin/main` since `base_commit` and (b) their `co_change_edges` partners.
- Surface a one-line advisory: *"N commits landed on main since base; files X, Y in this build
  overlap recent/co-changing main churn — expect a re-merge."* Advisory only — never blocks.
- **Rides entirely on existing surfaces** (git-intel `co_change_edges`, `rev-list`, architect
  `files:`). No new tool, no new persistence — one orchestrator-side computation + one runbook
  line at the existing plan-approval gate.
- **Kill criterion:** if, over a handful of real builds, the advisory never fires *or* never
  changes what the user/orchestrator does (they'd have merged-and-reacted just as cheaply), the
  anticipatory thesis is falsified for Canon and we stop. If it repeatedly saves a wasted
  verify+review cycle, promote it from advisory to a real pre-dispatch signal.

Everything beyond Inc-0 (M2, M3-as-subsystem, M4) is cut.

## 6. Open questions for the user

1. **Framing fork — efficiency vs research.** Inc-0 serves a concrete efficiency goal (fewer
   wasted verify+review cycles from base-advance collisions). If the real intent is to explore
   "predictive planning" as a *research direction*, this document's honest finding is that there
   is no cheap faithful transfer — the grand rollout has no counterpart in a single-action
   dispatch model. **Which are we after?** (This changes whether Inc-0 is the deliverable or just
   a consolation prize.)

2. **Is even Inc-0 worth it, given endogenous prediction is already covered?** The sharpest
   finding here is that the "Canon is reactive" claim is *already false* for endogenous risk
   (`compute_autonomy_tier`) and only true for exogenous `main`-advance — which Canon reacts to
   *cheaply and deterministically*. Reasonable verdict: **"reacting is fine; ship nothing."**
   Do you want the thin advisory, or is the correct answer that the reframe was a good lens that
   produced no build?

3. **Scope of "exogenous."** Inc-0 addresses `main` advancing. The other exogenous variables —
   concurrent sessions (already handled by the `.lock` mutex + `active_workspaces` registry) and
   CI (handled by ship-watch, after the fact) — are out of Inc-0's scope. Confirm you don't want
   those folded in (I recommend not — the mutex and loops already cover them adequately).

---

### Status

HAS_QUESTIONS — the scoping is complete and the verdicts are firm (M2/M4 killed, M3 folded, M1
survives as a thin Inc-0), but there is a genuine fork at the top: whether the deliverable is the
narrow efficiency advisory (Inc-0) or the honest "reacting is fine, ship nothing" conclusion.
That is a product-intent call I should not make for you. The three questions in §6 are the forks;
Q1 and Q2 are the load-bearing ones.
