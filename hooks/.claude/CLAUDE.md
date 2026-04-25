# Canon Hooks — Project Guidelines

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
<!-- last-updated: 2026-04-09 -->
Pre/post tool-use interceptors that enforce policy and prevent mistakes without requiring agent compliance. Hooks run automatically on matched tool invocations.

## Architecture
<!-- last-updated: 2026-04-09 -->

`hooks.json` is the registry defining when each hook script runs. Hooks are shell scripts triggered by `PreToolUse` (before Bash/Write/Edit/EnterPlanMode) or `PostToolUse` (after Bash).

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
| `learn-nudge.sh` | PostToolUse (Bash) | Suggest principle creation/updates |
| `compaction-check.sh` | PostToolUse (Bash) | Detect workspace file growth |

## Conventions
<!-- last-updated: 2026-04-09 -->

- Hooks are guardrails — they enforce safety without requiring agents to opt in
- Each hook script must be executable and exit 0 (pass) or non-zero (block)
- Hook configuration lives in `hooks.json` with matcher patterns for tool names
- `principle-inject-worker.mjs` is a Node.js helper invoked by `principle-inject.sh`
- `destructive-guard.test.sh` and `install-git-hooks.sh` are utilities, not registered hooks
