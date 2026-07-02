---
name: escalation-protocol
description: >-
  Auto-escalation strategy table and protocol for Canon agent failures and stuck
  conditions. Covers strategy semantics (add_primer, increase_budget,
  escalate_model, narrow_scope, hitl), flow-specific config, 2-minute timeout,
  adversarial-surface rethink signal, stream-idle recovery detail, and architect
  re-spawn tracking.
---

# Escalation Protocol

<!-- Managed by Canon. Manual edits are preserved. -->

**Purpose**: Strategy semantics and rethink signals for agent failures. Read BEFORE applying a strategy returned by `get_next_escalation_strategy`, and for the adversarial-surface rethink signal. See `CLAUDE.md` § Auto-Escalation Protocol for the inline one-liner and `CLAUDE.md` § Agent Spawn Error Handling for the error-pattern table.

### Auto-Escalation Protocol
<!-- last-updated: 2026-07-02 -->

When an agent failure or stuck condition is detected (`isStuck` returns true, agent returns error, or retry fails), call `get_next_escalation_strategy({ workspace, step_id, flow_config? })` BEFORE escalating to HITL.

| Strategy | How to apply |
|----------|-------------|
| `add_primer` | Add the domain primer for the failing area to the re-spawn prompt: "Relevant domain primers: {domain}. Load from ${CLAUDE_PLUGIN_ROOT}/primers/{domain}.md." |
| `increase_budget` | Double the `turn_budget` in the re-spawn prompt (cap at 80). |
| `escalate_model` | Add `model: "opus"` to the Agent call. |
| `narrow_scope` | Split the failing task's file list in half. Re-spawn with only the first half. Queue the second half as a follow-up. |
| `hitl` | Current behavior — escalate to user via HITL. |

**When to call**: Replace the current "retry once then HITL" pattern. On first failure: call `get_next_escalation_strategy`. On subsequent failures of the same step: call again (it tracks state and returns the next strategy). When `is_terminal: true`, escalate to HITL.

**Flow-specific config**: Pass `flow_config: { skip_strategies: ["narrow_scope"] }` for security flows. The escalation tool handles the skip internally.

**Timeout**: The tool enforces a 2-minute cumulative timeout. If the cascade has been running for 2+ minutes, it returns "hitl" regardless of remaining strategies. The orchestrator does not need to track time separately.

**Adversarial-surface iteration signal**: When a fix loop OR a security-re-review loop runs 3+ rounds AND every reviewer finding in those rounds is a confirmed true positive on a NEW, distinct bypass or failure class (not a regression introduced by a prior fix, not noise, not churn), surface the following signal to the user BEFORE spawning another patch engineer: "Fix loop at N rounds: all findings are true positives on new bypass classes. This surface likely needs a vocabulary-free / authoritative-primitive design change rather than another patch iteration. Consider delegating to the authoritative platform primitive or relocating the gate — see `[[delegate-to-authoritative-primitive]]`." The discriminator: true positives on new classes (different shapes each round) → rethink signal; same shape re-introduced or churn → normal HITL escalation.

**Newer corroborating instances (watch_JJJJJJ2)**: PR #419 — an 8-round CWD-scoping and push-detection trajectory — converged by relocating the gate to git's own `pre-push` hook, an authority relocation rather than another parser patch (the user manually invoked the stop-and-rethink after round 4, one round later than the signal above would have fired). PR #428 — a 7-pass security re-review arc over a prompt-injection trust boundary — converged via a compile-time opaque `UntrustedText` type (closes the fencing-coverage enumeration at the type checker) and a linear-time DP `matchGlob` engine replacement (closes the ReDoS class structurally rather than blocking specific patterns). Both convergences are structural changes, not enumeration, reinforcing the discriminator above: keep enumerating and the loop continues; replace the enumeration with a structural or authoritative primitive and it terminates.

### Stream-Idle Timeout Recovery Detail

**Stream-idle timeout recovery (watch_NNNNN2)**: A stream-idle stall is a mid-run failure, NOT a spawn failure — it is excluded from the backoff-retry path. FIRST response: send the stalled agent a brief continuation message (SendMessage resume). Both observed instances (PR #336 renderer mid-composition; PR #338 engineer mid-reading) recovered losslessly with full context intact. Only if the resume elicits no response within ~30s, fall back to the Auto-Escalation Protocol and, if re-spawning, the Re-spawn Enrichment Protocol. Re-spawn is the fallback, never the first response.

### Architect Re-spawn Tracking

**Architect re-spawn tracking**: When architect requires 2+ spawn attempts, record reason in `log_step` outcome `review_verdict` field as `"respawn:{reason}"` (values: `artifacts_missing`, `rate_limit`, `auth_failure`, `ttl_ordering`, `timeout`).
