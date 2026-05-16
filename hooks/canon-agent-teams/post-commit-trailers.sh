#!/usr/bin/env bash
# post-commit-trailers.sh — PostToolUse (Bash) hook that validates Canon-Workflow
# trailer presence on git commits made during agent-teams mode.
#
# PostToolUse hooks fire AFTER the commit has already landed, so this hook
# cannot block retroactively — it warns on stderr. Hard enforcement is provided
# by completion-verify.sh at flow end plus agent-definition guidance to include
# trailers in every commit.
#
# Input: JSON on stdin (Claude Code PostToolUse hook format, includes tool_name
#        and the command string).
# Exit 0: trailer present, or non-commit Bash call.
# Exit 0: trailer missing (warn on stderr only — cannot undo the commit).

set -euo pipefail

INPUT=$(cat)

# Only care about Bash calls — non-Bash tools don't produce commits.
if ! echo "$INPUT" | grep -q '"tool_name"[[:space:]]*:[[:space:]]*"Bash"'; then
  exit 0
fi

COMMAND=$(echo "$INPUT" \
  | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 \
  | sed 's/"command"[[:space:]]*:[[:space:]]*"//;s/"$//')

if ! echo "$COMMAND" | grep -qE 'git[[:space:]]+commit'; then
  exit 0
fi

LAST_MSG=$(git log -1 --format='%B' 2>/dev/null || echo "")

if echo "$LAST_MSG" | grep -q '^Canon-Workflow:'; then
  exit 0
fi

cat >&2 <<'EOF'
CANON WARNING: Commit missing `Canon-Workflow` trailer.

Expected trailer block at the end of the commit body:
  Canon-Workflow: {workflow-slug}
  Canon-Agent:    {agent-type}
  Canon-State:    {state-id}
  Canon-Task:     {task-id}    # wave tasks only

This commit is recorded without Canon provenance. The completion-verify
hook will flag systemic omissions at flow end.
EOF

exit 0
