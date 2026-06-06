# Supervised Build Quality — Direction Document

## Context

Canon currently runs supervised builds where the orchestrator pauses at HITL gates for human approval. After evaluating a full "dark factory" (lights-out autonomous) proposal, we decided:

- **HITL gates are features, not friction.** For a solo developer, the gates cost ~30 seconds but catch wrong assumptions that automated verification can't.
- **The system validates itself** (Canon reviews Canon's work). The human gate is the only truly independent check.
- **ROI is negative** for removing gates — enormous build investment to save trivial human time.

**Decision**: Instead of removing the human, invest in making the human's time at each gate more productive and the agent work between gates faster and better.

## What Shipped (Epics 1 + 2)

From the original dark factory proposal, two capabilities were merged (PR #232):

### Auto-Escalation (Epic 2) — Full implementation

`get_next_escalation_strategy` MCP tool. Replaces immediate HITL on agent failure with a structured cascade:

| Priority | Strategy | When |
|----------|----------|------|
| 1 | Add domain primer | Failure in unfamiliar area |
| 2 | Increase token budget | Agent ran out of turns |
| 3 | Escalate model | Running on sonnet, failure looks capability-limited |
| 4 | Narrow scope | Task too broad, partial progress exists |
| 5 | HITL | All strategies exhausted |

2-minute cumulative timeout. Per-flow config allows skipping strategies. State persisted to execution store.

### Confidence-Gated Auto-Approval (Epic 1) — Neutered implementation

`compute_autonomy_tier` MCP tool exists but the protocol restricts it:

- **Plan approval and initial review verdict are ALWAYS mandatory** regardless of tier
- Only low-value gates are skippable: build-step checkpoints, WARNING close-out, CLEAN re-review after fix
- Fail-safe: defaults to supervised on any signal-gathering error

## What Shipped: Epic 6 — Feed-Forward Enrichment (PR #239)

Cross-session error+fix index and pitfall enrichment. Before agent spawns, the orchestrator queries build history and injects context:

- **Before architect**: common failures in touched files → "known pitfalls"
- **Before engineer**: previous fix attempts in same area → "prior approaches"
- **Before reviewer**: principle violation history for files → "watch areas"

`error_fixes` table in execution store, populated from `write_implementation_summary`, queried via `get_context`.

### Epic 6 — remaining (not yet built)

- Auto-promotion: convention → strong-opinion when compliance > 95% across 5+ builds
- Auto-demotion: archive principles with 0 violations across 20+ builds
- Auto-apply policy config: `auto` | `suggest` | `off` (per project)

## What Shipped: Hooks & Confidence Wave (PRs #245–#261)

Between May 24–26, a concentrated wave shipped the top-priority roadmap items plus foundational infrastructure:

- **Tool-loop detection** (PR #245) — Thread 3 top item. PostToolUse fingerprinting detects stuck loops. (Spawn watchdog removed in PR #276 — false positives on main session; turn budgets and auto-escalation cover the gap.)
- **Shared hook library** (PR #248) — `hooks/lib/canon-hook-lib.sh` extracted from 5+ hooks. Foundation for all subsequent hook work.
- **DAG dispatch guard** (PR #253) — Advisory hook warns on raw `Agent` spawns during DAG execution, enforcing `TeamCreate`/`TaskCreate`.
- **Holistic confidence scoring** (PR #259) — Shared `ConfidenceScore` schema, `computeConfidence()` engine, review + drift adapters. Covers Thread 2 (confidence per violation, confidence decay) and Thread 4 (composite health score).
- **PostCompact narrative capture** (PR #261) — Thread 3 item. PostCompact hook preserves compaction summaries in workspace journal.
- **Hook hardening** (PRs #254, #255, #257, #260) — SIGPIPE fixes, session-start guards, shared test helpers, verify ghost state handling.
- **Dead-code cleanup** (PRs #252, #256, #258) — Drift violation fixes, dead workspace dirs, doc corrections.

## What Shipped: Hook Hardening & Learner Wave (May 27–28)

Between May 27–28, a second wave shipped hook quality improvements and learner proposals:

- **PostCompact stdin fix** (PR #262) — PostCompact hook reads `compact_summary` from stdin instead of a positional arg.
- **Shellcheck verify gate** (PR #265) — `hooks/lint.sh` now runs shellcheck as a real verify gate on all hook shell scripts.
- **Destructive-guard regex fix** (PR #266) — Regex updated to allow `canon-task/` branch prefix in addition to `canon/`.
- **Wiki-lint + proactive doc gap detection** (PR #267) — `wiki_lint` MCP tool scans Canon's own meta-layer for contradictions, orphan principles, and directories missing CLAUDE.md. Ships both Thread 4 items.
- **Hook test coverage** (PR #268) — Adds `canon-wave/` test case for destructive-guard; fixes stale comment (VVV1, VVV2).
- **Learner WWW1/WWW2 proposals** (PR #269) — Root-threading convention for wave tasks and observable catch-block pattern.
- **jq JSON extraction hardening** (PR #270) — Replaces grep/sed JSON extraction with jq across hook scripts; fixes quoted branch args.

**In-flight**: PR #271 (`fix(hooks): replace remaining grep/sed JSON extraction with jq + context-sync`) — hook hardening continuation, not yet merged.

## Supervised Build Quality — Feature Backlog

Three threads for making supervised builds faster and higher quality. Features are harvested from prior roadmap docs and prioritized by leverage.

### Thread 1: Fewer Review-Fix Loops

The biggest time sink. If the engineer gets it right first pass, you skip 1-2 full review cycles.

| Feature | Effort | Leverage | Source |
|---------|--------|----------|--------|
| ~~**Feed-forward enrichment** (Epic 6)~~ | ~~Medium~~ | ~~Very high~~ | Shipped (PR #239) |
| ~~**Cross-session error + fix index**~~ | ~~Medium~~ | ~~High~~ | Shipped (PR #239) |
| ~~**Short-term area memory**~~ | ~~Small~~ | ~~High~~ | Shipped (PR #279). `AreaMemoryDao` + `area-memory-enrichment.ts`; observations injected into architect/engineer spawn prompts. |
| ~~**Hot-file caution for engineers**~~ | ~~Small~~ | ~~Medium~~ | Shipped (PR #279). `hot-file-detection.ts`; caution note injected when a file appears in many recent builds. |
| **Outdated violation detection** | Medium | Medium | Track which diff lines each violation was pinned to. On re-review, violations on unchanged lines persist; violations on changed lines are marked "outdated." Stops reviewers from re-flagging fixed code. |
| **Reviewer pulls real LSP diagnostics** | Medium | High | L1. Replace/augment `npm run build` stdout-parsing with per-file, per-line LSP diagnostics (codes included). Gives `feedback_reviewer_must_build` real teeth. Open question: LSP availability in worktrees/headless. |

### Thread 2: Better HITL Presentations

Make each gate decision faster and more confident.

| Feature | Effort | Leverage | Source |
|---------|--------|----------|--------|
| ~~**Confidence per violation**~~ | ~~Small~~ | ~~High~~ | Shipped (PR #259). Shared `ConfidenceScore` schema + `computeConfidence()` engine. `review-confidence-adapter` scores each violation. |
| ~~**Confidence decay for drift**~~ | ~~Medium~~ | ~~Medium~~ | Shipped (PR #259). `drift-confidence-adapter` decays confidence by commits-since-review. `get_drift_report` sorts by staleness. |
| **GitHub-linkable review output** | Small | Medium | Review output includes clickable GitHub line links (`/blob/[sha]/path#L42-L48`). Useful when posting PR comments or sharing findings. |

### Thread 3: Faster Agent Turns

Context gathering burns the most agent turns. Reduce wasted work.

| Feature | Effort | Leverage | Source |
|---------|--------|----------|--------|
| ~~**Tool-level loop detection**~~ | ~~Small~~ | ~~High~~ | Shipped (PR #245). `tool-loop-detector.sh` PostToolUse hook with fingerprinting + exit code 2 → HITL. |
| ~~**In-flight spawn watchdog**~~ | ~~Small~~ | ~~High~~ | Shipped (PR #245), removed (PR #276). False positives on main session; turn budgets and auto-escalation protocol cover stuck-agent detection. |
| ~~**PostCompact narrative capture**~~ | ~~Tiny~~ | ~~Medium~~ | Shipped (PR #261). PostCompact hook appends compaction summary to workspace journal. |
| **Skill effectiveness tracking** | Medium | Medium | Learner analyzes journal outcomes to recommend: primers that help, `maxTurns` adjustments, skills that need updating. Requires extending `FlowRunEntry` with domain skill counts. |
| **Effort budgets** | Medium | Medium | Maximum tool calls per state, wall-clock duration limits, max agent spawns per flow. "Focus and wrap up" note injected when approaching limit; pause for approval when hit. |
| **`evaluate-step` augmented with LSP** | Medium | Medium | L2. The regex `PATTERN_CATALOG` gets a precision boost from real compiler signal. Keep regex for style patterns; LSP for correctness. |
| **Architect LSP blast-radius cross-check** | Small | Medium | L3. Cross-check KG `graph_query(callers)` against ground-truth LSP references; catches the stale-KG problem hit live. |
| **Skill progressive activation** | Medium | Medium | X2. Split monolithic CLAUDE.md into activated skills so the orchestrator loads only the relevant protocol. Attacks the TTL/context-bloat the user already fights. Complements the existing "Skill effectiveness tracking" entry. |
| **Deferred-load cold Canon tools** | Medium | Medium | T1. Smaller orchestrator base context → more room before TTL/compaction. Needs hot/cold usage telemetry first. |

### Thread 4: Codebase & Artifact Hygiene

Canon's own documentation and artifacts accumulate drift. Eat your own dogfood.

| Feature | Effort | Leverage | Source |
|---------|--------|----------|--------|
| ~~**Wiki-lint over Canon's own artifacts**~~ | ~~Medium~~ | ~~High~~ | Shipped (PR #267). Lint pass over contradictions between CLAUDE.md files, orphan principles with no usages, stale plans referencing renamed files. |
| ~~**Composite health score**~~ | ~~Small~~ | ~~High~~ | Shipped (PR #259). `computeConfidence()` engine with shared `ConfidenceScore` schema. Drift report integrates confidence decay. |
| ~~**Proactive doc gap detection**~~ | ~~Small~~ | ~~Medium~~ | Shipped (PR #267). Scribe scans for directories that contain source files but no CLAUDE.md before classifying a diff. |
| ~~**Documentation staleness in drift reports**~~ | ~~Medium~~ | ~~Medium~~ | Shipped (PR #274). `doc_freshness` dimension in `get_drift_report`: `DocFreshness[]` per direction doc with `commits_since_sync` + decaying `ConfidenceAnnotation`, sorted by staleness descending. Scribe also gained elective `docs/*.md` factual-sync in Step 5b (prevention half, addresses `watch_ZZZ1`). |
| **Repo-level `.canon/log.md`** | Tiny | Medium | Global timeline of flow completions, principle additions, and lint passes. Single append at `complete_flow`. Grep-parseable `## [YYYY-MM-DD] type | title` prefix. |
| **Consolidate `write_*` → `write_artifact`** | Small | Low | 5 individual write tools still individually registered. One `write_artifact({ type, workspace, data })` reduces MCP surface. |
| **Piece B — diff_stat denominator wiring** | Small | Medium | `evaluate-step.ts` computes `diff_stats` but `tryAppendAnalytics` never writes `diff_stat`/`total_files_changed` onto the persisted FlowRunEntry (0/340 rows have it). Wire at the finalize seam. Useful as a per-flow change-size denominator for any future metric; independent of the shelved taxonomy. See `docs/explore/automatic-craft-prerequisites-scoping.md`. |

### Thread 5: Flow Inputs & Exploration

Make Canon smarter about what goes into builds, not just what comes out.

| Feature | Effort | Leverage | Source |
|---------|--------|----------|--------|
| **Smarter scribe spawn decisions** | Small | Medium | Pre-classify the diff for signals that reliably warrant doc updates (exported signature changes, new routes, schema changes). Scribe focuses judgment on boundary cases. |
| **Static security pre-filter** | Small | Medium | Cheap regex checks (`eval`, SQL concatenation, common secret formats) give the security agent a pre-filtered candidate list instead of starting from scratch. |
| **Idea-to-spec flow** | Medium | Medium | Takes a vague idea through structured clarification into a concrete spec. Conversational research, surface assumptions, clarifying questions, written spec as output. PM refine skill partially covers this; full explore→spec pipeline closes the loop. |
| **Compounding exploration** | Tiny | Low | Scribe convention that promotes notable explore findings into project-level `docs/notes/`. Explorations compound over time instead of evaporating. |
| **Explicit code-to-docs mapping** | Small | Low | Project-local config declaring which source directories are documented by which CLAUDE.md files. Eliminates scribe guesswork. |

---

## New Epic — Deterministic Spine

Harden the invariant parts of the orchestration loop into deterministic substrate (hooks first, Workflow later), without reversing PR #151's removal of the bespoke flow engine. The LLM stays the control plane for the adaptive front; the spine guarantees the parts that have only failure modes, no legitimate adaptivity.

**Two axes, not one.** Workflow adoption has a *scope* axis (how much of the build is deterministic: tail → loops → waves → whole-build) **and** an *authorship* axis (hand-written vs compiled-from-runbook). The roadmap originally explored only hand-authored, static increments. A deterministic, shape-agnostic transpiler compiles the architect's per-build runbook + `task-dag.yaml` into a validated IR (not generated source), which a thin permanently-trusted runner executes and discards. This is not what #151 deleted (a persisted, hand-authored static flow library + its bespoke engine) — the compiled Workflow is an ephemeral build artifact downstream of the freshly-designed runbook, with zero per-flow special-casing in the compiler. The closed 17-step runbook vocabulary is the invariant that keeps the compiler shape-agnostic and must be guarded.

**Net effect on the Workflow ladder:** static W1/W2/W3 collapse into one deterministic transpiler (the transpiler reads fan-out width, loop cap, and merge strategy as declared fields rather than hand-coding each); a Small, immediate-win precursor (G1–G9 runbook enrichment) appears ahead of the transpiler; and W8 moves from "rejected" to "viable, deferred, boundary-gated" — the autonomous-tier whole-build execution path, reachable after the transpiler proves out. HITL is handled by segment-at-gates: the compiler splits the runbook at firing-gate boundaries and emits one IR segment per inter-gate region; the orchestrator runs segments and conducts gates between them via its existing `AskUserQuestion` + render-HTML flow. In-Workflow HITL nodes are rejected.

| Feature | Effort | Leverage | Source / Note |
|---------|--------|----------|---------------|
| **Stop-hook tail enforcement** | Small | Very high | X4. A `Stop`/`SubagentStop` hook refuses to end a build session if `finalize_workspace` / learner / context-sync didn't run. Deterministic backstop for the user's strongest standing rules (`never_skip_learner`, `never_skip_canon_steps`, scribe-commit verification). No philosophy conflict — pure floor-hardening. Cheapest reliability win available. Generalizes to a gate backstop under compilation: a Stop-hook enforces that mandatory gates (plan approval, initial review verdict) were honored, composing with segment-at-gates — the hook guarantees a gate happened; it does not conduct it. |
| **Runbook field enrichment (G1–G9)** | Small | High | Standalone precursor — decoupled from execution. Add nine declared, machine-readable fields the executor needs but that today live in prose / CLAUDE.md / nowhere: G1 loop bounds (`max_iterations`), G2 loop exit predicate (`{all_addressed: bool}` contract), G3 failure-routing edges (which `cause` routes where), G4 skip predicates as evaluable expressions (not prose), G5 per-node budget, G6 fan-out width policy, G7 merge/reduce strategy, G8 tier→gate semantics, G9 post-merge assertion. Improves runbook quality on its own even if no Workflow ever runs — it converts the runbook from "a document a human interprets" into "a specification with no ambiguous control flow." Zero #151 tension. Hard prerequisite for the transpiler. **G8 is load-bearing**: it is the field the compiler reads to compute the firing-gate set and therefore the segment boundaries — it drives segmentation, not just declarative tidiness. |
| **W4 tail pipeline as a Workflow (PoC) — COMMITTED** | Small | High | W4. Encode context-sync → ship → learn as a fixed `pipeline()` with the conditional-skip predicates (markdown-only diff, fix-type build) faithfully ported. Committed roadmap item — built regardless of X4's outcome. X4 (Stop-hook) is still sequenced first, but W4 is not gated on Stop-hook measurement. Bounded, low-blast-radius validation of the harness `Workflow`→`Agent` call path; gates the transpiler. Design W4's node interface so the future transpiler emits the same shape. |
| **Deterministic runbook→IR transpiler** | Large | Very high | Subsumes static W1 + W2 + W3. A pure, unit-tested function `(runbook, task-dag.yaml) → validated WorkflowPlan IR`, shape-agnostic over the closed 17-step vocabulary + DAG topology — no per-flow branching (guard with a lint/test asserting no `if flow === …` in the compiler). Maps the DAG into `parallel()` segments (fan-out width = G6), encodes the review→fix→re-review loop as a bounded loop node (cap = G1, routing = G3, exit contract = G2; the semantic "addressed?" check stays an LLM sub-node), and folds the consolidation reducer into the `parallel()` reduce step (G7). Validation extends `dag-validator.ts` into `validateWorkflowPlan`. Output is validated IR, not generated source — only generated data to schema-check, dissolving the generated-code-trust risk. Tier-gated: compile autonomous/light-touch builds first; defer supervised. |
| **Whole-build flow as one compiled Workflow** | Large | High | W8. Reclassified: viable, deferred, boundary-gated — the autonomous-tier whole-build execution path. A compiled whole-build Workflow is not the #151 static engine: it is generated per build from the LLM's design and discarded, so it does not re-introduce the persisted hand-authored flow library #151 removed. Safe and ideal at the autonomous tier — where 0–1 gates fire in the compiled region, so the plan compiles to one (or near-one) uninterrupted, fully resumable Workflow. Status change only, not a sequencing change: still deferred behind the transpiler proving out on the conservative boundary (tail + review-fix loop + wave execution) and a tier-relative boundary decision. No longer "rejected / possibly never." |

**Risks to flag:**

- **#151 determinism tension.** The hybrid is asymmetric — only invariant tail/bounded loops become deterministic; the adaptive front (triage, design, wave-event injection) stays LLM-driven. A compiled Workflow (ephemeral, generated per build, discarded) does not re-introduce the persisted hand-authored flow library #151 removed, provided the compiler is shape-agnostic (no per-flow branching; the closed 17-step vocabulary is the guarded invariant). The residual sharpest tension is loss of mid-flight HITL adaptivity — a compiled Workflow is interruptible only at declared segment boundaries; mitigated by segment-at-gates and by concentrating compilation on autonomous/light-touch tiers where few gates fire.
- **Stale runtime docs are a latent landmine.** `SKILL.md`, `CLAUDE.md`, and `features/orchestration/README.md` still describe `drive_flow`/`load_flow` tools that PR #151 removed. Run wiki-lint-driven doc correction before the W4 PoC so the implementer isn't misled.

---

## New Epic — Memory Integrity & Honest Signal

Source: the 2026-06-04 ruflo (ruvnet/ruflo) re-audit — a 30-agent workflow (facet research → adversarial claim verification → 5-subsystem Canon audit → multi-lens synthesis). The audit's highest-ROI output was not a ruflo feature to copy but ruflo's own self-audit (ADR-074/095) applied inward: ruflo documented a "reported success but persisted nothing queryable" failure class — typed infrastructure built, tested, then never wired to the path the system executes. Canon was verified to have the same defect class live. This epic closes those gaps and hardens the honesty of Canon's own measurement layer. Every item is identity-central (auditability, determinism) — none introduces autonomy, consensus, or learned routing.

**Precondition — fix the journal write race first.** `log_step`'s read-modify-write on `journal.json` is unlocked; DAG workers calling `log_step` can race the orchestrator and silently drop entries. Every "wire the dead data" and reachability-lint item below depends on trustworthy journal/store writes, so this precondition lands before them. (Highest-severity orchestration correctness gap; previously deferred to v2.1b.)

**Slate-B status (corrected 2026-06-04).** The slate-B learner build (verdict-weight learner inputs by build outcome) shipped as **PR #306 — MERGED**. It independently hit the exact dead-input this audit flagged: `get_cross_run_analysis` was absent from the learner's tool allowlist, so JUDGE was inert. #306 **caught and fixed it mid-build** (commit `665f8d97`). The only genuinely-dead surface remaining after #306 is `OutcomeStore` (zero consumers, untouched by #306); `decision_summaries` is a documented back-compat tombstone, not a bug (see the Tier 1 table below).

### Tier 1 — Wire the dead data (correctness; XS–S)

| Feature | Effort | Leverage | Source / Note |
|---------|--------|----------|---------------|
| **Wire OutcomeStore to the WARNING close-out HITL** | Small | Very high | `outcome-store.ts` (recordOutcome/getOutcomeStats/getOutcomesForFiles) has zero production consumers — only the test file calls it. The WARNING-advisory close-out gate (fix/acknowledge/defer) discards the user's disposition, Canon's highest-value human signal. One `recordOutcome` call at that decision point captures it. |
| ~~**Reconnect the learner to cross-run analysis**~~ | ~~Tiny~~ | ~~High~~ | Shipped (PR #306). `learner.md` now lists `get_cross_run_analysis` in its tool allowlist. |
| **Thread `task_description` into the matcher** | Small | Medium | `task_description` is accepted by `get-principles.ts` but never threaded into the matcher — an accepted-but-ignored input. NOTE: `decision_summaries` was previously grouped here in error — it is **not** a dead-wire bug but an intentional version:1 back-compat tombstone (documented at `run-summary-builder.ts:62` and `history-types.ts:104`; its source `decisions/` workspace dir was deliberately removed). Disposition: leave as documented compat or delete the field — never populate it. |
| **Tier-vocabulary mismatch** | Tiny | Medium | `CLAUDE.md` instructs `tier: "trivial"` but `init-workspace.ts` accepts only `small\|medium\|large` — an XS correctness bug on the path every build hits (confirmed live: init rejected `"trivial"`). Reconcile the vocabulary in one place. |
| **De-alias `unintentional_violations`** | Tiny | Low | Increments in lockstep with `total_violations` (`analyzer.ts:85`) — dead data shown in drift reports as if meaningful. Compute it for real or stop surfacing it. |

### Tier 2 — Type the one stringly boundary (S, high)

| Feature | Effort | Leverage | Source / Note |
|---------|--------|----------|---------------|
| **Typed agent status return** | Small | High | `status-protocol.md` confirms the orchestrator **regex-scans agent prose** for `DONE`/`BLOCKED`/`FIXED` — the only decision-critical signal still crossing the agent→orchestrator boundary as unvalidated text, while the rest of the spine is rigorously typed (`ToolResult` unions; `write_review`/`write_test_report`/`write_implementation_summary` as typed terminal writes). Fold a required `status` enum into those terminal-write tools (or add a thin `report_status`) so the orchestrator reads a validated enum from the store; keep the free-text scan as graceful-degradation fallback. Ruflo's hardest-won lesson ("wire the typed layer to the real path") aimed inward. |

### Tier 3 — Self-applied auditability + honest metrics (M)

| Feature | Effort | Leverage | Source / Note |
|---------|--------|----------|---------------|
| **Self-hollowness lint (generalize step-ghost → DATA)** | Medium | High | `finalize_workspace` already detects step-ghosts (planned-but-never-dispatched STEPS). Generalize to DATA: assert every drift.db table with a DAO has ≥1 production read-caller; flag RunSummary fields constant across all archives (`decision_summaries=[]`) and counters that never diverge from a sibling (`unintentional` vs `total`). Subsumes the Tier-1 reachability checks as the durable enforcement layer — build once, here. Canon's auditability self-applied. |
| **Honest-metric discipline** | Medium | Medium | Two live fiction-metrics: (1) craft v1 = `max(0, 100 − holistic_count*10)` — a raw volume count, not density-normalized by code changed, not intent-filtered (praise/nits count like defects); `docs/explore/automatic-craft-prerequisites-scoping.md` concedes this and is SHELVED — the density+intent redesign (Pieces A+D) was **killed 2026-06-05, see Not Doing**. (2) The cognitive-load tier baselines in `learner-dimensions.md` are hardcoded placeholders ("update as data accumulates") with no service deriving them from the archived `flow_runs`. Adopt the baseline-derivation (pure determinism, data exists). Generalize: any scoring constant annotated "update as data accumulates" is a latent fiction-metric — surface it in the drift report until a real-data derivation replaces it. No LLM judge inside any metric (`no-llm-calls-in-mcp-tools`). |

### Identity guardrail (XS, durable)

| Feature | Effort | Leverage | Source / Note |
|---------|--------|----------|---------------|
| **Single-coordinator / no-orchestration-theater invariant** | Tiny | High | Codify in CLAUDE.md the rationale already applied ad-hoc to reject ruflo's slate C/E/F: *"Canon has exactly one coordinator. No consensus voting, no topology selection, no learned router, no neural branding, no inter-agent message bus, no federation. Any proposal to add multi-coordinator/consensus machinery must show a functional branch that changes behavior, not a config knob."* Every impressive ruflo subsystem verified as config-only theater (`reachConsensus()` = `Math.random()`; topology has no functional branch; "150×" HNSW measured 1.9×; LoRA never reaches inference). Turns three correct ad-hoc rejections into one citable guardrail so future swarm/consensus/federation temptations are auto-rejected, not re-litigated. Cross-reference `docs/explore/adaptive-queen.md` and the slate-E/F decisions. |

**Grafts onto existing threads/epics** (design kernels from the same audit — extracted without ruflo's hollow execution):

- **Slate-A model router → per-DAG-node hints (Deterministic Spine).** Sharpen the parked complexity-tiered model router from a single init-time tier to a per-`task-dag.yaml`-node `model_hint` the architect emits from a **deterministic** bucketing function over KG blast-radius signals Canon already computes (`impact_score`/`in_degree`), and add the missing **downgrade** path (`escalate_model` only upgrades; trivial fix node → haiku). Fits the G1–G9 runbook-enrichment seam and the existing inert `"codemod"` ModelTier stub. **Reject** ruflo's Thompson-sampling/Q-learning bandit half (needs multi-session reward loops; reintroduces non-determinism).
- **Outcome-weighted *semantic* trajectory retrieval → Thread 1 + Epic 6.** Canon's feed-forward retrieves by **exact key only** (file_path, principle_id); a conceptually-identical build touching new files gets zero feed-forward. Add a build-trajectory vector index at `finalize_workspace` (embed sharpened-request + flow_name + touched-subsystem tags + outcome), top-K cosine recall injected at architect/engineer spawn — the "RETRIEVE" half the keyed signal-compiler can't express. **Gate:** the sqlite-vec embedder does **not** currently ship offline (first-use 22MB download, no FTS5 fallback — verified); confirm offline bundling first. Could null-result against key-exact recall — prototype, don't commit.
- **Pure-projection MergePlan service → Deterministic Spine (wave-merge).** `mergeWaveResults`/`cleanupWorktrees` have **zero TS implementation** — the highest-blast-radius destructive step is purely behavioral Bash with no atomic merge-or-abort and no structured result. A small service returns a typed `MergePlan` (ordered merges + diff-verification + abort plan) executed step-by-step with a structured `MergeResult`. **Blocked on** the open per-task-worktree vs. shared-worktree decision (#302 kept the model the 2026-05-30 decision said to delete). Distinct from D′/#302, which excised dead refs but left the merge step as prose.
- **Deterministic Tier-1 codemods → existing `"codemod"` ModelTier seam (Deterministic Spine).** TS-compiler-API, format-preserving text-range edits (the mechanical "script bulk edits" cases) — the audit's "most practically sound" planning-facet idea; determinism over LLM, identity-aligned. Lands on the already-documented zero-LLM Tier-1 seam from the model-router design.
- **MCP tool-group gating → Thread 3 (context economy).** Ruflo's ADR-035 `MCP_GROUP_*` env gates suppress tool/context flooding. Relevant given Canon's ~30KB CLAUDE.md and large preload prompts; complements X2 (skill progressive activation) and T1 (deferred-load cold tools).
- **Per-build cost/token accounting → Thread 3 / Thread 7.** Canon's turn budgets are behavioral-only with no per-build token attribution. A finalize-time token/cost rollup per `flow_run` feeds Effort budgets (Thread 3) and closes the loop with M1/N1 (Thread 7).

**Explicitly not adopting** (verified ruflo theater): Byzantine/Raft/Gossip consensus, topology selection, federation/cross-host transport, trust-tiering + PII egress gates (slate E/F), multi-provider LLM routing, learned/ML routers (MoE/Thompson/Q-learning), SONA/LoRA "neural" branding, the HNSW "150×" framing, GOAP as a *runtime* autonomy engine, and the named-but-unimplemented background-worker roster. Each is decorative or downstream of a multi-machine/untrusted/multi-provider threat model Canon does not have. (The deterministic, gate-fired *replanner* kernel — re-deriving the runbook only at deterministic gates and re-presenting at the existing approval HITL — is a possible future prototype but lower-value: the convergence rule already names the fix-introduces-new-violation case; the real gap is the `same_violations` set-comparison mechanism.)

---

## Infrastructure Epic — HTTP-Transport / Per-Project-State

Parallel infra track to the build-quality threads. Removes the MCP server's process-global state so the server can serve multiple project scopes per connection — the prerequisite for an HTTP daemon that fixes the zero-tool cold-start boot bug (npx/tsx cold start + `${CLAUDE_PLUGIN_ROOT}` token-expansion failure). It is also shared substrate for several Memory-Integrity kernels: the semantic-trajectory index, MergePlan service, typed-status tool, and any new drift.db table all touch the per-project-state surface this epic hardens, so they sequence cleanly after Phase 1 lands.

| Phase | What | Status |
|-------|------|--------|
| **1a** | Per-connection scope foundation | Shipped (PR #288) |
| **1b** | Migrate consumers to connection scope | Shipped (PR #290) |
| **1c + 1d** | Eliminate `process.cwd()` implicit-scope sites; delete the `projectDir`/`setProjectDir` global; add (unwired) `evictStoresForScope`/`evictDriftDbForScope` eviction hooks; split `drift-db.ts` into siblings | Shipped (PR #304) — CLEAN review, behavioral no-op under stdio. Isolation-finish (per-project `JobManager` via `getOrCreateJobManager`) shipped PR #316. |
| **2** | HTTP daemon: auto-reconnect kills the silent zero-tool cold start; `url` config sidesteps the `${CLAUDE_PLUGIN_ROOT}` token-expansion failure; wire the eviction hooks to connection-end | Not started — unblocked by #304 |

**Sequencing notes:**

- **#304 (HTTP Phase 1) is the per-project-state substrate for the MCP-touching Memory-Integrity kernels.** Wiring OutcomeStore, adding a trajectory-index table, and the typed-status store-write all extend the per-project-state surfaces #304 made connection-scoped; build them on that substrate rather than the old `projectDir` global.
- **Known residual resolved** (PR #316): `http-server.ts` artifact server scope now threaded from `index.ts` — `process.cwd()` implicit-scope fallback removed.
- **Live tooling caveat resolved** (PR #315): `resolve_agent_skills` pluginDir seed was off-by-one (fixed-dirname-count → marker-walk via `findAnchorDir`); now correctly resolves to the repo root.

---

### Thread 6: Background Maintenance

Canon has zero background maintenance today. The "86 commits since last scribe sync" signal comes from a poll at session start (`session-start-doc-check.sh`), not a scheduled job. Convert the polls to true background jobs that produce draft PRs / notifications — never silent merges.

**Notification channel (resolved):** OS push + terminal, split by urgency. Opt-in OS push (`PushNotification`) for the things that need a human now — HITL prompts and build-complete. Terminal/log for background digests (C3) and learner surfacing (C4 output), which don't warrant an interrupt. This split lets every Thread 6 and Thread 7 item resolve its channel without a further decision: anything that blocks on a human → push; anything informational → terminal/log.

| Feature | Effort | Leverage | Source / Note |
|---------|--------|----------|---------------|
| **Scheduled / triggered KG re-index** | Small | High | C2. Replaces `session-start-kg-check.sh`. Fixes a live correctness bug — the KG was found stale during exploration (semantic_search returned deleted file paths). Cheapest maintenance win; lock against concurrent builds writing the KG. |
| **Scheduled context-sync** | Medium | High | C1. Cron spawns scribe when commits-since-sync exceeds threshold. Doc drift never reaches "86 behind." Must produce a draft PR on a clean branch, never a silent commit (preserves no-silent-action). Conflict-guard against active builds via existing file-claims. |
| **Janitor on a schedule** | Small | Medium | C5. `invoke_janitor` already has time-gate logic; cron is its natural trigger. Orphaned-workspace cleanup + WAL checkpoint without waiting for the next build. Low risk — gate checks already exist. |
| **Nightly drift / compliance digest** | Medium | Medium | C3. Cron runs `get_drift_report` + posts a summary to the terminal/log channel. Feeds the learner watch-list. Risk: noise → gate behind a real channel choice. |
| **Scheduled learner mining + threshold auto-promote** | Medium | Medium | C4. Periodic `get_cross_run_analysis` that surfaces watched patterns to the terminal/log channel. One feature with a promotion-threshold knob `N`: `N` unset / `N=∞` → surface-only, promotion stays a manual human gate (the default); `N=finite` → the learner auto-promotes a pattern to a convention once confirmed across `N` builds. `N` mirrors the existing MEMORY watch-list discipline ("needs 2 more instances", "3+ builds confirm"), making the implicit human counting rule explicit and configurable. |

### Thread 7: Closing the Build Loop

The shipper "creates the PR and returns" — it can't watch CI. Turn "PR opened" into "merged, CI green, you've been pinged." Uses Thread 6's resolved notification channel: opt-in OS push for build-complete and any HITL-needed gate; terminal/log for informational output.

| Feature | Effort | Leverage | Source / Note |
|---------|--------|----------|---------------|
| **Shipper waits on CI via Monitor** | Medium | High | M1. Background `gh pr checks --watch`, re-invoke on completion. Build flow reports true done. Needs a timeout + handoff for unbounded CI. |
| **Notify-on-build-complete / on-HITL-needed** | Small | Medium | N1. User walks away during a long build; pinged via opt-in OS push when a gate needs them or the PR is green. Opt-in keeps it inside the "invisible" posture — you only hear from it when you walked away. Establishes the push side of the resolved channel; Thread 6's digest (C3) and learner surfacing (C4) use the terminal/log side. |
| **Auto-fix-on-CI-failure loop** | Medium | Medium | M2. Monitor detects red CI → re-spawn engineer in fix mode. Self-healing for transient/lint failures (the `tester_must_lint` pain). Cap iterations; distinguish transient vs real. |

---

### Not Doing

These were evaluated and explicitly rejected:

- **Automatic craft signal / finding intent+severity taxonomy (Pieces A+D of the craft scoping)** — Killed 2026-06-05. Rationale: even fully built, only ~2 of 6 craft dimensions become trustworthy-automatic (locality, partially simplicity/predictability); the meaningful dimensions (cohesion, interface-depth, naming) stay reviewer-judged no matter what. Reviewer overhead plus a values decision (defining the taxonomy) isn't justified without wanting an automatic craft gate, and no automatic craft gate is wanted. Compliance score is already populated (59/64 reviews carry real tallies — no work needed). Craft v2 (PR #301) reviewer-judged 6-dimension profile remains the craft measure. Piece B (diff_stat wiring) is kept on the backlog independently. See `docs/explore/automatic-craft-prerequisites-scoping.md`.
- **Scheduled full *builds* via CronCreate** — Kicking off feature development on a timer. Stays rejected: GitHub Actions + existing monitoring tools do this better, and auto-triage without a human PM is the wrong default. *Scheduled **maintenance*** (scribe / janitor / KG re-indexer spawned when a staleness threshold is crossed) is explicitly **permitted** and tracked under Thread 6 — Background Maintenance: it needs Canon's own agents and workspace/file-claim locking, which GH Actions cannot run, and it always emits a draft PR + notification, never a silent merge.
- **Event-driven triggers (RemoteTrigger)** — Same reasoning. External shim complexity for a solo dev project.
- **Streaming observability pipeline** — JSONL + existing tooling is sufficient. No custom dashboard.
- **Progressive trust model** — Interesting but premature. Need 50+ builds of data before trust scores are meaningful. Revisit when build history is deep enough.
- **Autonomous PR lifecycle** — Removes the human from post-ship. The value of review comments is high; auto-responding risks missing nuance.
- **Recursive agent spawning** — Research shows 37% of multi-agent failures are coordination failures. Canon's flat orchestrator-worker hierarchy is correct.
- **Design-pattern/anti-pattern labels in KG** — Academic labeling (God Object, Singleton, etc.) with low practical impact for a solo dev project. The KG already exposes hub scores and cycles.
- **Duplicate-block detection** — AST shingling is a large build for medium signal. Reviewer and learner catch copy-paste issues well enough.
- **Graph-structured agent memory** — Premature. Requires memory architecture (P5) that isn't needed yet. Current `MEMORY.md` approach is sufficient.
- **Memory decay / Ebbinghaus model** — No pain point driving this. Memory isn't growing fast enough to need automated pruning.
- **4-tier memory hierarchy** — Formalization without a clear need. The tiers exist informally and work fine.
- **Parallel multi-perspective review** — Team dispatch already covers file-partition fan-out. Perspective-based split (compliance vs bugs vs security) adds coordination cost for marginal gain.
- **Inline diff view (Shiki)** — The HTML renderer already shows violations per file. A line-level diff viewer is a large UI build for incremental improvement.
- **Test coverage mapping** — Depends on Istanbul/c8 being configured in the project. Revisit if coverage tooling is set up.
- **Expanded agent evals / eval scenario library** — Large scope. Current intent-classification evals are sufficient. Revisit when agent behavior regressions become a problem.
- **KG query traceability log** — Useful in theory for tuning retrieval, but no pain point today.

## Recommended Build Order

| Phase | What | Rationale |
|-------|------|-----------|
| ~~**Done**~~ | ~~Tool-loop detection~~ | Shipped PR #245. (Spawn watchdog removed PR #276.) |
| ~~**Done**~~ | ~~Confidence scoring + drift decay + composite health~~ | Shipped PR #259. |
| ~~**Done**~~ | ~~PostCompact narrative capture~~ | Shipped PR #261. |
| ~~**Done**~~ | ~~Wiki-lint + doc gap detection~~ | Shipped PR #267. |
| **Next** | GitHub-linkable review output | Last remaining Thread 2 item. Small build, immediate value for PR workflows. |
| **Prerequisite** | Fix the journal `log_step` write race | Guarantees journal/store writes don't silently drop under DAG parallelism — the floor every dead-wire fix stands on. (The #304 HTTP Phase 1 per-project-state substrate is the other floor for the MCP-touching kernels.) |
| **Then (high ROI)** | Memory-Integrity Tier 1 — wire OutcomeStore to the WARNING close-out, thread `task_description` into the matcher, fix the tier-enum, de-alias `unintentional_violations` | XS–S correctness fixes dead-center in auditability identity; best ROI on the new slate. Builds on the #304 per-project-state substrate. (#306 merged — cross-run substrate now reachable.) `decision_summaries` is a tombstone, not a fix. |
| **Then** | Typed agent status return (Memory-Integrity Tier 2) | Removes the largest behavioral-only fragility (regex-scan of agent prose) for minimal cost; reuses the typed terminal-write tools. |
| **Then** | Self-hollowness lint + single-coordinator invariant | Generalized reachability enforcement (subsumes the Tier-1 reachability checks) + the XS identity guardrail that auto-rejects swarm/consensus scope creep. |
| **Later** | Honest-metric discipline (cognitive-load baseline derivation only — craft density+intent redesign killed 2026-06-05, see Not Doing) + audit design-kernel grafts (per-node model hints, semantic trajectory retrieval, MergePlan, codemods, tool-group gating, cost accounting) | Prototype-gated; several depend on prior decisions (worktree model for MergePlan, offline embedder for retrieval) or on accumulated data. |
| **Then** | Stop-hook tail enforcement (X4) | Deterministic Spine — cheapest, highest-leverage reliability win. Zero dependencies, no philosophy conflict, reuses `canon-hook-lib.sh`. Guarantees the user's strongest standing rules by construction. |
| **Then** | Scheduled / triggered KG re-index (C2) | Thread 6 — fixes a live correctness bug (stale KG hit during exploration). No dependencies. "Not Doing" entry already narrowed in this doc. |
| **Then** | Shipper waits on CI + notify (M1 + N1) | Thread 7 — highest user-visible payoff ("merged, green, pinged"). N1 also establishes the OS-push plumbing that unblocks Thread 6's digest and C4 surfacing. Opt-in to preserve "invisible." |
| **Then** | Runbook field enrichment (G1–G9) | Deterministic Spine — declare the nine executor-needed fields in the runbook schema. Delivers the "better runbooks" win immediately and independently of any execution (zero #151 tension), and is the hard prerequisite for the transpiler. **G8 (tier→gate semantics) is load-bearing** — it computes the firing-gate set that drives segment boundaries. |
| **Then** | W4 tail pipeline as a Workflow PoC | Deterministic Spine — bounded determinism proof-of-concept. Validates `Workflow`→`Agent` before the transpiler; design its node interface so the transpiler emits the same shape. Run wiki-lint doc-correction pass first (clears stale-runtime-doc risk). |
| **Then** | Reviewer pulls real LSP diagnostics (L1) | Thread 1 graft — upgrades the review/verify floor from regex+stdout to structured compiler signal. Independent; slots in wherever LSP-in-headless is confirmed. |
| ~~**Done**~~ | ~~Short-term area memory + hot-file caution~~ | Shipped PR #279. |
| **Later** | Effort budgets + skill effectiveness tracking | Last Thread 3 items. Cap runaway agent turns and learn which primers/skills help. |
| **Later** | Deterministic runbook→IR transpiler | Deterministic Spine — subsumes W1/W2/W3. Tier-gated to autonomous/light-touch first. Deferred until W4 PoC proves the `Workflow`→`Agent` path. |
| **Later** | W8-via-compilation (whole-build Workflow) | Deterministic Spine — autonomous-tier whole-build endpoint. Deferred behind transpiler proving out on the conservative boundary (tail + review-fix loop + wave execution). |
| **Later** | Thread 6 tail (C1/C5/C3/C4), L2/L3, X2/T1 | Scheduled scribe + janitor + digest + learner mining; LSP cross-checks; context-economy items. Follow Deterministic-Spine-then-Maintenance order. |
| **Later** | Outdated violation detection, smarter scribe, idea-to-spec | Compound value features that improve over time. |
| **Remaining Epic 6** | Auto-promotion/demotion thresholds, auto-apply policy | Needs sufficient build history to be meaningful. |
