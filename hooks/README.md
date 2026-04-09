# Canon Hooks

This directory contains the hook system — shell scripts that run automatically before and after specific Claude Code tool invocations. Hooks enforce policy without requiring agents to remember to comply. They are Canon's guardrail layer.

## What Hooks Do

When an agent calls a tool like `Bash`, `Write`, or `Edit`, Claude Code checks the hooks registry before executing the tool. If a hook script returns a non-zero exit code, the tool call is blocked. If it returns zero, execution proceeds. Post-tool hooks run after the tool completes and can trigger follow-up actions like nudging the agent toward a learning opportunity or checking workspace health.

This means hooks can enforce safety properties that would otherwise depend on agent compliance — things like preventing force-pushes, detecting secrets before a commit, or blocking concurrent builds on the same branch. The agent doesn't need to know these rules exist; the hook system enforces them transparently.

## The Hook Registry

`hooks.json` is the registry that maps tool triggers to hook scripts. It uses Claude Code's hook event model: `PreToolUse` fires before the tool runs (and can block it), `PostToolUse` fires after it completes (informational only). Each entry specifies a matcher pattern for the tool name and a list of shell commands to run.

The registry currently covers three tool triggers:

- **Bash commands** get the most hooks: secrets detection, destructive git operation guard, workspace lock check, and a pre-push review gate
- **Write/Edit/NotebookEdit operations** trigger a large-file guard and a principle injection hook
- **EnterPlanMode** is guarded against unintended entry

Post-tool hooks on Bash provide two advisory signals: a nudge suggesting principle creation when interesting patterns emerge, and a compaction check watching for workspace file growth.

## Hook Scripts

Each hook is a standalone shell script in this directory. Scripts exit 0 to allow the operation or non-zero to block it. The scripts are designed to be fast — hooks run on every tool invocation, so a slow hook would noticeably degrade the agent's responsiveness.

One hook (`principle-inject.sh`) delegates to a Node.js helper (`principle-inject-worker.mjs`) for heavier processing. The `install-git-hooks.sh` script and `destructive-guard.test.sh` are utilities for setup and local testing, not registered hooks.

## Adding a New Hook

1. Write a shell script that exits 0 (allow) or non-zero (block). Print a message to stderr when blocking — the agent sees this output.
2. Make the script executable: `chmod +x hooks/your-hook.sh`
3. Register it in `hooks.json` under the appropriate trigger (`PreToolUse` or `PostToolUse`) with a matcher for the tool it should intercept.

Keep hooks focused on a single concern. A hook that tries to check multiple unrelated things becomes hard to debug and maintain. If a hook blocks frequently on legitimate operations, it will train agents (and humans) to work around it — which defeats the purpose.

## Philosophy

Hooks exist because policy enforced by convention is unreliable under deadline pressure. An agent that is told "don't force-push" may comply most of the time, but will slip under task pressure. A hook that blocks force-push has no off days. The hook system is Canon's answer to the gap between "the rule says X" and "X actually happens every time".
