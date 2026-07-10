<!-- Persisted from .canon/history/fresh-architect-review-of-claude-code-workflow-tool — explore flow 2026-06-07; competition: 3 proposals, 3 judges, synthesis ratified at HITL -->
# SYNTHESIS — Unified Workflow-Tool Integration Design

> Synthesis architect, post-panel. This document supersedes PROPOSAL-A/B/C for
> decision-making; the proposals remain as appendices. Sources: all three proposals,
> all three judge reports, CAPABILITY-REVIEW.md, workflow-tool-spec.md.

> **Superseded re: agent teams (2026-07-10).** `TeamCreate`/`TeamDelete` were removed at
> harness v2.1.178; this exploration set predates that and its TeamCreate references are
> historical. Live dispatch is the implicit-team model — see `references/dag-execution-protocol.md`.

## 1. Verdict

**Final ranking: B > C > A.** Two judges (richness, shippability) rank B first; the
coherence judge ranks C first but explicitly frames B and C as "a sequencing
disagreement, not an architecture disagreement." Judge 2's composite recommendation —
**"B now, C's compiler/runner (M5) as a later evidence-gated option"** — is adopted as
the trunk of this synthesis, strengthened by C's infrastructure grafts and A's three
salvageable mechanisms.

**Why B wins the trunk:** the only proposal whose features are dominated by capabilities
Canon cannot express today (exhaustive adversarial finding verification, convergent
sweeps targeting the named watch_WWWWWW1 defect, user-invocable diagnostics); every
increment verified against the live codebase; first three increments safe even if the
A1 probe fails; rollback by one-field deletion; smallest blast radius.

**Why C shapes the endgame:** A and C independently converged on one-trusted-runner +
compiled-plan-as-`args` from different philosophies — meaningful evidence the shape is
sound. C's version is the disciplined one: gates promoted to the segmentation function,
supervised tier honestly carved out, compiler deferred until its golden-test fixtures
(the special-purpose workflows) exist, cleanest resume/cache-invalidation reasoning in
the field.

**What disqualified A:** unanimous third, and capped by Judge 3 for an actual
constraint-ledger #2 violation: A's runner (`reviewFixLoop`, §3.3) computes the review
verdict in code and auto-runs fix iterations **before any human sees the initial
verdict** — confirmed by A's own killer-demo step 7, where the user is shown only the
post-fix WARNING, never the BLOCKING(2). Both rival teams independently avoided this
shape. Compounding handicaps: Judge 1 found the inventory "re-plumbing, not features";
Judge 2 found "a cliff dressed as a ramp" (Increment 1 secretly requires the runner, IR
schema, and ingest tool — the three largest artifacts) plus supervised-tier compilation
against prior-art arithmetic. **In-segment auto-fix ahead of the initial review verdict
is REJECTED in this synthesis, permanently.** When the endgame compiler is built, it
inherits A's own (ironically self-defeated) invariant: refuse to emit any plan not
segmented at both mandatory gates.

**Ratified:** the user answered the §7 questions at the 2026-06-07 HITL gate; decisions
are folded in throughout and recorded in §8. Headline deltas: default-on adoption
confirmed; the supervised carve-out is a standing posture revisitable at the Inc-7
decision (the mandatory-gate invariant stays permanent); the endgame remains a fresh
future decision; three long-tail features are rescued into the portfolio (only
`canon-flaky-hunt` stays cut).

## 2. Settled facts (unanimous 3-team convergence — treated as decided)

1. **No generated code; args-as-data.** All workflows are hand-written, versioned,
   code-reviewed, CI-linted plain-JS files; per-build variation flows exclusively
   through `args`. Model-generated script text is never executed.
2. **HC-1 (worktrees):** the `isolation:'worktree'` flag is banned (CI lint + schema).
   Parallel code-writers use the worker-prompt pattern — agent-created
   `canon-task/{task_id}` worktrees from `base_commit` — and a dedicated **merge-agent
   node** runs the existing alphabetical `--no-ff` protocol with per-file diff
   verification; conflicts early-return to the existing merge-conflict HITL.
3. **HC-4 (opt-in):** three stacked channels — skill instruction (spec-sanctioned) +
   plan-approval gate carrying an explicit per-build consent line + named-workflow
   invocation. Consent recorded in the gate record; "no workflows" degrades every
   workflow-backed step to plain spawns.
