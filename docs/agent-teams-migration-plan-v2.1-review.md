# Architect Review — Agent-Teams Migration Plan v2.1

**Reviewer:** canon-architect (prompted review)
**Target:** `docs/agent-teams-migration-plan-v2.1.md` (1289 lines, DRAFT)
**Baseline:** `docs/agent-teams-migration-plan-v2.md` (698 lines, 2026-04-12)
**Date:** 2026-04-19
**Status:** complete

---

## Verdict

**Sound, with conditions.** v2.1's two additions — the unified learning loop and vocabulary-driven runbook synthesis — are architecturally coherent, cleanly separable from v2's core decisions, and disciplined about scope. The phase split (v2.1a → v2.1b → v2.2) is well-designed, ratification gates are concrete, and the three HIGH-severity concerns below are tractable. Proceed with v2.1 as the source of truth **after** resolving the concerns in §4 — particularly the L4 hook's blast radius and confidence calibration before user-facing exposure.

The plan does not reopen any of v2's 27 integration dispositions. Synthesis operates at the plan-composition layer above the integration surface; the learning loop operates on Canon artifacts, not coordination plumbing. v2.1 is genuinely additive.

---

## 1. Architectural soundness

### 1.1 The two additions are cleanly separable

v2.1's learning loop (§3) and synthesis (§5) could in principle ship independently. In the plan they are paired because synthesis is what makes the **plan-quality arm** of the learning loop possible — static runbooks have no feedback path — but the loop applies to all five refinement targets regardless of synthesis. This separability shows in the v2.1a / v2.1b split: v2.1a ships synthesis without any persistence substrate; v2.1b ships the minimum persistence required to close one loop (principles). The dependency is one-way and explicit.

### 1.2 Synthesis architecture is well-defined

The three-file decomposition (`runbook-vocabulary.md` as data, `runbook-synthesis.md` as composition rules, `planner-brief.md` as strategic analysis) separates concerns correctly. The 15-ID vocabulary (§5.1) is tight — 13 functional steps + 2 mandatory tail — and the versioning discipline (additive minor, deprecation-cycle major) is standard semver applied sensibly to a step taxonomy. The MUST / MAY / MUST NOT contract in §5.3 reads as enforceable by review, not just aspiration.

The `skills:` field being validated **strictly** at synthesis time (§5.2) is the right choice — catches skill-name drift early, before a flow wastes a spawn on a misreference.

### 1.3 Learning loop is coherent

The observation → pattern → proposal → refinement mechanism is one cycle with many targets (§3). The key design decision is reducing the refinement-target matrix from 11 to 5 in-scope, 4 deferred, 1 cut (§3.3). This is mature: agent definitions, rules, vocabulary, and KG priors are each explicitly out of scope with documented reasoning, and v2.1b ships only principles — the one target with a runnable Gate B today.

The supervised curation model (§3.4 — weekly human review, `.canon/proposed-learnings/{timestamp}/`) is conservative and appropriate. Automation (§11 P5) is explicitly deferred, which is correct given the risk surface of a learner writing to agent prompts or memory.

### 1.4 Overconfidence acknowledgment is honest

§7.4 names LLM overconfidence skew as a systemic risk and specifies six concrete mitigations (signal decomposition, unknown-articulation, cold-start defaults low, corpus anchoring, conservative prompt guidance, learner-side calibration detection). Crucially, the plan accepts residual risk explicitly — v2.1a/b ships with **unvalidated calibration** and §7.3 makes confidence advisory, not gating. This lets the plan ship without committing to calibration it can't prove.

### 1.5 Defense in depth is strengthened

