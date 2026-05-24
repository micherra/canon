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

# Read the tool input from stdin
INPUT=$(cat)

# Extract the command being run from the tool input
COMMAND=$(echo "$INPUT" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"command"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)

# If we couldn't extract a command, pass through
if [[ -z "$COMMAND" ]]; then
  exit 0
fi

# Check if this is a git commit command
if ! echo "$COMMAND" | grep -qE '\bgit\b.*\bcommit\b'; then
  exit 0
fi

# Detect the current branch
CURRENT_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || true)

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