4. **Single-writer journal ingestion** at notification time; agents never touch
   journal.json/orchestration.db; two journals, one grain each, cross-keyed by `runId`.
5. **Count-based bounds** replace the escalation cascade's 2-minute wall clock inside
   scripts (no clock in the sandbox).
6. **Probe-first sequencing:** A1 (hooks fire in workflow agents?), A2 (frontmatter
   allowlists honored?), A3 (Bash/git available?) settled empirically before any
   feature depends on them.
7. **TeamCreate demotion** for deterministic fan-out; `debate` steps stay on teams
   (workflow agents lack SendMessage channels); `compete` maps to the judge-panel
   pattern.
8. **Schema contracts** (typed status/findings/verdict/coverage) are the single
   highest-leverage item; they ship standalone value (the typed-status Tier-2 epic
   item) even if no workflow ever runs.
9. **`canon-tail` first:** the mandatory tail is the unanimous first live workflow —
   lowest-risk, most-rigid region; complements (never replaces) the X4 Stop-hook floor.
10. **HC-5 (enrichment):** freeze-or-scout — static enrichment frozen at invocation;
    live state fetched by scout `agent()` nodes whose cached results reproduce
    downstream prompts deterministically on resume.

## 3. Unified design

### 3.1 Trunk (Proposal B): the saved-workflow library

A portfolio of hand-written plain-JS workflows in the plugin repo at `workflows/`
(installed to `.claude/workflows/`), each parameterized by a **standard args envelope**
the orchestrator freezes at invocation (hybrid scouting). Five thin contracts unify the
library: the args envelope, the schema library, the node contract (scripts choreograph;
agents effect; consolidators write artifacts via existing MCP write tools), the journal
mapping, and the null-policy table (finder null → drop+log; refuter null → abstain;
code-writer null → `failures[]`; consolidator null → orchestrator fallback). CI gate:
`node --check`, meta-literal lint, banned-API lint (`Date.now`/`Math.random`/argless
`new Date()`/TS syntax), and `isolation:` grep-ban.

Runbook steps select workflow backing via an `engine:` field (vocabulary minor bump) —
with the **polarity flip** decided in adjudication (b) below.

### 3.2 Grafts from C (infrastructure depth)

