---
task_id: "v2_1a-04"
wave: 3
depends_on: ["v2_1a-00", "v2_1a-01", "v2_1a-02"]
decisions:
  - "dc-05"
files:
  - CLAUDE.md
principles:
  - agent-surface-assumptions
domains:
  - infrastructure
---

## Task: Amend CLAUDE.md with L1 re-classification discipline

### Action

Amend `CLAUDE.md` with two additions that constitute the L1 soft-enforcement layer per v2.1 §6.4 and §6.5:

**Addition 1 — Per-message intent re-classification discipline** (new subsection under the orchestration section):

> **Re-classify every user message.** Intent is classified per message, not per session. Every user message re-classifies; chat / question sessions that pivot to a build request route the pivot message through `canon-planner` regardless of prior conversation flow. Chat / question history does not make subsequent builds "chat."
>
> If the current message is a build request, route to `canon-planner` regardless of prior conversation flow.

**Addition 2 — Pre-write Canon-routing check** (new subsection immediately after L1):

> **Before using `Edit`, `Write`, or `Bash` for code changes**, verify Canon routing: ask yourself *"Is this request currently routed through a Canon build flow (planner + approved runbook)?"* If no, stop. Present the build request to the user and route through `canon-planner`. Editing code outside a Canon flow is the failure mode this rule prevents.
>
> This is the soft enforcement layer (L1). The hard backstop is the `canon-workspace-check.sh` PreToolUse hook (L4, v2_1a-05) that blocks `Edit` / `Write` / `Bash`-on-tracked-files when no active Canon workspace exists for the current flow.

**Gate by `CANON_AGENT_TEAMS_MODE=on`** — both amendments are active only under the flag. Legacy `drive_flow` path remains untouched when the flag is off.

Place both amendments in the **Canon-Agent-Teams Orchestration** section alongside other flag-gated guidance. Do not modify sections outside that flag boundary.

### Canon principles to apply

- **agent-surface-assumptions** — the re-classification rule surfaces the hidden assumption that session history preserves intent. Making it explicit prevents the failure mode.

### Risk mitigations

- Intent misclassification drift (§13 MEDIUM/MEDIUM): L1 is the soft layer; L4 (v2_1a-05) backs it up hard. Defense in depth.
- Claude doesn't consistently follow orchestration guidance (§13 HIGH/MEDIUM): L4 catches L1 failures at the hook layer

### Tests to write

No automated tests for CLAUDE.md text itself (it is prompt content, not code). Instead:

- **Smoke test** (manual, recorded in v2_1a-08 validation):
  1. Start a chat session (no build intent)
  2. Pivot to a build request mid-session
  3. Confirm lead routes the pivot message to `canon-planner` rather than continuing chat
- **Smoke test** (pre-write gate):
  1. Start a session with no active Canon workspace
  2. Ask the lead to fix a typo in a tracked file
  3. Confirm lead presents the build request and spawns `canon-planner` before attempting Edit/Write

### Verify

1. `CLAUDE.md` diff shows exactly the two new subsections added under the flag-gated Orchestration section
2. Both amendments cite `canon-planner` (not `canon-implementor` or other v2-era agents)
3. No amendments leak outside the `CANON_AGENT_TEAMS_MODE=on` boundary
4. `npm run build` and `npm test` still pass (no code changes)

### Done when

- Both subsections present in CLAUDE.md under the flag-gated Orchestration section
- Smoke tests documented in v2_1a-08 validation plan
- Review HIGH-1 is marked as depending on v2_1a-05 (L4 hook) and v2_1a-06 (intent routing expansion) — L1 alone is insufficient; this task ships only the soft layer