v2's seven-layer enforcement model (§2.8 in v2; §2.10 in v2.1) gains an eighth layer: L4 (`canon-workspace-check.sh` PreToolUse hook, §2.10 / §6.5). L4 backstops L1 (CLAUDE.md re-classification discipline) with a hard gate — if the lead misclassifies intent and skips planner, the hook blocks `Edit` / `Write` / `Bash`-that-modifies-code until a Canon workspace exists for the current flow. This is justified by the intent-misclassification drift concern and is internally consistent with v2's philosophy (hard layers where soft layers aren't enough).

The L4 addition has blast-radius questions (§4 below) but the architectural motivation is sound.

---

## 2. Integration with v2's diagnosis

v2 identified 27 cross-cutting integrations (11 HIGH, 11 MEDIUM, 5 LOW) that v1's Phase 1/2 code had missed. The gap audit was v2's most important contribution — it is why v2 existed at all. The question for v2.1 is whether synthesis or the learning loop reopens any of those integrations.

**Finding: no integration is reopened.** v2.1 §9 reproduces v2 §3's disposition table verbatim (native / mcp / hook / guidance / deprecate) and preserves every HIGH-severity disposition. The additions layer **above** the integration surface:

- **Synthesis** operates at plan composition. Each step in a synthesized runbook still routes through the same MCP tools, hooks, and native capabilities v2 specified for the 27 integrations.
- **Learning loop** reads from integration outputs (review findings, drift events, HITL events) and writes to Canon artifacts (principles, skills, templates). It does not replace or rewire any integration.

Two v2.1 additions touch the integration surface but add rather than reopen:

- **`snapshot_workspace` (v2.1b)** is a new MCP tool extending the drift-db layer. It is scoped to one new table (`lifecycle_workspace_snapshots`) and one migration. It does not modify existing integration paths.
- **`canon-workspace-check.sh` (v2.1a L4)** is a new PreToolUse hook. It complements the existing hook model (TaskCompleted, PostCommit, etc.) without altering the behavior of any existing hook.

v2's integration dispositions are preserved. v2.1's additions are genuinely new surface, correctly added alongside rather than through v2's architecture.

---

## 3. Phasing and ratification

The phase structure is disciplined:

```
v2 Phase 1 (Gate A) → v2.1a → v2.1b (Gate B) → v2.2 → Phase 2 → Phase 3
```

### 3.1 Gate A is the right blocker

§15.1 / §10.1 identify Gate A (v2 Phase 1 completion) as the substantive prerequisite. Specifically: `canon-planner` and `canon-engineer` agent definitions must exist and be validated in ≥ 3 successful runs before v2.1a starts. Today neither agent exists (only `canon-implementor` and `canon-fixer`). The plan correctly refuses to start v2.1 work against phantom prerequisites.

This matters because v2.1's synthesis architecture depends on `canon-planner` as a real agent with real tools, not a notional role. A Gate A that is "met once the agents exist" rather than "met by reading the v2 plan and declaring victory" is the right discipline.

### 3.2 v2.1a / v2.1b split has the right shape

v2.1a ships **synthesis without persistence**: vocabulary, two skills, planner rewrite, L1 + L4 enforcement. Exit criterion is ≥ 5 distinct request types processed end-to-end with the synthesis contract holding. This is well-scoped — no new tables, no new learner dimensions, no observation tags.

v2.1b ships **one table, one tool, three tags, one learner dimension**. Exit criterion (Gate B): ≥ 1 principle-refinement proposal from real lifecycle data that a human accepts and applies. This is the minimum viable learning loop, and it is correctly factored to prove the loop closes before expanding.

v2.2 is deliberately contingent: it ships only after v2.1b produces ≥ 3 proposals with ≥ 1 accepted. This is good — it prevents surface expansion on an unproven substrate.

### 3.3 Exit criteria are concrete

Each phase's exit criteria are specific and measurable:

- **v2 Phase 1 (Gate A):** two agent defs, ≥ 3 runs, 5 hook scripts registered, build + tests pass
- **v2.1a:** ≥ 5 request types, L1 + L4 observed against intent-misclassification
- **v2.1b (Gate B):** ≥ 1 accepted principle proposal, schema migration clean and reversible
- **v2.2 (per-expansion):** each refinement target demonstrates observation → refinement cycle

Phase 2 validation (§10.5) extends v2's validation table with synthesis-specific deliverables (iterate-until-approved quality, vocabulary version resume) and learning-specific deliverables (learner baseline Gate B, confidence calibration). Every row has a pass criterion. No validation item is left as "review for correctness."

### 3.4 Rollback paths are documented

§12.2 specifies per-phase rollback:

- v2.1a: revert CLAUDE.md amendments + remove L4 hook + revert planner body
- v2.1b: drop the one table + revert the one tool + revert tag additions + revert learner dimension
- v2.2: per-expansion reversibility
- Feature flag (`CANON_AGENT_TEAMS_MODE=off`) preserves legacy path throughout

The rollback story holds because each phase's scope is small enough to reverse cleanly. A monolithic v2.1 would not have this property.

### 3.5 Where phasing is weakest

One area for improvement: the v2.2 entry gate ("v2.1b has shipped ≥ 3 proposals, of which ≥ 1 accepted") is a volume threshold, not a quality threshold. A v2.1b that produces 3 low-value proposals of which 1 was accepted out of scope-review fatigue still clears the gate. Recommend adding a qualitative criterion — e.g., "the accepted proposal produces a measurable reduction in the corresponding principle's drift finding rate over N subsequent flows." This is partially addressed by Phase 2 confidence calibration but not for the learner's own output. (See §4 MEDIUM-1.)

---

## 4. Concerns

### 4.1 HIGH-severity

#### HIGH-1 — L4 hook blast radius is under-specified

**Concern.** §6.5 specifies `canon-workspace-check.sh` as a PreToolUse hook that blocks `Edit` / `Write` / `Bash`-that-modifies-code when no active Canon workspace exists for the current flow. §2.10 layer 5 describes the same hook. Neither section specifies how the hook determines:

- What counts as "modifies code" for Bash (every Bash call? only commits? only shell that invokes editors?)
- What counts as "the current flow" (branch match? directory match? conversation turn?)
- How the hook behaves during legitimate non-build Canon activity (doc edits, principle authoring via `canon-writer`, slash-command operations)

**Evidence.** v2.1.md:296 (`Blocks 'Edit' / 'Write' / 'Bash'-that-modifies-code when no active Canon workspace exists`); v2.1.md:682 (`Detection: checks for an active .canon/workspaces/<slug>/ matching the current branch`).

**Why this is HIGH.** A pre-tool hook is by definition an interruptive force. Blocking legitimate edits is worse than the drift it prevents, because Canon loses user trust the first time it blocks a one-line doc fix. The branch-match detection ("matching the current branch") is plausible but shipped ambiguous — Canon workspaces can be shared across branches for agent-team flows, and a user on a doc-only branch with no active workspace is not in the class the hook is protecting against.

**Recommended action.** Before v2.1a ships L4:

1. Specify the full decision table: `(tool, argument-pattern, branch-state, workspace-state) → {allow, block-with-message, allow-with-warning}`
2. Enumerate legitimate pre-build states the hook must allow (doc edits outside `.canon/`, principle authoring sessions, slash-command invocations, non-code changes)
3. Ship with a bypass for explicit user-declared intent (e.g., `CANON_BYPASS_WORKSPACE_CHECK=1` for a single command, or a clear message path telling the user how to unblock)
4. Validate L4 against a checklist of false-positive scenarios in Phase 2

#### HIGH-2 — Iterate-until-approved friction is acknowledged but untested

**Concern.** §6.3 acknowledges that every build request now has a synchronous planner round-trip. This is a material change from today's autodispatched fast-path. §6.2's mitigation is the "lightweight-proposal" pattern — trivial requests get 1-step runbooks cleared in seconds. But the plan does not measure whether this actually holds until Phase 2.

**Evidence.** v2.1.md:664–667 (`Every build request now has a synchronous planner round-trip... Phase 2 validation will measure actual round-trip cost for the trivial-request case; if it's intolerable in practice, revisit this section`).

**Why this is HIGH.** If trivial-request latency is intolerable in Phase 2, the remediation surface is large. Options are: (a) reintroduce a skip path (contradicts §6.2's "thin-gate-no-skip" decision), (b) parallelize planner with early execution (non-trivial rework), (c) ship a more lightweight planner path (possible but requires spec). Discovering this at Phase 2 means paying for a full design re-cycle during validation rather than before v2.1a ships.

**Recommended action.** Before v2.1a ships:

1. Define a concrete latency target for trivial-request iteration 0 (e.g., "planner emits first proposal within N seconds of user message, where N ≤ 15")
2. Spike the lightweight-proposal path against 3 representative trivial requests before committing to v2.1a
3. If the spike shows latency > 2× current fast-path, pause v2.1a and design a mitigation before committing to iterate-until-approved

#### HIGH-3 — Confidence signal is user-facing without calibration

**Concern.** §7 makes `confidence` + `confidence_signals[]` visible during iteration. §7.3 makes it advisory (not gating). §7.4 acknowledges LLM overconfidence bias and specifies six mitigations, but also states "v2.1a/b ships with unvalidated confidence calibration." Calibration detection happens in v2.2 via the learner.

**Evidence.** v2.1.md:762 (`v2.1a/b ships with unvalidated confidence calibration. Users should treat v2.1a/b confidence as 'directional indicator' not 'precise probability' until v2.2 learner calibration catches up`).

**Why this is HIGH.** Confidence is user-facing. Users make real decisions during iteration based on it — "0.62 is low, let me clarify more" or "0.91, this is fine." If the first months of v2.1 produce consistently mis-calibrated scores (systematically high because LLMs skew that way), users will (a) calibrate their own expectations off the noisy signal, or (b) learn to ignore it. Either outcome damages the signal's long-term value. The v2.2 learner calibration is the correct remediation, but it runs on data that was collected under miscalibrated conditions.

**Recommended action.** Before v2.1a ships:

1. Present confidence with an explicit miscalibration disclaimer in the user-facing rendering ("directional indicator; calibration pending v2.2")
2. Collect calibration pairs (confidence, human-graded quality) from v2.1a day one, not as a Phase 2 deliverable — so v2.2 has a clean corpus from day one
3. Consider capping displayed confidence at 0.8 in v2.1a (prevent 0.95-range scores from training users that high confidence means anything specific)

### 4.2 MEDIUM-severity

#### MEDIUM-1 — v2.2 entry gate is volume-based, not quality-based

**Concern.** §10.4's entry gate ("≥ 3 proposals, ≥ 1 accepted") counts proposals and acceptances but does not measure whether accepted refinements improved anything.

**Evidence.** v2.1.md:1067 (`Entry gate: v2.1b has shipped ≥ 3 principle-refinement proposals, of which ≥ 1 has been accepted and applied`).

**Recommended action.** Add a qualitative criterion to §10.4 entry gate: "and the accepted proposal produces a measurable reduction in the corresponding principle's violation rate over the next N flows after application, OR a human reviewer explicitly signs off that the refinement improved principle clarity." This makes the gate outcome-grounded.

#### MEDIUM-2 — Synthesis skill becomes the new single point of failure

**Concern.** v2 specified 5 hand-authored runbook files; v2.1 replaces them with 1 vocabulary + 2 skills. A bug in the synthesis skill propagates to every flow type simultaneously. v2's 5-file model had natural redundancy (fast-path drift didn't affect feature flows); v2.1's 3-file model does not.

**Evidence.** v2.1.md:45–50 (5 static files → 1 vocabulary + 2 skills + iterate-until-approved loop); §5.3 is the full contract surface.

**Recommended action.** Two complementary mitigations:

1. Maintain a **synthesis regression suite**: 5–10 canonical test requests (bug fix, small feature, migration, etc.) with expected runbook shapes. Re-run on every synthesis-skill change to catch drift.
2. Add synthesis-skill changes to the weekly learner-curation review cadence (§3.4) so changes have human sign-off before landing.

#### MEDIUM-3 — Orchestration journal remains single point of completion enforcement

**Concern.** v2 flagged this as MEDIUM / MEDIUM; v2.1 extends the journal with `domain_skills_loaded` and `outcome` fields (§2.9), increasing dependence on the journal being populated. The completion hook blocks if entries are missing, but nothing prevents the lead from calling `log_step` with sparse data.

**Evidence.** v2.1.md:265–270 (`domain_skills_loaded` field; `outcome` field); v2.md line 672 (original MEDIUM risk).

**Recommended action.** Strengthen `verify_completion` to also check field completeness, not just step completeness. If `log_step` was called but `mcp_tools_called` or `domain_skills_loaded` is empty for steps where they are expected, flag as warning. Journal-field quality becomes part of the completion gate.

#### MEDIUM-4 — Vocabulary resume on major-version change is thin

**Concern.** §5.1 specifies that locked-runbook resumes across major vocab versions trigger a regeneration with full workspace context. The regeneration re-runs the planner and requires user re-approval. But the spec does not address: what if the user rejects the regenerated runbook? Is the prior approved runbook still executable? Does the flow abort? Resume semantics across vocab boundaries are under-specified.

**Evidence.** v2.1.md:572–573 (`Locked-runbook resumes continue with the synthesis-time vocab unless a referenced entry was removed in a later major version. If removed, the planner regenerates the runbook...`).

**Recommended action.** Spec the full state-transition graph for vocab-version resume: (prior-approved runbook exists, vocab removed entry) → (regen proposed) → {regen-approved: execute new; regen-rejected: offer to abort or continue under deprecated vocab with warning}. Decide whether deprecated-vocab continuation is permitted.

#### MEDIUM-5 — Lifecycle DB and workspace are both "sources of truth" at different times

**Concern.** §8.2 says workspace is source of truth while the flow runs; `lifecycle_workspace_snapshots` is source of truth after. The boundary is `snapshot_workspace` at completion. This is fine for analytics but means mid-run dashboards cannot exist without reading the workspace directly, and the workspace layout is ephemeral. Any tool that needs to "show me what's happening in active flows" must read per-flow workspace files.

**Evidence.** v2.1.md:822–829 (`In-progress flows are queried from the workspace, not the DB. Real-time dashboards / mid-run interventions are out of scope for v1`).

**Recommended action.** Accepted as a v2.1 scope decision, but document in §14 Out of Scope (not just §8.2) so future work sees it as a deliberate choice. Current §14 does not list this.

### 4.3 LOW-severity

- **LOW-1.** v2 source doc has duplicate section numbers (§2.4, §2.5, §2.7 appear twice). v2.1 does not inherit the duplication, but rewriting v2 to align with v2.1 should renumber cleanly.
- **LOW-2.** Naming: "v2.1a / v2.1b / v2.2" plus "v2 Phase 1 / Phase 2 / Phase 3" is a dense labeling scheme. Consider a summary table in §10 with every phase label and its one-line scope, so readers have a single disambiguation reference.
- **LOW-3.** §3.5 introduces cross-target analyses for v2.2 but does not bound the analysis budget. "Cross-target proposals are higher-signal but require more analysis surface" — the learner could spend unbounded compute on correlation queries. Add a soft budget (e.g., ≤ N cross-target analyses per curation cycle).
- **LOW-4.** §4.2 lists `memory_cited: [item_id]` as deferred to v2.2 alongside memory work — but §10.4 defers memory itself to v2.2 audit / v2.3+ seeding. The deferral boundary is correct; just note the two references for consistency.
- **LOW-5.** Confidence signal `novelty` is described as "Planner's `memory: project` + `query_workspace_history`" in §7.2 but `query_workspace_history` is v2.2. What computes novelty in v2.1a/b? Presumably the planner's memory alone — spec this explicitly.

---

## 5. Rewrite guidance for v2

The v2 document (`docs/agent-teams-migration-plan-v2.md`, 698 lines) becomes the **v2.1-aligned implementation plan** — the document an executor reads to actually run the migration. v2.1 stays as the architectural source. v2's structure is adapted section by section:

### 5.1 Preserve (copy forward, minor polish only)

- **v2 §1 "What v1 got right" / "What v1 got wrong"** → preserve. This is the diagnostic foundation; v2.1 §1.1a explicitly inherits it. Retain the 27-gap audit reference and the Phase 1/2 abandonment note.
- **v2 §3 Integration Disposition Table (HIGH / MEDIUM / LOW, 27 rows)** → preserve wholesale. Becomes rewritten v2's Integration Disposition section (renumber per new section layout). Mirrors v2.1 §9.
- **v2 §7 Out of Scope (items 1–10)** → preserve, extend with v2.1 additions (items 11–15 from v2.1 §14).
- **v2 §4 Phase 2 deletion file list and validation checkpoints** (v2 §4 Phase 3 sub-phases 3a/3b/3c) → preserve wholesale. v2.1 inherits Phase 3 unchanged.

### 5.2 Replace (rewrite with v2.1 content)

- **v2 §2 Target Architecture** → rewrite per v2.1 §2. Replace the single "Canon-as-toolkit" diagram with the iterate-until-approved flow (v2.1 §2.2). Add §§2.3 (planner v2.1 responsibilities), 2.4 (orchestration example with iterate-until-approved), 2.9 (orchestration journal with v2.1 extensions), 2.10 (8-layer defense-in-depth including L4).
- **v2 §4 Phase 1 Deliverables table** → remove the 5 static runbook file rows (`phase1-01..04`). Keep agent def updates (now creating `canon-planner` and `canon-engineer` via `phase1-08`), orchestration journal, commit trailer hook, completion verification hook, SessionStart hooks, SubagentStop hook, feature flag. Add explicit note that `phase1-05..10` remain required and Gate A depends on `phase1-08`.
- **v2 §6 Risks (10 rows)** → replace table with v2.1 §13's 15-row table. New v2.1 risks: planner runbook inconsistency, intent misclassification drift (L1+L4), vocab drift, observation tag compliance, LLM overconfidence, learner scope creep. Carry forward all v2 risks.

### 5.3 Add (net new sections in rewritten v2)

- **§ Learning system** → v2.1 §3 content. Observation → pattern → proposal → refinement mechanism; 5 in-scope refinement targets; supervised curation model. Include §3.3 target matrix as-is.
- **§ Observation mechanism** → v2.1 §4 content (hybrid structured tags + prose; closed schema per §4.6; HITL event taxonomy per §4.5).
- **§ Synthesis architecture** → v2.1 §5 content. 15-ID vocabulary; step schema (`skills:`, `cause:`); synthesis contract (MUST / MAY / MUST NOT); iterate-until-approved loop.
- **§ User-approval affordance** → v2.1 §6 content. Conversational mechanism, lightweight proposals for trivial work, L1 (re-classification discipline), L4 (pre-write gate + hook), friction acknowledgment.
- **§ Confidence scoring** → v2.1 §7 content. Schema, signals, HITL invariant (confidence is advisory), overconfidence mitigations, per-iteration rescoring.
- **§ Lifecycle persistence substrate** → v2.1 §8 content. `lifecycle_workspace_snapshots` table (v2.1b), `snapshot_workspace` MCP tool (v2.1b), `query_workspace_history` (deferred to v2.2), drift-db extension rationale, retention policy, privacy and sharing.
- **§ Ratification gates** → v2.1 §15 content. Gate A (existence — THE BLOCKER), Gate B (evidence — runnable today), Gate C (scope discipline — done). Include expected timeline (§15.5) and the "Do NOT" list.

### 5.4 Restructure (phase layout)

Rewritten v2's phase section replaces v2 §4 with v2.1 §10's structure:

```
v2 Phase 1 (Gate A) → v2.1a → v2.1b (Gate B) → v2.2 → Phase 2 → Phase 3
```

Each phase gets its own subsection with entry gate, scope, out-of-scope, exit criteria. Phase 2 validation table (v2.1 §10.5) replaces v2 §4 Phase 2 table.

### 5.5 Header metadata

The rewritten v2 header should carry:

- **Status:** REVISED — implementation plan aligned with v2.1 architecture
- **Supersedes:** v1 (`docs/agent-teams-migration-plan.md`)
- **Aligned with:** `docs/agent-teams-migration-plan-v2.1.md` (architectural source)
- **Last updated:** 2026-04-19
- Retain v2's audit-source reference (28-gap integration audit)

v2.1 remains the architectural document; v2 becomes the ratifiable executable plan. Both ship; neither is deleted.

### 5.6 Do NOT

- **Do NOT delete v2.1.** It is the architectural source of truth. Rewriting v2 does not invalidate v2.1.
- **Do NOT delete `docs/runbook-synthesis-proposal.md`** (the PR #115 synthesis conversation log) — per v2.1 §15.5.
- **Do NOT amend Phase 1 plan files in `.canon/workspaces/agent-teams-v2/plans/phase1/` preemptively** — per v2.1 §15.5. Those are pre-v2.1 spec; edit them as part of v2.1 ratification, not ahead of it.
- **Do NOT drop v2's 27-gap audit.** It is v2's most important contribution and the reason v2 existed. Rewritten v2 must preserve the Integration Disposition Table in full.

---

## Summary

| Dimension | Assessment |
|-----------|-----------|
| Architectural soundness | Sound with conditions |
| Integration preservation | No reopening; additions layer above v2's 27 dispositions |
| Phasing | Disciplined; Gate A is the correct blocker |
| Ratification | 3 gates concrete; Gate B runnable today |
| HIGH-severity blockers | 3 (L4 blast radius, friction untested, confidence uncalibrated) |
| MEDIUM concerns | 5 |
| LOW / nits | 5 |
| Rewrite scope for v2 | Preserve 4 sections, replace 3, add 7, restructure phases |

Proceed with v2 rewrite once the three HIGH-severity concerns have a documented resolution path in v2.1 or are accepted as ship-with residual risks with explicit owner + mitigation plan.
