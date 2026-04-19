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

*Remaining sections: integration assessment, phasing assessment, concerns, rewrite guidance — appended in subsequent commits.*
