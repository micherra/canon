---
title: Reviewer-as-Measured-Step-Runtime (Design Spike)
type: design-spike
status: complete
slug: design-spike-reviewer-as-measured-step-runtime-pilot-design-a-per
design_only: true
---

# DESIGN — Reviewer-as-Measured-Step-Runtime (Design Spike)

> **Approval amendment (2026-07-05, plan-approval gate).** The user approved this spike with one governing override to the topology recommendation: the implementing build starts at **topology C (1× — single-agent reviewer + per-stage metrics/attribution)**, NOT the ~6× per-stage-spawn (topology A) this document recommends. Rationale: prove attribution value at 1× first; only escalate to spawn-based isolation (topology B/A) if the 1× metrics show whole-file attribution is too coarse. Everything else in this design stands. This override is a decision for the implementing build's own plan-approval to ratify.

## Status: Complete

> Design-only spike. Deliverable is this DESIGN.md + INDEX.md. No source changes.
> Every claim about current behavior is grounded in a real file (cited inline).

## Summary

Canon can already **mutate** an agent-definition body (`evaluate_candidate` guardrail
mode, ADR-0025), **attribute** a failure to it (`attribute_failure` code-author join,
ADR-0032), **select** it as a target (`select_mutation_targets`), and **guard** its
frontmatter (ADR-0031). What it cannot do is **measure whether a mutation improved that
agent at its job** — the only fitness surface that exists is the global
intent-classification eval set (`skills/canon/evals/eval-set.json`), which scores the
orchestrator's routing, not any specialist's craft. A rewrite of `agents/reviewer.md`
run through `evaluate_candidate` today moves the intent-classification holdout by **zero**
— the eval set contains no reviewer cases. The missing piece is a **per-agent fitness
function**.

This spike designs that fitness function and the runtime around it, with the reviewer
(already Stage 0→6 structured) as the **single pilot**. Six deliverables:

1. A per-agent eval-suite schema at `agents/{name}/evals/`, and how `evaluate_candidate`
   scores an agent-def mutation against *that agent's* suite instead of the global surface.
2. A decomposition of the reviewer's Stage 0→6 into individually-addressable modules that
   preserves the real Stage 2→Stage 1 dedup dependency and the cold-review barrier.
3. A measured-step **agent runtime** that reuses the flow-level
   `log_step`/`record_agent_metrics`/`evaluate_step` pattern one level down — runtime owns
   *sequencing + measurement*; each stage still calls the model with *prose* judgment.
4. A **mandatory holistic verdict gate** that can VETO an all-stages-green run — the
   Goodhart guard, justified by `watch_VVVVV2`.
5. The stage-precise **evolution-surface integration**: section-scoped attribution +
   targeting, exercising ADR-0031's own section-scoped-mutation Revisit-If, with
   frontmatter-immutability preserved.
6. The **cost-vs-attribution empirical gate**: a concrete measure-before-generalize plan
   that flips "generalize beyond reviewer" vs "kill on evidence."

**Recommendation:** build the pilot **eval-suite-driven** (the failure source is the
per-agent golden suite, not production `review_violation` events), start the eval harness
at **reduced fidelity** (prompt-judged, no MCP daemon — matching the existing surface),
and let goal 6's gate decide whether to invest in a higher-fidelity daemon harness and
whether to generalize. This is the lowest-blast-radius path that still produces
stage-precise measurement.

## ASSUMPTIONS

Surfaced explicitly per `agent-surface-assumptions`. Confidence tiers noted; per
`probe-before-build-invoke-not-infer`, any medium/low assumption that would gate the
*implementing build* is flagged as a build-time probe obligation (not a spike-time one —
no code ships here).

| # | Assumption | Confidence | Basis / probe obligation |
|---|-----------|-----------|--------------------------|
| A1 | The guardrail eval sandbox (ADR-0025) boots **no MCP server**; cases use only Read/Grep/Glob. | **high** | ADR-0025 §Option A ("no MCP server boots; eval cases use only Read/Grep/Glob") + `run-evals.sh` invokes `claude -p` with no server. Read directly. |
| A2 | `run-evals.sh` only discovers `$SCRIPT_DIR/eval-set.json` (the single global set); it cannot run a per-agent suite as-is. | **high** | `run-evals.sh:21` `EVAL_FILE="$SCRIPT_DIR/eval-set.json"`. Read directly. |
| A3 | ADR-0031's `computeBodySections` already splits an agent-def **body** into ATX-heading sections with char-spans at *provenance-capture* time, and the reviewer's stages ARE ATX headings (`## Stage 1: …`). | **medium** | The spans ARE computed and stored on the `AssembledArtifact` (`context-provenance.ts:266-277`, `sections` populated). BUT `attribute_failure` **drops them**: `attribution-join.ts`'s `RawArtifact` (364-372) and `AttributedArtifact` (416-425) carry only `char_span`, never `sections`. So `target_section` is **NOT available downstream for free** — see Goal 5 correction (Codex P2 F3). **Build-time implementation requirement**, not a given: the implementing build must either thread `sections`/`target_section` through `attribution-join` (add the field to `RawArtifact`/`AttributedArtifact` and stop discarding it) OR recompute the section span from the hash-verified on-disk file at attribution time. |
| A4 | Driving the **full** tool-calling reviewer inside the sandbox is not possible today (needs `get_context`/`write_review` → a live MCP server). | **high** | Follows from A1 + reviewer `tools:` frontmatter (MCP tools required). This is ADR-0025's named Revisit-If ("a future target needs the MCP server live in the sandbox"). |
| A5 | A **reduced-fidelity** reviewer eval (inline diff + inline principles + prose stage instructions, prompt-judged) is a *representative-enough* proxy for stage catch-rate to bootstrap goal 6. | **medium** | Design judgment, not observed. **Build-time probe obligation:** before freezing the eval schema, the implementing build must run ≥3 planted-violation cases through both a reduced-fidelity call and a real reviewer spawn and confirm the reduced harness reproduces the same catch/miss verdicts. |
| A6 | The reviewer is NOT in `CODE_AUTHORING_AGENTS` (`{"engineer"}`), so its failures do not attribute via ADR-0032's `code_author_agent_def` edge today. | **high** | ADR-0032 (`CODE_AUTHORING_AGENTS = {"engineer"}`) + `attribution-join.ts` contract in `features/evolution/.claude/CLAUDE.md`. |

