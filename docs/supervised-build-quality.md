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

## What's Next: Epic 6 — Cross-Agent Learning Loop

Close the gap between learner suggestions and applied changes. The learner already runs every build and writes proposals to `.canon/proposed-learnings/` — but humans must manually review and apply them.

### Auto-application rules

| Pattern | Threshold | Action |
|---------|-----------|--------|
| Convention promotion | Compliance > 95% across 5+ builds | Auto-promote to strong-opinion |
| Principle demotion | 0 violations across 20+ builds, no reviewer citations | Auto-archive (soft delete) |
| Build pattern | Same failure mode in 3+ builds in same area | Auto-add to architect primer for that area |

### Feed-forward enrichment

Before agent spawns, inject context from build history:

- **Before architect**: query drift.db for common failures in touched files → inject as "known pitfalls"
- **Before engineer**: query build history for previous fix attempts in same area → inject as "prior approaches"
- **Before reviewer**: query principle violation history for files → inject as "watch areas"

### Infrastructure that already exists

- `signal-compiler.ts` scores violations by priority per file
- `drift-db-signals.ts` has `getFileViolationHistory` and `getPathEffects`
- `get_context` already batches signals for spawn prompts (just needs `signals` in the `include` array)
- Learner produces structured findings to `.canon/proposed-learnings/`

### What needs building

- Threshold logic for auto-promotion/demotion (query drift.db for compliance rates across N builds)
- Feed-forward injection in orchestrator's MCP Tool Composition (add `signals` to implement/design `include` arrays, format as "known pitfalls" section in spawn prompts)
- Auto-apply policy config: `auto` | `suggest` | `off` (per project)
- Audit trail for all auto-decisions (log to journal)

## Supervised Build Quality — Feature Backlog

Three threads for making supervised builds faster and higher quality. Features are harvested from prior roadmap docs and prioritized by leverage.

### Thread 1: Fewer Review-Fix Loops

The biggest time sink. If the engineer gets it right first pass, you skip 1-2 full review cycles.

| Feature | Effort | Leverage | Source |
|---------|--------|----------|--------|
| **Feed-forward enrichment** (Epic 6) | Medium | Very high | Inject known pitfalls before engineer starts |
| **Cross-session error + fix index** | Medium | High | Engineer inherits prior fix patterns. `error_fixes` table in execution store, populated from `write_implementation_summary`. Queried via `get_context` before engineer spawn. |
| **Short-term area memory** | Small | High | Compact observations attached to subsystems with 7-day expiry. Next agent in same area gets them pre-injected. |

### Thread 2: Better HITL Presentations

Make each gate decision faster and more confident.

| Feature | Effort | Leverage | Source |
|---------|--------|----------|--------|
| **Confidence per violation** | Small | High | `write_review` gains a `confidence` field (0-100) per violation. Default threshold: 80; findings below suppressed. Reduces noise. |
| **Confidence decay for drift** | Medium | Medium | Replace binary pass/fail with 0.0-1.0 confidence that decays as commits accumulate without re-review. Sorts drift report by "most overdue." |

### Thread 3: Faster Agent Turns

Context gathering burns the most agent turns. Reduce wasted work.

| Feature | Effort | Leverage | Source |
|---------|--------|----------|--------|
| **Tool-level loop detection** | Small | High | PostToolUse hook fingerprints `(tool + input + output)`. 3 consecutive identical = exit code 2 → HITL. Stops agents spinning on identical failing calls. |
| **In-flight spawn watchdog** | Small | High | Track start timestamp per spawn. Wall-clock threshold (default: 20 min) surfaces long-running agents with options to wait, cancel, or intervene. |
| **PostCompact narrative capture** | Tiny | Medium | PostCompact hook appends compaction summary to workspace journal. Prevents re-discovery after context reset. ~50 LOC. |
| **Skill effectiveness tracking** | Medium | Medium | Learner analyzes journal outcomes to recommend: primers that help, `maxTurns` adjustments, skills that need updating. Requires extending `FlowRunEntry` with domain skill counts. |

### Not Doing

These were evaluated and explicitly rejected:

- **Scheduled builds via CronCreate** — Infrastructure reinvention. GitHub Actions + existing monitoring tools do this better.
- **Event-driven triggers (RemoteTrigger)** — Same reasoning. External shim complexity for a solo dev project.
- **Streaming observability pipeline** — JSONL + existing tooling is sufficient. No custom dashboard.
- **Progressive trust model** — Interesting but premature. Need 50+ builds of data before trust scores are meaningful. Revisit when build history is deep enough.
- **Autonomous PR lifecycle** — Removes the human from post-ship. The value of review comments is high; auto-responding risks missing nuance.
- **Recursive agent spawning** — Research shows 37% of multi-agent failures are coordination failures. Canon's flat orchestrator-worker hierarchy is correct.

## Recommended Build Order

| Phase | What | Rationale |
|-------|------|-----------|
| **Next** | Epic 6 — feed-forward enrichment only | Highest leverage single feature. Infrastructure exists. Directly reduces fix loops. |
| **Then** | Tool-level loop detection + spawn watchdog | Small builds, immediate value for agent efficiency. |
| **Then** | Cross-session error index | Requires Epic 6 infrastructure + sufficient build history. |
| **Later** | Confidence per violation, area memory, skill tracking | Compound value features that improve over time. |