- **`ingest_workflow_run` (replaces B's coarse F12).** New MCP tool: at notification
  time, expands the workflow's structured return into per-step journal entries with
  `runId` cross-references, runs artifact-presence checks, and validates skip reasons
  against the closed vocabulary at write time. Single writer — dissolves the journal
  write race (supervised-build-quality.md:179) in workflow regions by construction.
  Mechanical drift detection: node count vs journal entries at ingestion.
- **Resume/gate separation rule (library authoring law).** Gate answers may ONLY
  parameterize the next invocation's args; `resumeFromRunId` is reserved exclusively
  for unchanged-args intra-run failure recovery. The two mechanisms never interact —
  cache-invalidation reasoning stays trivial.
- **Version handshake.** Every library workflow checks `args.envelope_version` first
  and returns structured `INCOMPATIBLE_ARGS` on skew (plugin-shipped scripts vs an
  orchestrator composing envelopes from a different Canon version).
- **runId-aware `reconcile_workspace`.** Cliff entries for workflow-backed steps carry
  the `runId`; the surfaced HITL offers "resume run" as the first disposition.
- **Probe as standing canary.** `canon-probe` is a saved, re-runnable workflow executed
  after every harness upgrade — harness evolution is the library's top residual risk
  and this is its cheapest detector.
- **Evidence-gated increments.** Explicit promotion gates between increments ("3 green
  tail runs with clean journals", "REVIEW.md parity vs current protocol") instead of
  calendar sequencing.

### 3.3 Grafts from A (salvaged mechanisms)

- **Provenance audit at ingest (A's F11).** Deterministic notification-time checks:
  commit trailers present, declared artifacts exist on disk, committed paths ⊆ declared
  file lists. Compensates the A1-false world; a strict upgrade over the warn-only
  trailer hook even if A1 is true.
- **Env-snapshot path indirection (A's F9).** Large preloads/context snapshots are
  written to immutable per-invocation files under `${WORKSPACE}/…/env/`; the envelope
  carries *paths*. Keeps args small, prompts byte-stable, and hedges the unspecified
  args-size ceiling.
- **Forward-only HITL answers + mandatory-gate compiler invariant.** Forward-only
  answers merge into C's resume/gate law (same rule). The compiler invariant — refuse
  to emit any plan not segmented at plan-approval AND initial-review-verdict — is
  adopted verbatim for the endgame compiler.

### 3.4 Endgame (C's M5): generic compiler/runner — LATER, evidence-gated

`compile_segments` (pure MCP function: runbook + task-dag + G1–G9 fields + tier →
validated SegmentPlan JSONs) + `canon-run` (one permanently-trusted generic runner),
for **autonomous and light-touch tiers** (supervised stays orchestrator-driven for
checkpointed regions throughout Increments 0–6 — B/C consensus against A). Per §8 Q2,
this carve-out is the **standing posture, not a permanent invariant**: the Inc-7 fresh
decision may reconsider compiling supervised regions *between* gates. What remains
permanent regardless is the mandatory-gate compiler invariant (§3.3) and the rejection
of in-segment pre-verdict auto-fix (§1). The library workflows become the compiler's
golden-test fixtures.

**Concrete evidence gate — ALL of the following before the endgame is started:**
1. `canon-tail`, `canon-review-verify`, and `canon-waves` each green on **≥3 real
   builds** with clean `ingest_workflow_run` journals (no reconciliation drift).
2. A1/A2 probe matrix green (or contingencies explicitly accepted by the user).
3. **Adoption proof:** workflow-backed execution used on the majority of eligible
   builds over the observation window (measured by the finalize check in adjudication
   (b)) — no compiler for a library nobody runs.
4. Probe canary green across **≥1 harness upgrade cycle** (Workflow surface stability
   demonstrated).
5. A fresh user go-decision at that time (§8 Q3). That decision's scope explicitly
   includes reconsidering supervised-region compilation between gates (§8 Q2).

## 4. Adjudications

### (a) Reconciled review workflow — confirmation fast path + uncapped neutral probes

Judge 1 crowns B's adversarial-verify flagship; Judge 3 correctly objects that
default-refute skeptics over *every* finding delete the 2-reviewer confirmation path
and bias the mandatory gate's inputs toward suppression. **Reconciled design:**

1. Reviewer fan-out per partition with `ReviewFindings` schema (B, unchanged).
2. **Dedup + verdict in script code** (see (c)): findings keyed by
   `file|principle|line`.
3. **Confirmation fast path RESTORED:** findings reported by 2+ reviewers are
   confirmed directly — no refuters (today's semantics, kept).
4. **Minority findings: probe ALL of them** (B's coverage upgrade — the top-5 cap is
   lifted), but with a **neutral evidence prompt** ("verify whether this finding is a
   true positive; report CONFIRMED or DISMISSED with evidence" — the existing Canon
   minority-probe wording), NOT "default to refuted=true". Default-refute is reserved
   for `canon-sweep`/security harnesses, where finder over-production is the known
   failure mode.
5. Refuter count is a tier-scaled `params` knob (1 at autonomous spot-check, 3 at
   thorough); refuter null → abstain → surfaces as Unverified, never silently counted.
6. The verdict gate therefore sees confirmed + minority-verified + dismissed-with-
   reasons + abstained — strictly **more** information than today, with no suppression
   bias. Ships with a before/after probe table (cost, wall-clock, findings survived)
   per the empirical-comparison discipline.
7. The review→fix loop stays **orchestrator-driven across iterations** (B's reading —
   the verdict gate sits inside the loop). The endgame compiler may later compile the
   fix loop only as C does: a separate post-gate segment parameterized by the user's
   verdict-gate answer.

### (b) Enforcement of adoption — flip the polarity, audit the opt-out

B's fatal flaw: `engine: workflow:*` is remembered, not enforced — reproducing the L1
drift class one layer up. **Mechanism chosen: default-on with audited opt-out**
(ADOPTED at HITL — §8 Q1).

1. **Vocabulary default:** eligible step types (initially `review` and the tail; later
   `sweep`, `implement-waves`) carry their workflow engine as the *default* in the
   runbook vocabulary/template. Omission means workflow-backed. The architect opts OUT
   with `engine: direct` plus a stated reason — inverting the memory burden.
2. **Deterministic backstop:** `finalize_workspace` gains a check that flags any step
   executed direct while a registered workflow backend existed (surfaced exactly like
   ghost steps today). This is also the adoption counter feeding endgame gate #3.
3. **Advisory L1 hook parity:** the existing dag-dispatch-guard pattern extends to warn
   when the orchestrator raw-spawns an agent for a step type with a registered backend.
4. Consent unchanged: the plan-approval gate's consent line still gates the *build*
   (HC-4); the engine default selects the *steps*. The two compose (Judge 3 graft #4).

### (c) Verdict-in-code (not consolidator-agent-computed)

Judge 2's identified determinism leak in B's flagship is fixed: dedup, the
confirmation/minority split, and the worst-case verdict are computed as **literal JS in
the script** (C's F5 / A's F5 shape). The consolidator agent receives the computed
verdict and findings and only *writes* REVIEW.md via `write_review` from those inputs.
The script's structured return carries the verdict the orchestrator routes on;
`ingest_workflow_run` cross-checks that REVIEW.md's verdict equals the computed one
(mechanical drift detection). The mandatory gate's critical path contains no LLM
between findings and verdict.

### (d) Long-tail dispositions — "no workflow without a consumer"

Admission rule adopted: a workflow ships only with its wire (command, runbook default,
or named gate) in the same increment. Against Canon's documented built-but-never-wired
defect class (evaluate_step, OutcomeStore). The synthesis originally cut/deferred four
items; **at HITL the user rescued three of them** (§8 Q4) — each rescue satisfies the
admission rule by naming its wire in its increment:

| B feature | Disposition (post-HITL) | Rationale / wire |
|---|---|---|
| F11 `canon-flaky-hunt` | **CUT** (stands) | No named Canon defect; spec demo-ware; no consumer. |
| F5 `canon-compete` | **RESCUED** (§8 Q4) → Inc 5 | Wire: the orchestrator's compete dispatch for explore/design-flow competitions (precedent: this very session's manual ceremony becomes one call). |
| F9 `canon-learn-mine` | **RESCUED** (§8 Q4) → Inc 5 | Wire: the every-build mandatory learn step consumes its pre-scored proposals; engine default flips per adjudication (b) after 3 green runs. |
| F13 cron maintenance | **RESCUED** (§8 Q4) → `canon-maintenance`, Inc 6 | Wire: CronCreate schedule registered at plugin init. Guardrails (prior roadmap): scheduled *maintenance* only (scribe/janitor/re-index), draft-PR + notify, **never silent merge**. Headless MCP-auth caveat mitigated: ships only after `canon-probe` is extended to cover headless MCP availability (A3-headless) and returns green. |
| F11 `canon-diagnose` | **KEPT** | Wires to the existing `/canon:diagnose` command — consumer already exists. |
| F6 `canon-security-audit` | **KEPT, late** | Security is a real runbook step type (existing wire); ships after the review workflow proves the pattern. |
| F7 `canon-migrate` | **GENERALIZED** into `canon-waves` | Answers Judge 1's fatal-flaw attack on B (ordinary multi-task implement untouched) without the compiler: one saved workflow taking task-dag-shaped args, worker-prompt worktrees, merge-agent node. TeamCreate demoted to fallback — closes the standing degrade-gracefully TODO. |

## 5. Feature inventory (final, ranked)

| # | Feature | Source | Effort | Leverage | Increment |
|---|---------|--------|--------|----------|-----------|
| 1 | Schema library (status/findings/verdict/coverage) + typed terminal-write enums | B-F1 / C-F3 / A-F3 | S | Very high | 1 |
| 2 | `canon-probe` standing canary (A1/A2/A3 + name-resolution + schema∘agentType) | C-F12 (re-runnable form) | S | Prerequisite | 0 |
| 3 | Args envelope spec: version handshake, env-path indirection, resume/gate law | B-§3.2 + C + A-F9 | S | High (enabler) | 1 |
| 4 | `canon-tail` saved workflow | B-F4 / C-F11 | S | High | 2 |
| 5 | `ingest_workflow_run` single-writer journal ingestion + provenance audit | C-F8 + A-F11 | M | Very high | 2 |
| 6 | runId-aware `reconcile_workspace` disposition | C graft | S | Med | 2 |
| 7 | `canon-review-verify` (reconciled per adjudications a+c) | B-F2 + C-F5 + J3 graft | M | Very high | 3 |
| 8 | Engine default-on + finalize adoption check + advisory hook | Adjudication (b) | S | High | 3 |
| 9 | Background UX + HITL catalog verbs (skip agent, stop run) | B-F10 | S | Med-High | 3 |
| 10 | `canon-sweep` wired to `/canon:check` (fixes watch_WWWWWW1) | B-F3 | M | Very high | 4 |
| 11 | `canon-diagnose` named workflow | B-F11 (kept half) | S | Med | 4 |
| 12 | `canon-waves` general DAG implement substrate; TeamCreate → fallback | B-F7 generalized + C-F4 | L | High | 5 |
| 13 | `canon-rereview` (N-skeptic post-CLEAN re-review, supervised) | B-F8 | S | Med-High | 5 |
| 14 | `canon-compete` judge-panel competition backend (wire: compete dispatch in explore/design flows) | B-F5 (rescued §8 Q4) | M | Med-High | 5 |
| 15 | `canon-learn-mine` (wire: every-build mandatory learn step consumes pre-scored proposals) | B-F9 (rescued §8 Q4) | M | Med | 5 |
| 16 | `canon-security-audit` harness | B-F6 | M | Med | 6 |
| 17 | `canon-maintenance` scheduled hygiene (wire: CronCreate; draft-PR + notify only, never silent merge) | B-F13 (rescued §8 Q4) | S | Low-Med | 6 |
| 18 | `compile_segments` + `canon-run` endgame (autonomous/light-touch at minimum — supervised-region compilation reconsidered at the Inc-7 decision per §8 Q2; mandatory-gate invariant permanent) | C-F1/F2/M5 + A invariant | L | Very high (deferred) | 7 (evidence-gated) |

Cut: `canon-flaky-hunt` (no consumer); A's supervised compilation *as proposed* and the
in-segment pre-verdict fix loop (rejected permanently). All previously deferred items
rescued per §8 Q4.

## 6. Build order

Probe-first; every increment independently shippable; rollback per increment = delete
the engine-field default / the workflow file (no state migration anywhere before Inc 7).

| Inc | Ships | Promotion gate to next |
|-----|-------|------------------------|
| **0** | `canon-probe` + CI lint for `workflows/` (parse, meta-literal, banned APIs, no `isolation:`) | Probe matrix documented in `references/`; contingency branch selected if A1/A2 false |
| **1** | Schema library + args envelope spec (handshake, path indirection, resume/gate law) | Schemas adopted by terminal-write tools (standalone value — lands even if no workflow ever runs) |
| **2** | `canon-tail` + `ingest_workflow_run` v1 + provenance audit + runId-aware reconcile | **3 green tail runs with clean journals** (no ingestion drift, trailers verified) |
| **3** | `canon-review-verify` (reconciled) + engine default-on + finalize adoption check + background UX/HITL verbs | **REVIEW.md parity vs current protocol on real builds** + before/after cost probe table |
| **4** | `canon-sweep` → `/canon:check` + `canon-diagnose` | Sweep convergence demonstrated on a known-violation corpus; under-detection vs current single-agent measured |
| **5** | `canon-waves` (probe-A1-true + merge-agent validated in Inc 2/3 runs) + `canon-rereview` + `canon-compete` (wire: orchestrator compete dispatch for explore/design flows) + `canon-learn-mine` (wire: mandatory learn step; engine default flips per adjudication (b) after 3 green runs) | **Multi-task DAG build merged clean end-to-end**; TeamCreate fallback exercised once; one real competition run through `canon-compete` with judge parity vs the manual ceremony |
| **6** | `canon-security-audit` + `canon-maintenance` (wire: CronCreate schedule; scheduled maintenance only — scribe/janitor/re-index; draft-PR + notify, never silent merge). Precondition for maintenance: `canon-probe` extended to headless MCP availability (A3-headless) and green | Maintenance: first scheduled run produces a draft PR + notification only — zero unattended merges observed |
| **7** | Endgame compiler/runner (§3.4); decision scope includes supervised-region compilation between gates (§8 Q2) | Gated on ALL five evidence conditions in §3.4, including fresh user go-decision (§8 Q3) |

**Near-term commitment: Increments 0–3.** These are safe under the worst-case A1
outcome (no code-writing agents in workflows until the probe passes — the tail's
scribe/shipper nodes are the first, and Inc 2's gate verifies them), deliver the two
Very-high-leverage items (schemas, reconciled review), and produce the adoption data
the endgame decision needs. Increments 4–6 proceed on their gates; Increment 7 is a
separate future decision.

## 7. Open questions for the user (RESOLVED at the 2026-06-07 HITL gate — see §8)

1. **Adoption polarity (adjudication b):** default-on vs opt-in-first?
   → **Resolved: default-on adopted** (§8 Q1).
2. **Supervised tier — permanent posture:** confirm the carve-out as standing position?
   → **Resolved: revisit at endgame** — standing posture for Inc 0–6, reconsiderable
   at the Inc-7 decision (§8 Q2).
3. **Endgame commitment level:** committed roadmap item vs fresh decision later?
   → **Resolved: fresh decision later, as recommended** (§8 Q3).
4. **Cut-list confirmation:** any cut/deferred features to rescue?
   → **Resolved: all three rescued** (canon-compete, canon-learn-mine, cron
   maintenance); only canon-flaky-hunt stays cut (§8 Q4).

## 8. Decision record (2026-06-07 HITL)

| Q | Decision | Disposition vs recommendation |
|---|----------|-------------------------------|
| **Q1 Adoption polarity** | **Default-on adopted.** Eligible steps default to their workflow engine; `engine: direct` is the audited opt-out with a stated reason; `finalize_workspace` audits opt-outs. | As recommended. |
| **Q2 Supervised tier** | **Revisit at endgame.** Supervised stays orchestrator-driven for ALL increments 0–6, but the Inc-7 endgame decision is explicitly allowed to reconsider compiling supervised regions *between* gates. This does NOT weaken the mandatory-gate compiler invariant, which remains permanent (as does the rejection of in-segment pre-verdict auto-fix). | **Deviates:** the supervised carve-out is a standing posture, not a permanent invariant. §3.4 and the §5/§6 endgame rows amended accordingly. |
| **Q3 Endgame commitment** | **Fresh decision later.** Inc 7 is a separate future decision taken only when the 5-condition evidence gate (§3.4) is met. | As recommended. |
| **Q4 Cut list** | **All three deferred/cut-for-leverage features RESCUED** — the user wants the feature-rich portfolio: `canon-compete` (Inc 5; wire: compete dispatch in explore/design flows — precedent: this session), `canon-learn-mine` (Inc 5; wire: the every-build mandatory learn step), and cron maintenance as `canon-maintenance` (Inc 6; wire: CronCreate; guardrails: scheduled maintenance only — scribe/janitor/re-index, draft-PR + notify, never silent merge; headless MCP-auth caveat mitigated by extending `canon-probe` to headless MCP availability before ship). Only `canon-flaky-hunt` stays cut. | **Deviates:** portfolio expanded. The "no workflow without a consumer" admission rule is honored — each rescued feature names its wire in its increment (§4d, §5, §6). Increments 0–3 remain the unchanged near-term commitment. |

---

### Status

DONE

**Artifact:** `docs/explore/workflow-integration/SYNTHESIS.md`

**Summary:** Unified design: B's saved-workflow portfolio (schema library, args
envelope, canon-tail, reconciled canon-review-verify, canon-sweep, canon-waves) as the
trunk; C's single-writer `ingest_workflow_run`, resume/gate separation law, version
handshake, runId-aware reconcile, and standing probe canary grafted in; A's provenance
audit, env-path indirection, and mandatory-gate compiler invariant salvaged; C's
generic compiler/runner retained as an Increment-7 endgame behind a five-condition
evidence gate (including measured adoption and harness-stability proof). Four
adjudications resolved: review workflow keeps the 2-reviewer confirmation fast path and
probes ALL minority findings with neutral (not default-refute) prompts; adoption
enforced by default-on engine fields with finalize-audited opt-out; verdict computed in
script code with the consolidator demoted to writer; long-tail dispositions governed by
the "no workflow without a consumer" admission rule. A's in-segment pre-verdict
auto-fix is rejected permanently. **Amended 2026-06-07 post-HITL (§8):** default-on
adoption ratified; supervised carve-out reframed as a standing posture reconsiderable
at the Inc-7 decision (mandatory-gate invariant permanent); endgame confirmed as a
fresh future decision; canon-compete and canon-learn-mine rescued into Inc 5 and cron
maintenance into Inc 6 (guardrailed: maintenance-only, draft-PR + notify, headless-MCP
probe precondition) — only canon-flaky-hunt stays cut. Near-term commitment:
Increments 0–3, unchanged.