## Research

### Current reviewer stage structure (empirical — `agents/reviewer.md`)

| Stage | Purpose | Reads | Barrier class |
|-------|---------|-------|---------------|
| **Stage 0** | Context loading — `get_context({include:[principles,drift,file_context]})` + one `git diff {base}..HEAD` | diff, principles, graph | required-first |
| **Stage 1** | Principle compliance (per matched principle, mechanical verification) | diff + principles only | **cold** |
| **Stage 1.5** | Principle-independent correctness scan (plain bugs, removed-behavior audit) | diff + code only | **cold** |
| *Graph-Aware Context* | Uses `review_code` graph context if present | graph_context | cold |
| **Stage 2** | Principle-informed code quality; ~11 sub-axes (API docs, gotchas, reachability, discriminant parity, severity-vocabulary `watch_VVVVV2`, …) | diff + principles; **dedups Gotcha findings against Stage 1** | **cold** |
| **Stage 3** | Compliance cross-check vs engineer `*-SUMMARY.md` | `*-SUMMARY.md` (AFTER Stages 1–2 final; must NOT revise them) | **plan-aware** |
| **Stage 4** | Drift-from-plan | `DESIGN.md`, `INDEX.md` | **plan-aware (barrier lifts here)** |
| *Build & Lint* | `npm run build` / lint, baseline-compared | worktree | — |
| **Stage 5** | Acceptance-criteria verification (act as user, call real tools) | `runbook.md` | **plan-aware** |
| **Stage 6** | Cross-requirement consistency + scope-parity | diff + all prior | plan-aware |
| **Verdict** | Worst-severity-wins across all stages | all stage outputs | — |

**The two load-bearing invariants the runtime MUST preserve:**

- **Stage 2 → Stage 1 dedup dependency.** `agents/reviewer.md` Gotcha Documentation
  sub-axis: *"If a gotcha is already flagged as a Stage 1 principle violation … do NOT
  duplicate it here."* Stage 2 **reads Stage 1's output**. Any decomposition that runs
  Stage 2 without Stage 1's findings in scope breaks dedup → double-counted findings.
- **Cold-review information barrier.** `agents/reviewer.md` Context Isolation + Workspace
  Integration: *"Do NOT read research, plan files, decisions, or context.md until Stages 1
  and 2 are complete."* Stages 1/1.5/2 must **not** read `DESIGN.md`/`INDEX.md`/`SUMMARY`;
  the barrier lifts at Stage 3 (SUMMARY) / Stage 4 (plan files). **Today this is
  honor-system prose** — the reviewer has `Read` and the plan files are on disk the whole
  time. Nothing structurally prevents an early plan-file read.

### Current evolution surface (empirical — `mcp-server/src/features/evolution/`)

- `evaluate_candidate` (`tools/evaluate-candidate.ts`): injects `candidate_text` at
  `target_path` into a temp sandbox, runs `run-evals.sh` per split, applies the **§7
  strict-holdout gate** (`decideGate`: `candidate_holdout > baseline_holdout`, strict `>`).
  **Dual injection** (ADR-0025): eval-surface paths copy `skills/canon/evals/` only;
  guardrail paths (`agents/`, `rules/`, …) copy the full plugin markdown tree and pass
  `--plugin-dir <sandbox>` to `claude -p`. **Frontmatter-reject guard** (ADR-0031
  amendment): agent-def candidates whose raw frontmatter block differs from baseline are
  rejected before any subprocess (`checkFrontmatterImmutable`).
- `attribute_failure` (`services/attribution-join.ts`): joins `context_provenance` with
  failure sources. Edges: `principle_id==artifact_id` (review_violation, lossy),
  `code_author_agent_def` (ADR-0032, review_violation → `agents/engineer.md`),
  `cliff_step_id` (cliff_event, exact). `test_failure` DEFERRED.
- `select_mutation_targets` (`services/mutation-selection.ts`): deterministic; policy =
  `hash_verified ∧ confidence:high ∧ gate_eligible`, budget default 3. `agent-def` already
  resolves to `artifact_class:"agent"`, `gate_eligible:true`. `derivePrincipleId` keys an
  agent-def target off the **violated principle**, not the agent name.
- **ADR-0031 whole-file decision + its Revisit-If.** The agent-def `content_hash` covers
  the **whole file**; frontmatter is excluded from *mutation scope* at the section-span
  layer (`computeBodySections` emits body-only ATX-heading spans). ADR-0031 Revisit-If
  explicitly lists: *"Section-scoped (rather than whole-file) mutation of agent defs is
  introduced → the whole-file `content_hash` decision must be re-examined."* **This spike's
  goal 5 is exactly that trigger.**

### Flow-level measured-step precedent (empirical — root `CLAUDE.md`)

