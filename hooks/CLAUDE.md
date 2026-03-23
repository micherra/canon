# Canon Hooks — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Pre/post tool-use interceptors that enforce policy and prevent mistakes without requiring agent compliance. Hooks run automatically on matched tool invocations.

## Architecture
<!-- last-updated: 2026-03-22 -->

`hooks.json` is the registry defining when each hook script runs. Hooks are shell scripts triggered by `PreToolUse` (before Bash/Write/Edit) or `PostToolUse` (after Agent/Bash).

**Hook scripts:**

| Script | Trigger | Purpose |
|--------|---------|---------|
| `pre-commit-check.sh` | PreToolUse | Detect secrets, validate principle compliance |
| `destructive-guard.sh` | PreToolUse | Prevent force push, hard reset, and other dangerous git ops |
| `workspace-lock-guard.sh` | PreToolUse | Prevent concurrent builds on same branch |
| `pre-push-review.sh` | PreToolUse | Require review before pushing |
| `large-file-guard.sh` | PreToolUse | Prevent accidental large file commits |
| `principle-inject.sh` | PreToolUse | Inject principle summaries into prompts |
| `learn-nudge.sh` | PostToolUse | Suggest principle creation/updates |
| `compaction-check.sh` | PostToolUse | Detect workspace file growth |
| `agent-cost-tracker.sh` | PostToolUse | Track API costs per agent |

## Conventions
<!-- last-updated: 2026-03-22 -->

- Hooks are guardrails — they enforce safety without requiring agents to opt in
- Each hook script must be executable and exit 0 (pass) or non-zero (block)
- Hook configuration lives in `hooks.json` with matcher patterns for tool names
