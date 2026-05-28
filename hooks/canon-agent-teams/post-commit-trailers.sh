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

# Source shared hook helpers.
_HOOK_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/canon-hook-lib.sh"
# shellcheck source=hooks/lib/canon-hook-lib.sh
source "$_HOOK_LIB"

INPUT=$(cat)

# Only care about Bash calls — non-Bash tools don't produce commits.
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null || true)
if [[ "$TOOL_NAME" != "Bash" ]]; then
  exit 0
fi

COMMAND=$(canon_extract_command "$INPUT")

if ! canon_is_git_cmd "$COMMAND" "commit"; then
  exit 0
fi

# Resolve the worktree directory so git log runs in the right repo context.
GIT_DIR_ARG=$(canon_git_dir_arg "$COMMAND")

# shellcheck disable=SC2086
LAST_MSG=$(git $GIT_DIR_ARG log -1 --format='%B' 2>/dev/null || echo "")

if [[ "$LAST_MSG" == Canon-Workflow:* ]]; then
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
