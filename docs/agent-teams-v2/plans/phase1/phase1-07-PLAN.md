---
task_id: "phase1-07"
wave: 1
depends_on: []
files:
  - hooks/canon-agent-teams/post-commit-trailers.sh
  - hooks/canon-agent-teams/completion-verify.sh
  - hooks/canon-agent-teams/session-start-doc-check.sh
  - hooks/canon-agent-teams/session-start-kg-check.sh
  - hooks/canon-agent-teams/post-engineer-scribe.sh
  - hooks/canon-agent-teams/hooks.json
principles:
  - agent-tdd-required
domains:
  - hooks
---

## Task: Write agent-teams hook scripts and hooks.json

> **Scope note (2026-04-21).** This PLAN originally specified 2 hook
> scripts. DESIGN.md dc-05, INDEX.md, and docs/agent-teams-migration-
> plan-v2.md §10.1 (lines 1027–1031) all specify **5 hook scripts** as
> Phase 1 Wave 1 scope, and Gate A measures against that 5-hook set.
> This PLAN has been amended to the 5-hook scope to keep the plan tree
> internally consistent; the original 2-hook draft was stale relative
> to the higher-order DESIGN/INDEX/v2.md documents it should have
> tracked. See PR #119 architect review Finding 1.

### Action

Create five hook scripts and a hooks.json configuration for the
agent-teams mode. These provide defense-in-depth enforcement (§2.8
layer 5 of the migration plan).

The 5-hook set:

| Script | Trigger | Purpose |
|--------|---------|---------|
| `post-commit-trailers.sh` | PostToolUse (Bash) | Warn when a git commit lands without a Canon-Workflow trailer. PostToolUse cannot block retroactively. |
| `completion-verify.sh` | Called explicitly by the lead (NOT auto-registered) | Reads the orchestration journal; exits non-zero when steps are incomplete or artifacts missing. |
| `session-start-doc-check.sh` | SessionStart | Advisory nudge when HEAD diverges from `.canon/last-scribe-commit`. |
| `session-start-kg-check.sh` | SessionStart | Advisory nudge when `.canon/knowledge-graph.db` is missing or stale (>24h default). |
| `post-engineer-scribe.sh` | SubagentStop | After `engineer` completes, writes `pending-scribe.json` to workspace so the lead runs the scribe before flow completion. |

#### 1. Create directory structure

```bash
mkdir -p hooks/canon-agent-teams/
```

#### 2. Write `post-commit-trailers.sh`

This is a PostCommit hook that validates the `Canon-Workflow` trailer is present in commits made during agent-teams mode.

```bash
#!/usr/bin/env bash
# post-commit-trailers.sh — PostCommit hook validating Canon-Workflow trailer
# Only active when CANON_AGENT_TEAMS_MODE=on
# Exit 0: trailer present or mode not active
# Exit 2: trailer missing (blocks the commit)

set -euo pipefail

# Only enforce when agent-teams mode is active
if [[ "${CANON_AGENT_TEAMS_MODE:-off}" != "on" ]]; then
  exit 0
fi

# Read the tool input from stdin (Claude Code PostToolUse hook format)
# The hook receives the Bash tool output including the git commit command
INPUT=$(cat)

# Check if this was a git commit command
if ! echo "$INPUT" | grep -q '"tool_name".*"Bash"'; then
  exit 0
fi

COMMAND=$(echo "$INPUT" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/"command"[[:space:]]*:[[:space:]]*"//;s/"$//')

if ! echo "$COMMAND" | grep -qE 'git\s+commit'; then
  exit 0
fi

# Get the last commit message
LAST_MSG=$(git log -1 --format='%B' 2>/dev/null || echo "")

# Check for Canon-Workflow trailer
if echo "$LAST_MSG" | grep -q '^Canon-Workflow:'; then
  exit 0
fi

# Trailer missing — report but don't block (warn via stderr)
# Using exit 0 for now as PostToolUse hooks that exit non-zero
# may interfere with the commit that already happened.
# The completion-verify hook provides the hard enforcement.
echo "WARNING: Commit missing Canon-Workflow trailer. Expected format:" >&2
echo "  Canon-Workflow: {workflow-slug}" >&2
echo "  Canon-Agent: {agent-type}" >&2
echo "  Canon-State: {state-id}" >&2
exit 0
```

Note: PostCommit hooks in Claude Code run AFTER the commit, so they cannot block retroactively. This hook warns. The real enforcement is that agents are instructed to include trailers, and `completion-verify.sh` catches systemic omissions at flow end.

#### 3. Write `completion-verify.sh`

