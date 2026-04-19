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

*Remaining sections: HIGH/MEDIUM/LOW concerns, rewrite guidance for v2 — appended in subsequent commits.*
