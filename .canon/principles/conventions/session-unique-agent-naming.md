---
id: session-unique-agent-naming
title: Session-Unique Agent Names Prevent SendMessage Misrouting Under Concurrent Sessions
severity: convention
portable: false
scope:
  layers: []
  file_patterns:
    - "CLAUDE.md"
    - "agents/**"
    - "references/**"
tags:
  - concurrency
  - orchestration
  - agent-naming
  - sendmessage
---

Every `Agent()` call in an orchestrator session MUST use a session-scoped name when the workspace may be co-driven by concurrent orchestrators. The canonical form is `{agent-type}-{step_id}-{job_suffix}`, where `job_suffix` is the first 8 characters of `basename($CLAUDE_JOB_DIR)`.

**Canonical form:**
```
{agent-type}-{step_id}-{job_suffix}
```

**Example:** `reviewer-review-r3-72f2b372` instead of `reviewer-1`.

**`job_suffix` derivation** (available in the orchestrator's shell environment):
```bash
job_suffix=$(echo "${CLAUDE_JOB_DIR##*/}" | cut -c1-8)
# Example: CLAUDE_JOB_DIR=/Users/michelle/.claude/jobs/72f2b372 → job_suffix=72f2b372
```

**Spawn pattern addition** (insert in CLAUDE.md `Spawn pattern` section):

> **Multi-session naming**: when the workspace may be co-driven by concurrent orchestrators (background learner, ship-watch, or peer build), every `Agent()` name MUST include a session-unique suffix. Canonical form: `{agent-type}-{step_id}-{job_suffix}` where `job_suffix = basename($CLAUDE_JOB_DIR).slice(0, 8)`. Example: `reviewer-review-r3-72f2b372`.

## Rationale

**The 2026-06-24 incident:** Sessions `72f2b372` and `6429ca3b` both ran review fan-out. Both spawned an agent named `reviewer-1`; both spawned `renderer-review`. The workspace mutex ([[workspace-mutex-exclusive-init]]) was not yet implemented. When a stream-idle timeout occurred on one session's `reviewer-1`, the stream-idle recovery protocol (watch_NNNNN2) sent a `SendMessage` resume to `reviewer-1` — but the harness resolves agent names globally. The resume message could route to the peer session's reviewer instead of the stalled one, delivering an out-of-context continuation to the wrong agent.

**Structural hazard:** The harness routes `SendMessage` by bare agent name. Two concurrent sessions that both call their reviewer `reviewer-1` create an ambiguous name. The stream-idle protocol fires `SendMessage` as its *first* response to a stall — the fastest path. If the name resolves to the peer's agent, the intended agent is never resumed and the peer agent receives a confusing continuation. Both builds may then proceed in degraded states.

The workspace mutex reduces the concurrent-session window for *normal* builds. It does not eliminate the risk for legitimate multi-session workflows: a background learner + foreground build, a ship-watch tick + a new build, or a background renderer alongside an orchestration step. These cases are valid and expected. Session-unique naming is the complementary behavioral guard that works regardless of whether a mutex is held.

## Scope and Exceptions

**MUST use session-unique naming:**
- Any agent that may receive `SendMessage` during its run (reviewers, engineers on long implementations, architects)
- Any agent spawned in a workspace shared with concurrent orchestrators

**SHOULD use session-unique naming (for consistency; exceptions acknowledged):**
- Read-only one-shot agents that never receive `SendMessage` and are not expected to be resumed (tester, scribe on a fix-type build)

**MAY use short names (explicit exception):**
- Background utility agents (renderers, evaluators) that are immediately awaited and never contacted via `SendMessage` — shorter names are permissible but the pattern is recommended for observability

## Examples

**Bad — bare name; ambiguous across sessions:**

```typescript
// Session A:
Agent({ name: "reviewer-1", prompt: "Review files A–D ...", ... })

// Session B (concurrent):
Agent({ name: "reviewer-1", prompt: "Review files E–H ...", ... })

// Stream-idle stall on Session A's reviewer:
SendMessage({ to: "reviewer-1", message: "Continue from where you stopped..." })
// → may route to Session B's reviewer-1 instead
```

**Good — session-unique name:**

```typescript
// Session A (CLAUDE_JOB_DIR = /Users/michelle/.claude/jobs/72f2b372):
const suffix = "72f2b372";
Agent({ name: `reviewer-review-r1-${suffix}`, prompt: "Review files A–D ...", ... })
// → "reviewer-review-r1-72f2b372"

// Session B (CLAUDE_JOB_DIR = /Users/michelle/.claude/jobs/6429ca3b):
const suffix = "6429ca3b".slice(0, 8);
Agent({ name: `reviewer-review-r1-${suffix}`, prompt: "Review files E–H ...", ... })
// → "reviewer-review-r1-6429ca3b"

// Stream-idle stall on Session A's reviewer:
SendMessage({ to: "reviewer-review-r1-72f2b372", message: "Continue from where you stopped..." })
// → unambiguously routes to Session A's reviewer
```

**Good — step_id + suffix for parallel fan-out:**

```typescript
// Fan-out: R1, R2, R3 reviewers in same session (job_suffix = "72f2b372"):
Agent({ name: "reviewer-review-r1-72f2b372", ... })
Agent({ name: "reviewer-review-r2-72f2b372", ... })
Agent({ name: "reviewer-review-r3-72f2b372", ... })
// → each agent has a unique name within the session AND across concurrent sessions
```

## Relationship to workspace-mutex-exclusive-init

The workspace mutex ([[workspace-mutex-exclusive-init]]) and session-unique naming address different surfaces of the same class of concurrent-session bug:

- **Mutex:** prevents two orchestrators from co-driving the same workspace through init/finalize (coarse outer guard).
- **Naming:** prevents SendMessage resume messages from routing to the wrong agent when names collide (fine inner guard for agent-level concurrency).

Both are required. The mutex does not eliminate all multi-session windows (legitimate concurrent workflows exist). Naming does not prevent workspace-state races (two orchestrators can share a name-namespace even if one doesn't hold the lock). They are complementary, not alternatives.

## Verification

```bash
# Confirm spawn pattern section includes multi-session naming guidance:
grep -n "Multi-session naming\|job_suffix\|session-unique" CLAUDE.md

# Confirm no agent spawns use bare reviewer/renderer names without a suffix
# (search spawning code in references/orchestration docs):
grep -rn 'name: "reviewer-[0-9]"\|name: "renderer-review"\|name: "engineer-[0-9]"' \
  CLAUDE.md references/ --include="*.md"
# Expected: zero hits for bare names without a suffix
```

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "The workspace mutex prevents concurrent sessions — naming doesn't matter." | The mutex gates `init_workspace` / `finalize_workspace`, not the agent lifecycle. Legitimate multi-session workflows (background learner, ship-watch) exist and are expected. Name collision is possible even without a competing build. | Use session-unique naming regardless of mutex state. |
| "I use numbers: reviewer-1, reviewer-2. They're unique within my session." | They're unique within your session, but not across concurrent sessions. The harness name-resolution scope is global, not per-session. | Append the job_suffix: `reviewer-1-72f2b372`. |
| "SendMessage is only for stream-idle recovery — it rarely fires." | Rarely is not never. Stream-idle timeouts are common on long composition steps (PR #336 renderer, PR #338 engineer, both in production). The stream-idle protocol fires `SendMessage` as its *first* response, before any fallback. | Name agents session-uniquely so the first response is correct. |
| "I'll just be careful not to stall." | Stalls are not always under the orchestrator's control — they happen on large diffs, slow network reads, and long MCP round-trips. Naming is the structural fix; care is not. | Use session-unique naming unconditionally. |

## Related

- [[workspace-mutex-exclusive-init]] (OOOOOOOOOO4) — outer workspace guard; complementary to naming (mutex prevents workspace co-drive; naming prevents agent misrouting)
- [[step-scoped-review-artifacts]] (OOOOOOOOOO1) — step-scoped paths prevent artifact overwrite; session-unique names prevent message misrouting; same concurrent-session class
- [[pre-mutate-reread-gate]] (OOOOOOOOOO3) — re-read before mutation; the naming convention prevents resume-message misrouting; the re-read gate prevents stale-state mutations
- `watch_NNNNN2` (stream-idle timeout recovery) — the protocol that fires `SendMessage` on stall; the trigger that makes session-unique naming load-bearing