This script is called explicitly by the lead before declaring a flow done.
It reads the orchestration journal and blocks with exit 2 when any step
is not in a terminal state (planned + started are both missing) or when
any expected artifact cannot be found on disk. Glob patterns in artifact
paths are expanded; `${var}` template fragments are surfaced but do not
block completion.

Semantics must mirror `verify_completion` in
`mcp-server/src/features/orchestration/tools/orchestration-journal.ts`
so the hook and the MCP tool agree on every question they both answer.

See the shipped `hooks/canon-agent-teams/completion-verify.sh` for the
reference implementation.

#### 4. Write `session-start-doc-check.sh`

SessionStart advisory hook. Reads `.canon/last-scribe-commit`; emits an
informational nudge on stdout when HEAD has advanced past the recorded
SHA. Never blocks — exit 0 regardless. A missing file or empty SHA
simply emits the "no checkpoint yet" nudge once.

#### 5. Write `session-start-kg-check.sh`

SessionStart advisory hook. Checks `.canon/knowledge-graph.db` exists and
that its mtime is within `CANON_KG_STALE_SECONDS` (default 86400s).
Emits a nudge when missing or stale so the lead knows `graph_query` /
`get_file_context` results may be degraded. Never blocks.

#### 6. Write `post-engineer-scribe.sh`

SubagentStop hook. When the stopping subagent is `engineer`,
writes `${WORKSPACE}/pending-scribe.json` so the lead's completion
checklist (phase1-09 CLAUDE.md) can check for it and run scribe
before declaring done. Workspace discovery: `CANON_WORKSPACE` env var,
then the hook payload's `workspace` field. Never blocks.

#### 7. Write `hooks/canon-agent-teams/hooks.json`

Register 4 of the 5 scripts: PostToolUse(Bash) → post-commit-trailers,
SessionStart → session-start-doc-check + session-start-kg-check,
SubagentStop → post-engineer-scribe. `completion-verify.sh` is NOT
registered: registering it PostToolUse would fire on every Bash call,
which is wrong. Instead, the lead's CLAUDE.md completion checklist
(phase1-09) instructs: "Before calling `update_board complete_flow`,
run `bash ${CLAUDE_PLUGIN_ROOT}/hooks/canon-agent-teams/completion-verify.sh`".

### Canon principles to apply
- **agent-tdd-required**: Write tests for both hook scripts that have
  non-trivial logic (`post-commit-trailers.sh` and `completion-verify.sh`).
  The three advisory hooks (session-start-doc-check, session-start-kg-check,
  post-engineer-scribe) are simple stderr nudges and need no test script
  beyond feature-flag gating verification.

### Risk mitigations
- **Feature flag isolation**: All five scripts check `CANON_AGENT_TEAMS_MODE`
  first and exit 0 if not active. No-op when flag is off.
- **PostCommit hook limitation**: PostCommit hooks cannot block already-
  committed work. The trailer hook warns only. The completion-verify
  hook is the hard enforcement gate at flow end.
- **Node availability**: `completion-verify.sh` requires `node` to parse
  JSON. Safe in Canon environments (Node.js 24+ is required by the MCP
  server).

### Tests to write

- `hooks/canon-agent-teams/post-commit-trailers.test.sh`: feature-flag
  off, non-Bash input, non-commit Bash, commit with trailer (no warning),
  commit without trailer (warns on stderr).
- `hooks/canon-agent-teams/completion-verify.test.sh`: feature-flag off,
  missing workspace, missing journal, complete flow, started-but-not-
  completed blocks, planned blocks, missing artifacts, skipped steps do
  not block, glob patterns match, glob with no match, `${var}` does
  not block.

### Verify
1. All five scripts are executable: `chmod +x hooks/canon-agent-teams/*.sh`
2. `hooks/canon-agent-teams/hooks.json` parses as valid JSON and
   registers 4 scripts (not completion-verify).
3. Test scripts pass:
   - `bash hooks/canon-agent-teams/post-commit-trailers.test.sh`
   - `bash hooks/canon-agent-teams/completion-verify.test.sh`
4. Feature flag gating: all five scripts exit 0 when
   `CANON_AGENT_TEAMS_MODE` is unset.
5. `npm run build` passes (no TypeScript changes).
6. `npm test` passes at baseline (no new regressions).
7. The existing `hooks/hooks.json` is NOT modified.

### Done when

- All 5 hook scripts exist under `hooks/canon-agent-teams/`, are
  executable, and gate on `CANON_AGENT_TEAMS_MODE=on`.
- `hooks/canon-agent-teams/hooks.json` registers 4 scripts; completion-
  verify is called explicitly by the lead.
- Both test scripts written and passing.
- Existing hooks untouched.
- Build and tests pass unchanged (relative to the baseline failure set
  captured in `.canon/workspaces/agent-teams-v2/baseline-failures.md`).