The orchestrator already runs a measured-step runtime at the **flow** level:
`log_step`/`batch_log_steps` (journal each step), `record_agent_metrics` (per-step
counters), and `evaluate_step` → `canon:evaluator` (a per-step-transition quality gate,
fail-open, pre-review). The design reuses this exact shape one level down at the agent.

## Goal 1 — Per-agent eval-suite schema (`agents/{name}/evals/`)

### File layout

```
agents/reviewer/evals/
├── eval-set.json          # per-stage golden cases (unit suite)
├── holistic/
│   └── eval-set.json      # whole-review golden PRs (integration suite, goal 4)
├── fixtures/
│   ├── <case-id>/
│   │   ├── diff.patch     # the planted-violation (or clean) diff under review
│   │   ├── principles.json# the principle bodies the case supplies to the reviewer
│   │   └── plan/          # optional DESIGN.md/INDEX.md/SUMMARY for Stage 3/4/5 cases
└── run-agent-evals.sh     # per-agent runner (sibling of the global run-evals.sh)
```

### Case format (unit / per-stage suite)

```jsonc
{
  "agent": "reviewer",
  "evals": [
    {
      "id": "stage15-missing-await",
      "stage": "1.5",              // WHICH stage must catch it (barrier/attribution key)
      "split": "train",           // train | val | holdout (reuses §7 split semantics)
      "kind": "must_catch",        // must_catch | must_not_flag  (recall vs precision)
      "fixture": "stage15-missing-await",
      "expected_finding": {
        "principle_id": "correctness-scan",
        "min_severity": "strong-opinion",
        "must_mention": ["await", "unhandled promise"]
      },
      "expected_output": "PASS if the reviewer's Stage 1.5 output flags the un-awaited async call at diff line N with a concrete failure_scenario. FAIL if Stage 1.5 is silent or the finding appears only at a later stage."
    },
    {
      "id": "stage1-clean-result-type",
      "stage": "1",
      "split": "holdout",
      "kind": "must_not_flag",     // precision: reviewer must NOT invent a violation
      "fixture": "stage1-clean-result-type",
      "expected_output": "PASS if the reviewer marks errors-are-values HONORED (Result type present) and raises no false violation."
    }
  ]
}
```

Key schema decisions:
- **`stage`** is the addressable key. It declares which decomposed module must produce the
  finding — this is what makes a golden case *stage-scoped* and what threads into goal 5's
  attribution (`stage` → section span) and goal 4's Goodhart guard (a stage-green run that
  fails the holistic verdict is still a reject).
- **`kind: must_catch | must_not_flag`** encodes the reviewer's own stance (recall pre-PR,
  precision at the gate). A suite of only must-catch cases would Goodhart toward
  over-flagging; must-not-flag cases are the precision counterweight.
