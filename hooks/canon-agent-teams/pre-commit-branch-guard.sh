#!/usr/bin/env bash
# pre-commit-branch-guard.sh — PreToolUse (Bash) hook that blocks git commits
# directly to main or master during a Canon build.
#
# This prevents engineers from accidentally committing to the trunk branch
# flag gate.
#
# Input: JSON on stdin (Claude Code PreToolUse hook format).
# Exit 0: allow — not a commit, or not on main/master.
# Exit 2: block — committing directly to main or master.

set -euo pipefail

# Source shared hook helpers.
_HOOK_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../lib/canon-hook-lib.sh"
# shellcheck source=hooks/lib/canon-hook-lib.sh
source "$_HOOK_LIB"

# Read the tool input from stdin
INPUT=$(cat)

# Extract the command being run from the tool input
COMMAND=$(canon_extract_command "$INPUT")

# If we couldn't extract a command, pass through
if [[ -z "$COMMAND" ]]; then
  exit 0
fi

if ! canon_is_git_cmd "$COMMAND" "commit"; then
  exit 0
fi

# Extract cd target from the command so we resolve the branch in the right worktree.
# Commands often look like: cd /path/to/worktree && git commit ...
GIT_DIR_ARG=$(canon_git_dir_arg "$COMMAND")

# Detect the current branch (in the target directory if cd was used)
# shellcheck disable=SC2086
CURRENT_BRANCH=$(git $GIT_DIR_ARG symbolic-ref --short HEAD 2>/dev/null || true)

# If we cannot detect the branch, pass through
if [[ -z "$CURRENT_BRANCH" ]]; then
  exit 0
fi

# Block commits directly to main or master
if [[ "$CURRENT_BRANCH" == "main" || "$CURRENT_BRANCH" == "master" ]]; then
  cat >&2 <<'EOF'
BLOCKED: Cannot commit directly to main/master during a Canon build.
Switch to the worktree branch first.

Canon builds use isolated worktree branches (e.g. canon/{slug}). Committing
to main bypasses Canon's controlled merge lifecycle and provenance tracking.

To fix:
  1. Find your worktree branch: git worktree list
  2. Switch to it: cd <worktree_path>
  3. Re-run your commit there
EOF
  exit 2
fi

# Branch is not main/master — allow the commit
exit 0
