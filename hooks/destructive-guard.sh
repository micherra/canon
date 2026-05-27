#!/bin/bash
# Canon Destructive Git Command Guard
# Runs as a PreToolUse hook on Bash commands.
# Blocks destructive git operations (reset --hard, clean -f, checkout -- .,
# branch -D) so the user is prompted for permission before they execute.
#
# Input: JSON on stdin with the tool call details
# Output: Warning message on stderr (when blocking)
# Exit 0: allow the tool call
# Exit 2: block the tool call (user will be prompted)

set -euo pipefail

# Read the tool input from stdin
INPUT=$(cat)

# Extract the command being run from the tool input
COMMAND=$(echo "$INPUT" | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"command"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)

# If we couldn't extract a command, pass through
if [[ -z "$COMMAND" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Canon-managed resource helpers
#
# Returns true (0) when a command targets a Canon-managed worktree path.
# Two cases:
#   1. The command uses git -C pointing to a .canon/worktrees/ or
#      .claude/worktrees/ path (agent spawning into a worktree).
#   2. The current working directory is itself inside a worktree
#      (orchestrator or user running inside a worktree session).
# ---------------------------------------------------------------------------
is_canon_worktree_command() {
  local cmd="$1"
  # Reject chained commands — the worktree exception applies only to a
  # single git invocation. A chain like:
  #   git -C .canon/worktrees/slug status && git clean -f
  # must not exempt the trailing destructive operation.
  if echo "$cmd" | grep -qE '(&&|\|\||;)'; then
    return 1
  fi
  # Case 1: explicit -C flag pointing to a worktree path
  if echo "$cmd" | grep -qE '\bgit\b[[:space:]]+-C[[:space:]]+[^[:space:]]*\.(canon|claude)/worktrees/'; then
    return 0
  fi
  # Case 2: current working directory is inside a worktree
  local cwd="${CANON_GUARD_CWD:-$PWD}"
  if echo "$cwd" | grep -qE '\.(canon|claude)/worktrees/'; then
    return 0
  fi
  return 1
}

# Check for destructive git operations
if echo "$COMMAND" | grep -qE '\bgit\b.*\breset\b.*--hard'; then
  # Exception: Canon agents use -C .canon/worktrees/<slug> to scope resets
  # to their isolated worktree. These are Canon-managed paths, not the
  # user's working tree.
  if is_canon_worktree_command "$COMMAND"; then
    exit 0
  fi
  cat <<EOF >&2
CANON: Destructive git operation detected — git reset --hard. This discards all uncommitted changes and cannot be undone. Ensure you have committed or stashed any work you want to keep.
EOF
  exit 2
fi

if echo "$COMMAND" | grep -qE '\bgit\b.*\bclean\b.*-[a-zA-Z]*f'; then
  # Exception: Canon agents use -C .canon/worktrees/<slug> to scope clean
  # operations to their isolated worktree.
  if is_canon_worktree_command "$COMMAND"; then
    exit 0
  fi
  cat <<EOF >&2
CANON: Destructive git operation detected — git clean -f. This permanently deletes untracked files. Ensure no important untracked files will be lost.
EOF
  exit 2
fi

if echo "$COMMAND" | grep -qE '\bgit\b.*\bcheckout\b.*--\s*\.'; then
  # Exception: Canon agents use -C .canon/worktrees/<slug> to scope
  # checkout operations to their isolated worktree.
  if is_canon_worktree_command "$COMMAND"; then
    exit 0
  fi
  cat <<EOF >&2
CANON: Destructive git operation detected — git checkout -- . This discards all unstaged changes in the working tree and cannot be undone.
EOF
  exit 2
fi

if echo "$COMMAND" | grep -qE '\bgit\b.*\bbranch\b.*-D\b'; then
  # Exception: allow force-deletion of Canon-managed branches.
  # Extract all arguments that appear after -D (strip any flags starting with -).
  # If ALL branch names start with canon/ or canon-task/, the operation is safe.
  branch_args=$(echo "$COMMAND" | sed 's/.*-D[[:space:]]*//' | tr ' \t' '\n' | grep -v '^-')
  if [[ -n "$branch_args" ]]; then
    all_canon=true
    while IFS= read -r branch; do
      if ! echo "$branch" | grep -qE '^canon(-wave|-task)?/'; then
        all_canon=false
        break
      fi
    done <<< "$branch_args"
    if [[ "$all_canon" == "true" ]]; then
      exit 0
    fi
  fi
  cat <<EOF >&2
CANON: Destructive git operation detected — git branch -D. This force-deletes a branch even if it has unmerged changes.
EOF
  exit 2
fi

# Not a destructive command — allow
exit 0