- **`split`** reuses the existing train/val/**holdout** semantics — `evaluate_candidate`'s
  §7 gate decides on holdout only, unchanged.

### How `evaluate_candidate` scores an agent-def mutation against *this* suite

Today `evaluate_candidate` always runs the global `run-evals.sh` (A2). The change is a
**target→suite resolution**: when `target_path` matches `agents/{name}.md` (or, goal 5, a
section of it), the runner runs `agents/{name}/evals/` instead of the global surface.
Concretely, the guardrail-mode subprocess invocation gains a suite selector
(`--eval-root agents/{name}/evals`); baseline vs candidate both run that suite; the §7
holdout comparison is unchanged (`decideGate` still compares holdout pass-counts).

**Contract scope — precise claim (Codex P2 F1).** For the **whole-file** agent-def path
(this goal), the public `evaluate_candidate` input/output contract is genuinely
**unchanged** — suite selection is derived from `target_path`, exactly as ADR-0025 derived
injection mode from `target_path`. The candidate is a whole-file body; today's
`checkFrontmatterImmutable` (`services/frontmatter-guard.ts`) byte-compares the raw
frontmatter block and passes body-only edits through. **The section-scoped path (goal 5) is
the exception and DOES require a contract change** — the current input schema
(`candidate_text`, `project_dir`, `splits`, `target_path` — `evaluate-candidate.ts:28-43`)
carries no span, so a stage-only candidate has no frontmatter fence and is *rejected* by
`checkFrontmatterImmutable`, while a full-file candidate gives a `checkNonTargetImmutable`
no target span to enforce against. Goal 5 resolves this with an additive-optional
`target_span` input; see Goal 5 §section-splice. Do not read "contract unchanged" as
covering the section path.

**The MCP-server constraint (A1/A4).** Per-stage reviewer cases need the reviewer to
actually *review a diff*. The full reviewer calls `get_context`/`write_review` (MCP) — but
the sandbox boots no server. Two harness fidelities:

- **Reduced fidelity (recommended pilot start):** the case supplies the diff + principle
  bodies **inline** in the prompt; the runner invokes `claude -p` with the reviewer stage
  instructions (loaded from the sandbox `agents/reviewer.md` via `--plugin-dir`) and an
  LLM judge scores the emitted stage output against `expected_output`. No MCP server. This
  matches the existing `eval-set.json` prompt→judge shape and reuses `run-evals.sh`'s judge
  machinery. Gated by A5 (build-time representativeness probe).
- **High fidelity (escalate only if goal 6 says so):** boot a **scoped MCP daemon** inside
  the sandbox (ADR-0025's named Revisit-If) so the real tool-calling reviewer runs against
  the fixture and its `write_review` structured output is inspected directly. Heavier;
  deferred behind the cost gate.

### Migration from `skills/canon/evals/`

The global set is **not** deleted — it stays the *orchestrator's* fitness surface
(intent-classification/routing is an orchestrator concern, not a specialist's). Migration
is **additive**: introduce `agents/reviewer/evals/` as a new, parallel surface. No case
moves out of the global set (none of its cases are reviewer-craft cases). The only shared
asset is the **judge + split machinery** in `run-evals.sh`, which `run-agent-evals.sh`
reuses (extract the judge/`--judge-votes`/split-filter core into a shared helper both
scripts source). This keeps the §7 gate identical across surfaces.

## Goal 2 — Reviewer stage decomposition into addressable modules

Each stage becomes a module with a declared `(reads, writes, barrier_class)` contract.
The two invariants are enforced by the **module contract**, not prose:

| Module | Reads (state slice) | Writes | Barrier |
|--------|--------------------|--------|---------|
| M0 context-load | diff, principles, graph | `ctx` | first |
| M0.5 review-stub | — | `write_review` IN_PROGRESS stub (empty findings, zeroed score) | first (before M1) |
| M1 principle-compliance | `ctx` | `stage1.violations[]`, `stage1.honored[]` | cold |
| M1.5 correctness-scan | `ctx` | `stage15.findings[]` | cold |
| M2 code-quality | `ctx`, **`stage1.violations[]`** (dedup input) | `stage2.findings[]` | cold |
| M3 compliance-cross-check | `*-SUMMARY.md`, **frozen** `stage1` | `stage3.discrepancies[]` | plan-aware |
| M4 drift-from-plan | `DESIGN.md`,`INDEX.md` | `stage4.drift[]` | plan-aware (barrier lifts) |
| M5 ac-verification | `runbook.md` | `stage5.results[]` | plan-aware |
| M6 cross-requirement | frozen stages 1–5 | `stage6.findings[]` | plan-aware |
| MV verdict | all stage outputs | `verdict` | — |

**Dedup dependency, made structural.** M2's input contract *names* `stage1.violations[]`.
The runtime passes Stage 1's findings into M2's context; M2's dedup rule operates on real
data, not memory. If M1 and M2 were ever parallelized, the runtime would have to serialize
M1→M2 (they share a cycle in the data-dependency graph) — so **M1 and M2 are same-wave /
sequential**, never concurrent.

**Freeze semantics.** M3's contract marks `stage1`/`stage2` **read-only-frozen**. The
runtime enforces `agents/reviewer.md`'s "do not revise earlier findings" by making the
Stage 1/2 output immutable once M3 starts — a structural guarantee replacing the prose one.

**Barrier, made structural (the key HARD-enforcement win).** Cold modules (M1, M1.5, M2)
are constructed by the runtime with **only** `ctx` (diff + principles) in their context —
the plan-file paths are **not supplied** and (in the high-fidelity harness) the plan
directory is **not on the module's readable path set**. A cold module *cannot* read
`DESIGN.md` because the runtime never handed it the path and scopes its filesystem view.
The barrier lifts at M3/M4 when the runtime *adds* `*-SUMMARY.md` / plan files to the
module's inputs. This converts the single most safety-relevant honor-system rule in
`agents/reviewer.md` into a runtime-enforced invariant.

**Write-cliff fail-safe preserved (Codex P2 F4).** `agents/reviewer.md`'s Early Output
Protocol (lines 565–587) requires `write_review` as the reviewer's **FIRST tool call** — a
`verdict:"IN_PROGRESS"` stub with empty `violations`/`honored` and a zeroed `score` — plus
a **partial write immediately after Stage 1**, so that a run which times out or exhausts
context still leaves an actionable `REVIEW.md`. The decomposition MUST preserve this: **M0.5
review-stub** runs before M1 and emits the IN_PROGRESS stub; M1's completion triggers a
partial `write_review` (Stage 1 findings + Stages 2–6 `[pending]`), and each later module
re-writes as it finishes. Whichever topology goal 3 selects — per-stage spawn, two-phase, or
single-agent — the stub-first + partial-after-Stage-1 fail-safe is a hard requirement of the
runtime, not an optional optimization. A decomposed reviewer that only writes its artifact at
the terminal verdict would *regress* the current write-cliff guarantee.

## Goal 3 — Measured-step agent runtime

**Reuse, don't reinvent.** The runtime is the flow-level pattern one level down:

| Flow level (exists) | Agent level (this design) |
|---------------------|---------------------------|
| `log_step` per runbook step | per-stage step record (stage id as the step key) |
| `record_agent_metrics` per step | `record_agent_metrics` per stage (adds a `stage` dimension) |
| `evaluate_step` → `canon:evaluator` gate | per-stage eval gate (goal 1 unit suite) |
| worktree isolation per agent | context/tool-scope isolation per stage (the barrier) |

**Runtime owns sequencing + measurement; the model still judges in prose.** Each stage is
still a model call that reads the stage's prose instructions from `agents/reviewer.md` and
produces a prose+structured finding set. The runtime does NOT encode review logic in
control flow (eve's killed model). It only: (a) decides stage order, (b) constructs each
stage's context slice (enforcing the barrier + threading Stage 1 into Stage 2), (c) freezes
completed stages, (d) records per-stage metrics, and (e) runs the per-stage eval gate.

**State threading.** A single `ReviewState` accumulator is threaded across stages. Each
module reads a declared slice and appends to its own namespace (`stage1.*`, `stage2.*`, …).
Namespacing + append-only writes make the freeze trivially enforceable (later stages can
read but not mutate `stage1.*`).

**Barrier enforcement mechanics.** The runtime builds stage N's prompt from
`ReviewState`'s allowed slice + the stage's declared external inputs. Cold stages get
`{ctx}`; M3 additionally gets `{summaries}`; M4+ additionally gets `{plan_files}`. Because
the runtime constructs the prompt, an early plan-file read is impossible in the
per-stage-spawn topology (the path is simply absent from context).

**Runtime granularity — the position taken.** Three topologies exist:

- (a) **Per-stage spawn** — one scoped model call per stage (~6× calls). Hard barrier,
  stage-precise metrics + attribution. **This is the measured unit** the thesis assumes
  (the PRD's "~6× model calls" framing). *Recommended for the pilot.*
- (b) **Two-phase** — one cold call (M0–M2) + one plan-aware call (M3–M6), ~2×. Hard
  barrier at the one seam that matters, but no per-stage attribution granularity.
- (c) **Single-agent + checkpoints** — today's single context window, add per-stage
  `record_agent_metrics`. 1×, but the barrier stays honor-system and attribution stays
  monolithic.

Per-stage spawn (a) is the only topology that delivers BOTH the hard barrier AND
stage-precise attribution (goal 5) — which is the whole point. Its cost is exactly what
goal 6 measures. Positions (b)/(c) are the fallbacks goal 6 selects if the ~6× isn't
justified. See Decisions D2.

## Goal 4 — Mandatory holistic verdict gate (the Goodhart guard)

**Model:** unit(per-stage) + integration(whole-review), exactly the Canon test shape.

- **Unit** = goal-1 per-stage suite: "did stage N catch its planted violation / avoid its
  false positive."
- **Integration** = the **holistic suite** (`agents/reviewer/evals/holistic/`): whole
  golden PRs with an expected **final verdict** (BLOCKING/WARNING/CLEAN) and expected
  finding-set. It runs the *entire* decomposed reviewer end-to-end and checks the
  aggregate verdict, not any single stage.

**Why mandatory + veto (proof-of-need `watch_VVVVV2`).** `agents/reviewer.md` records the
exact failure mode this guards against: **PR #332** — a new Stage 6 scope-parity sub-check
assigned WARNING severity but the `## Verdict` table was not updated; **every stage was
locally correct**, yet the aggregate verdict was wrong (CLEAN when it should have been
WARNING). The Canon reviewer passed it CLEAN; **Codex caught it post-ship.** A per-stage
suite alone would have shown all-green and shipped the regression. The holistic gate is the
only thing that catches a *composition* error where each part is right and the whole is
wrong.

**Veto semantics wired into §7.** The holistic suite is itself a **holdout** whose pass =
"final verdict matches golden expectation." `evaluate_candidate` on a reviewer mutation
runs BOTH suites; the accept rule becomes:

```
accepted  ⟺  per_stage.holdout strictly-improves (candidate_passed > baseline_passed)
                                                    ∧  holistic.holdout does-not-regress
regressed ⟺  holistic.holdout regresses            (VETO — even if per-stage strictly improved)
```

**Which split is strict, and why (Codex P2 F2).** The **primary per-stage suite keeps the
existing §7 STRICT `>`** — `decideGate` (`eval-runner.ts:95-102`) accepts only when
`candidate_passed > baseline_passed`, and the per-stage suite is exactly the fitness surface
the mutation is trying to improve, so an equal-holdout tie is a rejection (no fitness change
≠ accept). The **holistic suite is a NON-REGRESSION VETO**, not a second strict-improvement
term: it does not need to strictly improve (a mutation targeting one stage will usually leave
most golden-PR verdicts unchanged) — it only must **not regress**. A candidate that raises
per-stage catch-rate but drops one golden-PR final verdict is **rejected**. This is the
Goodhart guard in mechanical form: you cannot buy stage-level recall at the cost of
aggregate-verdict correctness. Implementation-wise this is the existing `decideGate` strict-`>`
on the per-stage split, ANDed with a holistic-non-regression predicate
(`holistic.candidate_passed >= holistic.baseline_passed`); the composite is fail-closed.
(Earlier drafts inverted this — applying `improves-or-holds` to per-stage and
`strictly-improves` to holistic — which both weakened the §7 gate on the primary suite and
over-constrained the veto; corrected here.)

## Goal 5 — Evolution-surface integration (stage-precise)

### The join-key change (`attribute_failure`)

Today the reviewer's failures do **not** flow through ADR-0032's `code_author_agent_def`
edge (A6 — reviewer ∉ `CODE_AUTHORING_AGENTS`), and a reviewer "failure" is a *missed or
spurious verdict*, for which no durable production event exists (Codex catches escapes
off-Canon). So the pilot's failure source is the **per-agent eval suite outcome**, not a
production `review_violation`. A failing golden case already **declares its `stage`** (goal
1). That gives a stage-precise attribution key — but **NOT for free** (Codex P2 F3):

- New (pilot-scoped) failure kind: `agent_eval_miss` — `{ agent, case_id, stage,
  expected_finding }`. Its natural join is **stage → section span**: the stage id maps to
  the `## Stage N …` ATX heading in `agents/reviewer.md`, whose `char_span` ADR-0031's
  `computeBodySections` **computes at provenance-capture time** and stores on
  `AssembledArtifact.sections` (`context-provenance.ts:266-277`).
- **Implementation requirement — the spans are dropped before they reach attribution.**
  `attribute_failure` today discards `sections` entirely: its `RawArtifact`
  (`attribution-join.ts:364-372`) and `AttributedArtifact` (416-425) carry only a single
  `char_span`, never the per-section span array. So `target_section` is **not** available to
  the attribution consumer as-is. The implementing build MUST do one of two things: (a)
  thread `sections`/`target_section` through `attribution-join` — add the field to
  `RawArtifact`/`AttributedArtifact` and stop dropping it in the provenance→attribution
  mapping; or (b) recompute the target stage's span from the **hash-verified** on-disk
  `agents/reviewer.md` at attribution time (the whole-file `content_hash` re-check already
  runs, so the file is proven byte-identical before recompute). This is new provenance
  plumbing — a required build task, not a free lunch.
- `join_basis` gains a value: **`agent_eval_stage_section`** (a stage-precise sibling of
  `code_author_agent_def`). The attribution carries an optional
  `target_section: { heading, char_span }`.

### The targeting change (`select_mutation_targets`)

`select_mutation_targets` already returns `agent-def` targets with `gate_eligible:true` and
`derivePrincipleId` keyed off the violated principle. The change: when the attribution
carries `target_section`, the emitted `MutationTarget.char_span` is **that stage's span**
(not `null` = whole file). `baseline_body` remains the whole file (needed for the splice);
`char_span` narrows the *mutable region* to one stage. Selection policy, budget, and
`derivePrincipleId` are otherwise unchanged.

### `evaluate_candidate` section-splice mode (the ADR-0031 Revisit-If)

This is the one genuinely new mechanic and the one that **exercises ADR-0031's
whole-file-hash Revisit-If**. Today a candidate is a whole-file body; the frontmatter guard
asserts the frontmatter block is byte-identical. With section-scoped mutation:

- **The contract must change here — an additive span input (Codex P2 F1).** The current
  `evaluate_candidate` schema (`candidate_text`, `project_dir`, `splits`, `target_path` —
  `evaluate-candidate.ts:28-43`) has no way to name the target region, and its
  `checkFrontmatterImmutable` byte-compares the *whole raw frontmatter block*. That breaks
  both ways for a section candidate: a **stage-only** candidate carries no `---…---` fence,
  so `checkFrontmatterImmutable` sees a differing block and **rejects it**; a **full-file**
  candidate passes the frontmatter check but leaves the splice-guard no way to know which
  region was *intended* to change. **Chosen resolution (the cleaner of the two options in
  F1): callers perform the splice and pass span metadata through.** The learner splices its
  stage rewrite into the baseline body and passes the **whole spliced file** as
  `candidate_text` PLUS a new **additive-optional** `target_span: [start, end]` (byte
  offsets into the baseline body, sourced from the `MutationTarget.char_span` selection
  already emits). Whole-file agent-def mutations omit `target_span` and hit today's exact
  path unchanged — so the field is backward-compatible, but the **section path is explicitly
  a schema addition**, and the earlier "public contract unchanged" phrasing is corrected to
  cover only the whole-file path (see Goal 1).
- A generalized guard — call it `checkNonTargetImmutable` — reads `target_span` and asserts
  that **everything outside that `char_span` (frontmatter AND every other stage) is
  byte-identical to baseline.** This is a strict superset of today's
  `checkFrontmatterImmutable`: frontmatter immutability falls out as the special case where
  the target span is a body section (so frontmatter is always outside it). When `target_span`
  is absent (whole-file path), the guard degrades to exactly today's
  `checkFrontmatterImmutable`. Fail-closed, same posture as ADR-0031's amendment.

### Frontmatter-immutability preserved (ADR-0031 confirmed)

- Stages are **body** sections; every stage span starts at/after the frontmatter-end offset
  (`computeBodySections` guarantees this). `name`/`tools`/`model` lie outside every stage
  span → never mutable. Confirmed.
- The runtime frontmatter-reject guard still fires (it's now the outside-the-span special
  case). Confirmed.
- **Whole-file `content_hash` must be re-examined** (ADR-0031 said so). Recommendation:
  keep the whole-file hash as the **drift/byte-identity** seam (unchanged for
  `attribute_failure`), and enforce section-scoping at the **mutation-apply layer** via
  `checkNonTargetImmutable`. The hash answers "did the on-disk artifact drift since
  provenance capture"; the splice-guard answers "did the candidate touch anything outside
  the target stage." Two orthogonal checks, neither weakened.

**This is an ADR-worthy decision for the implementing build** (see Decisions D3). It is
NOT written as an ADR here — a design spike produces a recommendation, not a ratified,
shipping decision (nothing ships from this worktree). The implementing build writes the
ADR amendment to ADR-0031 at its plan-approval.

## Goal 6 — Cost-vs-attribution empirical gate (measure-before-generalize)

The reviewer becomes ~6× model calls (per-stage spawn) + the holistic pass. Before
generalizing the runtime to any other agent, **measure whether stage-precise attribution
actually tightens the evolution loop** versus whole-body mutation. Empirical
candidate-comparison (Step 2a), not a first-principles argument.

### The two arms (same attribution set, same golden suites)

- **Arm W (control):** whole-file agent-def mutation (today's ADR-0031/0032 path). The
  candidate rewrites all of `agents/reviewer.md`; `char_span:null`.
- **Arm S (treatment):** section-scoped mutation (goal 5). The candidate rewrites only the
  attributed stage span.

### Signal (per accepted-proposal attempt)

| Metric | How measured | Why it matters |
|--------|-------------|----------------|
| **Loop-tightness** | # candidate-generation iterations to reach an `accepted:true` proposal | The core claim: precision → fewer wasted rewrites |
| **Holdout Δ** | `candidate_holdout − baseline_holdout` on the per-stage + holistic suites | Did the accept actually improve fitness |
| **Proposal survival** | Fraction of accepted proposals that do NOT regress under `get_evolution_outcomes` (ADR-0034 post-apply detection) | Real-world durability, not just holdout |
| **Cost** | model calls per accepted proposal (≈6× stage + holistic + N rewrites) | The denominator of the value question |

### Sample size & threshold

- **Batch:** the first **10** reviewer mutation attempts (eval-driven; a batch, not
  calendar time — evolution is offline and low-frequency).
- **Flip to GENERALIZE** (roll the measured-step runtime to the next structured agent,
  `security`, which is also staged) iff Arm S beats Arm W on **≥2 of 3** quality metrics
  with material margin:
  - loop-tightness ≥ **30%** fewer iterations to accept, AND/OR
  - ≥ **1** additional accepted proposal Arm W could not reach (whole-file rewrite too
    coarse to isolate the fix), AND
  - holdout Δ and proposal-survival **no worse** than Arm W.
- **Flip to KILL** (keep whole-file agent-def mutation as-is; do NOT generalize; retire the
  per-stage-spawn runtime for the reviewer, fall back to topology (c) single-agent +
  per-stage metrics) iff after the batch Arm S shows **no** loop-tightness advantage or
  **worse** proposal-survival — the ~6× cost is unjustified on evidence.
- **Inconclusive** → extend one more batch of 10, then force a decision (no indefinite
  pilots).

The gate is a real deliverable: it names the signal, the N (10-attempt batch), and the
exact threshold that flips generalize vs kill.

## Approaches (considered)

| Approach | Barrier | Attribution | Cost | Verdict |
|----------|---------|-------------|------|---------|
| **A. Per-stage-spawn runtime + eval-suite-driven attribution + section-scoped mutation** (recommended) | HARD (structural per-stage context) | stage-precise (section span) | ~6× | **Chosen** — only option delivering both hard barrier and stage-precise attribution; cost gated by goal 6 |
| B. Two-phase (cold / plan-aware) | HARD at one seam | phase-level (2 buckets) | ~2× | Fallback if goal 6 kills ~6×; loses stage precision |
| C. Single-agent + per-stage metrics | SOFT (prose) | monolithic (whole file) | 1× | The "kill" landing spot; keeps today's ADR-0031/0032 whole-file path |
| D. Production-`review_violation`-driven attribution for reviewer | — | requires new escaped-defect event + reviewer∈CODE_AUTHORING_AGENTS | — | **Descoped** — no durable "reviewer was wrong" event exists (A6); manufacturing one is a separate epic |

Evaluation order (Canon-priority): A honors the most principles (hard barrier =
`fail-closed-by-default` for the safety-relevant cold-review rule; reuse of the flow
pattern = `simplicity-first`/`deep-modules`; eval-driven = `probe-before-build`), is the
smallest blast radius that meets the goal (extends existing seams, no new provenance
plumbing — A3), and is the most testable (each stage has a unit suite; the whole has an
integration suite). B and C are the goal-6-selected fallbacks, not independent designs.

## Decisions

Recorded to `${WORKSPACE}/decisions/`. ADR-gate evaluation per decision below.

- **D1 — Reviewer is the single pilot; per-agent eval suite lives at `agents/{name}/evals/`
  and is additive to the global set.** ADR-gate: hard-to-reverse? no (additive, no case
  moved). → ephemeral decision only, no ADR.
- **D2 — The measured unit is the per-stage spawn (topology A); barrier enforced by
  per-stage context construction.** ADR-gate: hard-to-reverse? partially (shapes the
  runtime) but explicitly *reversible by goal 6* to (b)/(c). Genuine trade-off? yes (cost
  vs precision). Surprising-without-context? no (PRD's ~6× framing). Fails "surprising" +
  is designed-to-be-reversed → ephemeral only, no ADR.
- **D3 — Section-scoped agent-def mutation (splice + `checkNonTargetImmutable`),
  re-examining ADR-0031's whole-file-hash decision; whole-file hash retained for drift,
  section-splice guard for mutation.** ADR-gate: hard-to-reverse **yes** (changes the
  mutation-granularity contract + the guard seam), surprising-without-context **yes** (why
  sections not whole-file; why two orthogonal checks), genuine trade-off **yes** (whole-file
  simplicity vs stage precision). **All three hold → ADR-worthy.** BUT this is a design-only
  spike: nothing ships, the decision is not yet ratified (subject to the implementing
  build's plan-approval). Per "do not manufacture," the ADR is an **obligation on the
  implementing build** (amend ADR-0031), not written here. Recorded as an ephemeral decision
  with the ADR obligation flagged.
- **D4 — The holistic verdict gate is mandatory with §7 veto power over an all-stages-green
  run.** ADR-gate: this is a direct application of the existing unit+integration test
  pattern + §7 gate; surprising-without-context? no. → ephemeral only, no ADR.
- **D5 — Eval harness starts reduced-fidelity (prompt-judged, no MCP daemon); high-fidelity
  scoped-daemon harness is deferred behind goal 6.** ADR-gate: reversible (escalation path);
  → ephemeral only, no ADR. Carries build-time probe obligation A5.

**No ADR is written by this spike.** `worktree_path` was provided, but no decision here is
both ratified AND shipping — D3 (the only gate-passing decision) is an obligation handed to
the implementing build, per the non-manufacture rule.

## Requirements Coverage

| # | Goal (PRD) | Disposition | Owning runbook step / section |
|---|-----------|-------------|-------------------------------|
| 1 | Per-agent/per-stage eval-suite schema + `evaluate_candidate` scoring + migration | **covered** | DESIGN §Goal 1; runbook step `design` |
| 2 | Reviewer stage decomposition (dedup dep + cold barrier + HARD-enforce note) | **covered** | DESIGN §Goal 2; runbook step `design` |
| 3 | Measured-step agent runtime reusing flow pattern (state-threading + barrier mechanics) | **covered** | DESIGN §Goal 3; runbook step `design` |
| 4 | Mandatory holistic verdict gate with veto (`watch_VVVVV2`) | **covered** | DESIGN §Goal 4; runbook step `design` |
| 5 | Evolution-surface integration (join-key + targeting change; frontmatter-immutability confirmed) | **covered** | DESIGN §Goal 5; runbook step `design` + `adr-obligation` |
| 6 | Cost-vs-attribution empirical gate (signal, N, threshold) | **covered** | DESIGN §Goal 6; runbook step `design` |

Acceptance-criteria checkboxes (PRD) → all satisfied: reviewer structure characterized
empirically (§Research); `agents/{name}/evals/` schema specified (§Goal 1); measured-step
runtime as flow-pattern reuse with explicit state-threading + barrier mechanics (§Goal 3);
holistic gate MANDATORY + veto + `watch_VVVVV2` (§Goal 4); exact join-key
(`agent_eval_stage_section`) + targeting (`char_span` = stage span) + frontmatter
confirmation (§Goal 5); measure-before-generalize plan with signal/N=10/threshold (§Goal 6);
Requirements Coverage table (this section); runbook (below).

## Runbook

Design-only (per PRD constraint: no implement/verify of production TypeScript). Recommended
`dispatch: sequential` — single design artifact, no parallelizable code tasks.

| Step | Agent | Output | HITL |
|------|-------|--------|------|
| research | architect | §Research (this doc) | — |
| design | architect | DESIGN.md (this doc) | plan-approval |
| adr-obligation | (implementing build) | ADR amendment to ADR-0031 for D3 — **not this spike** | future plan-approval |
| context-sync | scribe | none expected (spike adds no shipped contracts; DESIGN.md is the deliverable) | — |
| ship | shipper | PR of the design doc to main | — |

Note: `adr-obligation` is a forward marker, not a step this spike executes. The
implementing build that turns this design into code owns the ADR.

## Open questions

Positions were taken on the two genuinely-50/50 sub-decisions rather than blocking, because
the PRD supplies strong priors and both resolve by sequencing:

1. **Runtime granularity (D2).** Position: per-stage spawn is the measured unit; goal 6 may
   demote to two-phase/single-agent. Residual risk: if the ~6× proves prohibitive *before*
   the batch completes, the pilot may need an earlier off-ramp. Mitigated by goal 6's
   inconclusive→one-more-batch rule.
2. **Eval fidelity (D5).** Position: start reduced-fidelity; escalate to a scoped MCP daemon
   only if goal 6 warrants. Residual risk: A5 (does the reduced harness reproduce real
   reviewer catch/miss?) — flagged as a **build-time probe obligation** before schema
   freeze.

Neither rises to a HAS_QUESTIONS block: both are resolved by the measure-first structure the
PRD itself mandates. If the user disagrees with the ~6× per-stage-spawn framing (D2), that
is the one lever that would reshape the design — surfaced here for the plan-approval gate.

## Review-response amendments (PR #454, Codex P2)

Four P2 findings from the Codex review of this design-only PR were each verified against the
cited source before editing (not blind-accepted); all four held. Resolutions:

- **F1 — `evaluate_candidate` contract is NOT unchanged for the section path.** Verified:
  the input schema (`evaluate-candidate.ts:28-43`) carries no span, and
  `checkFrontmatterImmutable` (`frontmatter-guard.ts`) byte-compares the whole raw
  frontmatter block — so a stage-only candidate is rejected and a full-file candidate leaves
  the splice-guard no target. Fixed: the whole-file path keeps the "contract unchanged"
  claim (Goal 1); the section path adds an **additive-optional `target_span: [start, end]`**
  input, with callers performing the splice and passing span metadata through (Goal 5
  §section-splice). "Contract unchanged" no longer covers the section path.
- **F2 — composite accept rule weakened the §7 strict gate.** Verified: `decideGate`
  (`eval-runner.ts:95-102`) accepts only on strict `candidate_passed > baseline_passed`; the
  draft's `per_stage improves-or-holds` accepted a tie. Fixed: the **primary per-stage suite
  keeps STRICT `>`** (matching `decideGate`); the **holistic suite is a non-regression VETO**
  (`>= baseline`, must not regress, need not strictly improve). Goal 4 formula + prose
  corrected.
- **F3 — `target_section` is not available "for free."** Verified: `context-provenance.ts`
  computes+stores `sections` (266-277), but `attribution-join.ts` drops them — `RawArtifact`
  (364-372) and `AttributedArtifact` (416-425) carry only `char_span`. Fixed: A3 downgraded
  high→**medium**; Goal 5 now names an explicit build task — thread `sections` through
  `attribution-join`, OR recompute the span from the hash-verified file — instead of "no new
  provenance plumbing."
- **F4 — decomposition omitted the reviewer's write-cliff fail-safe.** Verified:
  `reviewer.md` Early Output Protocol (565-587) requires a `write_review` IN_PROGRESS stub as
  the FIRST tool call + a partial write after Stage 1. Fixed: added **M0.5 review-stub**
  module to the Goal 2 table (runs before M1) and a prose paragraph making the
  stub-first + partial-after-Stage-1 fail-safe a hard requirement of any decomposed topology.
