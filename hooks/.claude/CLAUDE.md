# Canon Hooks — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
<!-- last-updated: 2026-04-09 -->
Pre/post tool-use interceptors that enforce policy and prevent mistakes without requiring agent compliance. Hooks run automatically on matched tool invocations.

## Architecture
<!-- last-updated: 2026-05-25 -->

`hooks.json` is the single registry defining when each hook script runs. Hooks are shell scripts triggered by `PreToolUse` (before Bash/Write/Edit/EnterPlanMode/Agent), `PostToolUse` (after Bash), `SessionStart`, or `SubagentStop`. The separate `canon-agent-teams/hooks.json` was merged into this file (2026-04-26); `canon-agent-teams/hooks.json` no longer exists.

**Hook scripts:**

| Script | Trigger | Purpose |
|--------|---------|---------|
| `pre-commit-check.sh` | PreToolUse (Bash) | Detect secrets, validate principle compliance |
| `destructive-guard.sh` | PreToolUse (Bash) | Prevent force push, hard reset, and other dangerous git ops |
| `workspace-lock-guard.sh` | PreToolUse (Bash) | Prevent concurrent builds on same branch |
| `pre-push-review.sh` | PreToolUse (Bash) | Require review before pushing |
| `large-file-guard.sh` | PreToolUse (Write/Edit) | Prevent accidental large file commits |
| `principle-inject.sh` | PreToolUse (Write/Edit) | Inject principle summaries into prompts |
| `plan-mode-guard.sh` | PreToolUse (EnterPlanMode) | Guard against unintended plan mode entry |
| `dag-dispatch-guard.sh` | PreToolUse (Agent) | Advisory warning when raw Agent spawns detected during DAG implement state — never blocks (exit 0) |
| `canon-agent-teams/canon-workspace-check.sh` | PreToolUse (Edit/Write/Bash) | Block file edits when no active Canon workspace exists (L4 enforcement) |
| `canon-agent-teams/pre-commit-branch-guard.sh` | PreToolUse (Bash) | Block commits directly to main/master during a Canon build |
| `learn-nudge.sh` | PostToolUse (Bash) | Suggest principle creation/updates |
| `compaction-check.sh` | PostToolUse (Bash) | Detect workspace file growth |
| `canon-agent-teams/post-commit-trailers.sh` | PostToolUse (Bash) | Validate Canon commit trailers after each commit |
| `canon-agent-teams/session-start-doc-check.sh` | SessionStart | Nudge on stale documentation at session open |
| `canon-agent-teams/session-start-kg-check.sh` | SessionStart | Nudge on stale knowledge graph at session open |
| `canon-agent-teams/session-start-timestamp.sh` | SessionStart | Write session start timestamp for duration watchdog |
| `canon-agent-teams/session-start-context.sh` | SessionStart | Output project pulse (recent builds, drift, convention count) as invisible orchestrator context |
| `canon-agent-teams/session-duration-watchdog.sh` | PreToolUse (*) | Advisory session duration warning after configurable threshold |
| `canon-agent-teams/spawn-timeout-watchdog.sh` | PreToolUse (*) | HITL checkpoint when a spawned agent exceeds configurable run time (default 20 min) |
| `canon-agent-teams/tool-loop-detector.sh` | PostToolUse (*) | Detect 3 consecutive identical tool calls (loop) and exit 2 to surface HITL |
| `canon-agent-teams/post-engineer-scribe.sh` | SubagentStop | Queue scribe sync after engineer subagent completes |

## Conventions
<!-- last-updated: 2026-05-25 -->

- Hooks are guardrails — they enforce safety without requiring agents to opt in
- Each hook script must be executable and exit 0 (pass) or non-zero (block)
- Hook configuration lives in `hooks.json` with matcher patterns for tool names
- `principle-inject-worker.mjs` is a Node.js helper invoked by `principle-inject.sh`
- `destructive-guard.test.sh` and `install-git-hooks.sh` are utilities, not registered hooks
- When testing secret-detection hooks, use all-zeros suffixes or EXAMPLE-pattern placeholders for key fixtures — not plausible real-looking values. GitHub push protection scans test files regardless of hook exclusion rules.
