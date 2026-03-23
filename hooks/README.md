# Canon Hooks

Canon includes 9 automation hooks that enforce policy without requiring agent compliance. These are shell scripts triggered automatically by Claude Code's tool-use events — they run in the background, intercepting tool calls before or after execution to catch mistakes, inject context, and maintain observability.

## How Hooks Work

`hooks.json` is the registry that maps hook scripts to tool events. Claude Code fires two event types:

- **PreToolUse** — runs BEFORE a tool executes. A hook can block the tool call by exiting non-zero (exit code 2 = block with message). This is how destructive command guards and secrets detection work.
- **PostToolUse** — runs AFTER a tool executes. These are observational: they can warn and log, but cannot block the action that already happened.

Each entry in `hooks.json` specifies a `matcher` (the tool name or pipe-separated list of tool names to match), plus a list of hook commands with timeouts. Hooks receive the tool call details as JSON on stdin.

**Matchers used:**
- `"Bash"` — matches all Bash tool invocations
- `"Write|Edit|NotebookEdit"` — matches file write and edit operations
- `"Agent"` — matches agent spawn calls

## Hook Reference

### pre-commit-check.sh

**Type:** PreToolUse / Bash
**Timeout:** 30s
**Behavior:** Blocking (exits 2 on violation)

Intercepts `git commit` commands and scans staged files for hardcoded secrets before the commit executes. Detects five categories of secrets in a single-pass regex scan:

| Pattern | What it catches |
|---------|----------------|
| `AKIA[0-9A-Z]{16}` | AWS access key IDs |
| `-----BEGIN ... PRIVATE KEY` | RSA, EC, DSA, and OpenSSH private keys |
| `(password\|api_key\|secret\|...)[=:] "..."` | Hardcoded credentials in variable assignments (16+ char values) |
| `sk_live_...` | Stripe live secret keys |
| `(postgres\|mysql\|mongodb\|redis)://user:pass@...` | Connection strings with embedded passwords |

Skips binary files, `.env.example` files, and test/spec files to reduce false positives. If secrets are detected, the commit is blocked with a specific report identifying the file and pattern matched.

Enforces the `secrets-never-in-code` Canon principle (rule severity).

---

### destructive-guard.sh

**Type:** PreToolUse / Bash
**Timeout:** 5s
**Behavior:** Blocking (exits 2 on match)

Blocks four categories of destructive git operations and surfaces a clear warning so the user must explicitly confirm before proceeding:

| Command | Risk |
|---------|------|
| `git reset --hard` | Discards all uncommitted changes, cannot be undone |
| `git clean -f` | Permanently deletes untracked files |
| `git checkout -- .` | Discards all unstaged working tree changes |
| `git branch -D` | Force-deletes a branch even with unmerged changes |

When a match is detected, the hook exits 2 with an explanatory message. Claude Code surfaces the block to the user, who must explicitly instruct the agent to proceed — at which point the agent can reissue the command with user consent in context.

---

### workspace-lock-guard.sh

**Type:** PreToolUse / Bash
**Timeout:** 5s
**Behavior:** Advisory (always exits 0, warns only)

Before `git commit` or `git merge` commands, checks whether the current branch's Canon workspace has an active `.lock` file written by a different session. This prevents two parallel builds from stepping on each other when working on the same branch.

The lock file lives at `.canon/workspaces/{sanitized-branch}/.lock` and contains a `session_id` and `started` timestamp. The guard:

- Skips if the lock belongs to the current session (same `session_id`)
- Skips if the lock is stale (older than 2 hours)
- Emits a warning message if a fresh lock from a different session is present

Never blocks — it is a warning to make the agent (and user) aware of potential conflicts.

---

### pre-push-review.sh

**Type:** PreToolUse / Bash
**Timeout:** 10s
**Behavior:** Advisory (always exits 0, warns only)

Warns before `git push` when unpushed commits have not been covered by a Canon review. Checks `.canon/reviews.jsonl` for the most recent review timestamp and compares it against the oldest unpushed commit's author timestamp (supports both GNU and BSD date formats for cross-platform compatibility).

Three warning cases:
1. No `reviews.jsonl` exists at all — suggests running `/canon:review`
2. Reviews exist but none covers the unpushed commits — warns with commit count
3. Last review predates the oldest unpushed commit — warns that review may be stale

Does not block; it is a nudge to run `/canon:review` before pushing to a shared remote.

---

### large-file-guard.sh

**Type:** PreToolUse / Write|Edit|NotebookEdit
**Timeout:** 10s
**Behavior:** Advisory (always exits 0, warns only)

Warns when a Write or Edit operation would produce or modify a file exceeding the configured line threshold. The threshold defaults to 500 lines and is configurable via `.canon/config.json`:

```json
{
  "max_file_lines": 500
}
```

Behavior differs between tool types:
- **Write:** estimates the new file size by counting newlines in the content field (using `jq` if available, falling back to pattern matching)
- **Edit:** checks the current size of the existing file before the edit applies

Skips file types where large size is expected: `.lock`, `.svg`, `.json`, `.csv`, `.sql`, minified files, bundles, vendor directories, and generated files.

The warning message includes the actual line count, the threshold, and a suggestion to split the file into smaller focused modules.

---

### principle-inject.sh

**Type:** PreToolUse / Write|Edit|NotebookEdit
**Timeout:** 5s
**Behavior:** Advisory (always exits 0, injects context)

Automatically injects relevant Canon principle summaries into the agent's context before Write or Edit operations on source files. This means agents receive applicable principles without needing to explicitly call `get_principles` — the hook surfaces them automatically based on the file path being edited.

The hook delegates to `principle-inject-worker.mjs` (a Node.js script in the same directory) which resolves principles via the Canon principle index. Uses session-scoped deduplication so each file only gets injected once per session — a hash of the file path is stored in a temp directory keyed to the session ID, preventing redundant injections on repeated edits to the same file.

Skips non-source files: `.lock`, `.svg`, `.json`, `.csv`, `.sql`, minified files, bundles, node_modules, generated files, and `.md` files.

---

### learn-nudge.sh

**Type:** PostToolUse / Bash
**Timeout:** 5s
**Behavior:** Advisory (always exits 0)

After `git commit` commands, checks whether enough reviews have accumulated to warrant a learning run. If 10 or more reviews have been logged in `.canon/reviews.jsonl` since the last `/canon:learn` run, it emits a nudge message suggesting the user run `/canon:learn` to discover patterns and refine principles.

Noise reduction:
- Only triggers on `git commit` (not on every Bash call)
- Only nudges once per session (dedup file keyed to a hash of the project directory)
- Compares against `learning.jsonl`'s `reviews_analyzed` field to count reviews since the last run

The dedup file is stored at `.canon/.learn-nudged-{project-hash}`.

---

### compaction-check.sh

**Type:** PostToolUse / Bash
**Timeout:** 5s
**Behavior:** Advisory (always exits 0)

After `git commit` commands, checks whether Canon's JSONL data files or `CONVENTIONS.md` have grown past maintenance thresholds:

| File | Threshold | Warning |
|------|-----------|---------|
| `reviews.jsonl` | 500 entries | Rotation may not be running |
| `decisions.jsonl` | 500 entries | Rotation may not be running |
| `patterns.jsonl` | 500 entries | Rotation may not be running |
| `CONVENTIONS.md` | 20 conventions | Consider consolidating similar entries |

Only nudges once per session (dedup file keyed to the session ID in the hook input JSON). Suggests running `/canon:doctor` for a full health check when thresholds are exceeded.

---

### agent-cost-tracker.sh

**Type:** PostToolUse / Agent
**Timeout:** 5s
**Behavior:** Silent (always exits 0, no output)

Logs every agent spawn to `.canon/agent-costs.jsonl` for cost observability. Captures:

- `timestamp` — ISO-8601 UTC timestamp of the spawn
- `session_id` — the current session identifier
- `agent_type` — the `subagent_type` field from the Agent tool call (e.g. `canon:canon-implementor`)
- `description` — the agent's task description

This log is the data source for cost analysis and bottleneck reports. The Canon Inspector agent reads it when generating cost/bottleneck reports. The hook is entirely silent — it never emits warnings or output to the user.

---

## hooks.json Format

The registry at `hooks/hooks.json` defines when each hook runs:

```json
{
  "description": "...",
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/pre-commit-check.sh",
            "timeout": 30
          }
        ]
      },
      {
        "matcher": "Write|Edit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/large-file-guard.sh",
            "timeout": 10
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Agent",
        "hooks": [
          {
            "type": "command",
            "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/agent-cost-tracker.sh",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

**Fields:**
- `type` — always `"command"` for shell hooks
- `command` — shell command to execute; `${CLAUDE_PLUGIN_ROOT}` resolves to the Canon plugin root directory
- `timeout` — maximum seconds the hook may run before being killed; hooks that exceed their timeout are treated as passing (non-blocking)

Multiple hooks under the same matcher run sequentially in array order.

## Writing Custom Hooks

1. Create a `.sh` script in `hooks/`:

```bash
#!/bin/bash
# My custom hook
# Input: JSON on stdin
# Exit 0: allow | Exit 2: block

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 | sed 's/.*"command"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)

# Your logic here
if echo "$COMMAND" | grep -q "something-to-block"; then
  echo "CANON: Blocked because ..."
  exit 2
fi

exit 0
```

2. Add an entry to `hooks/hooks.json` under the appropriate event type and matcher:

```json
{
  "type": "command",
  "command": "bash ${CLAUDE_PLUGIN_ROOT}/hooks/my-custom-hook.sh",
  "timeout": 10
}
```

**Guidelines:**
- Exit 0 to allow, exit 2 to block (PreToolUse only; PostToolUse hooks should always exit 0)
- Write diagnostic output to stdout, not stderr — Claude Code captures stdout as the block reason
- Keep timeouts tight; hooks run on every matched tool call and slow hooks degrade the experience
- Use session deduplication (temp files keyed to session ID) for advisory hooks that should only fire once per session
- Handle missing tools and empty input gracefully with `|| true` guards — hooks must not crash on edge cases
