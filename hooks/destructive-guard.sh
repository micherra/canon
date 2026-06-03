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

# shellcheck source=lib/canon-hook-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/canon-hook-lib.sh"

# Read the tool input from stdin
INPUT=$(cat)

# Extract the command being run from the tool input
COMMAND=$(canon_extract_command "$INPUT")

# If we couldn't extract a command, distinguish two cases:
#   1. No "command" field in payload, or command value is empty ("") → pass (exit 0)
#   2. Payload has a "command" key with a non-empty value but extraction yielded
#      empty (jq unavailable and grep/sed also failed) → fail CLOSED (exit 2)
if [[ -z "$COMMAND" ]]; then
  if [[ -n "$INPUT" ]] && printf '%s' "$INPUT" | grep -qE '"command"[[:space:]]*:[[:space:]]*"[^"]'; then
    echo "CANON: command extraction failed (jq/grep both yielded empty on a command payload) — blocking fail-closed." >&2
    exit 2
  fi
  exit 0
fi

# Neutralize shell quote characters before any boundary/flag matching by
# DELETING them — exactly reproducing bash quote-removal. A quote sitting
# between a whitespace boundary and a trigger flag (e.g. git reset "--hard",
# git clean '-f') otherwise defeats the (^|[[:space:]])--flag boundary anchors
# below, letting a genuine destructive op slip past. Deletion (not substitute-
# to-space) is required because bash CONCATENATES intra-token quotes rather than
# inserting a space: -""f → -f, --ha""rd → --hard, cl""ean → clean. Substituting
# spaces would split such a token for the guard while the shell runs it joined,
# reopening the hole. The ORIGINAL whitespace between separate tokens is left
# intact, so inter-token quoted forms ("clean" "-f" → clean -f) and Canon branch
# operands ("canon/a" "canon/b" → canon/a canon/b) stay space-separated. The
# destructive detection is subcommand+flag based (never branch-name based), so
# deleting quotes cannot reintroduce branch-name false-positives.
COMMAND=$(printf '%s' "$COMMAND" | tr -d '"'"'"'')

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

# ---------------------------------------------------------------------------
# Per-subcommand argument extractor.
#
# Given a single git command segment and the resolved subcommand token, print
# only the tokens that appear AFTER the subcommand (its own arguments). This
# lets each policy check inspect the subcommand's own flags/targets instead of
# substring-matching the whole command string.
# ---------------------------------------------------------------------------
git_subcommand_args() {
  local segment="$1"
  local sub="$2"
  # Drop everything up to and including the FIRST standalone "<sub>" token,
  # bounded by whitespace, and emit only the tokens after it. Anchoring to the
  # first occurrence (not the last) is required: a greedy ".*<sub>" strip would
  # swallow the real subcommand AND its destructive flag when an operand merely
  # repeats the subcommand word (e.g. "git clean -f clean" → the flag would be
  # eaten, slipping a genuine destructive op past detection). awk walks tokens
  # left-to-right, finds the first token equal to <sub>, and prints the rest.
  printf '%s' "$segment" \
    | awk -v subcmd="$sub" '
        {
          found = 0
          out = ""
          for (i = 1; i <= NF; i++) {
            if (!found && $i == subcmd) { found = 1; continue }
            if (found) { out = (out == "" ? $i : out " " $i) }
          }
          print out
        }'
}

# ---------------------------------------------------------------------------
# Detection: segment the command on && || ; | and evaluate each segment
# independently (decision -02). For each segment, resolve the real git
# subcommand via canon_git_subcommand and inspect only that subcommand's own
# arguments. BLOCK if ANY segment is a genuinely destructive operation.
# A segment with a "git" token whose subcommand cannot be resolved is a
# parse ambiguity → BLOCK fail-closed.
# ---------------------------------------------------------------------------

# Replace segment separators with newlines so we can iterate segments.
SEGMENTS=$(printf '%s' "$COMMAND" | sed -E 's/(&&|\|\||;|\|)/\n/g')

while IFS= read -r segment; do
  # Trim leading/trailing whitespace.
  segment=$(printf '%s' "$segment" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
  [[ -z "$segment" ]] && continue

  # Does this segment contain a standalone "git" token?
  if ! printf '%s' "$segment" | grep -qE '(^|[[:space:]])git([[:space:]]|$)'; then
    continue
  fi

  sub=$(canon_git_subcommand "$segment" || true) # DOCUMENTED FAIL-OPEN -- empty sub on a git segment triggers the parse-ambiguity block below

  # Fail-closed parse guard: a git invocation whose subcommand cannot be
  # resolved is ambiguous → block rather than risk passing a real destructive op.
  if [[ -z "$sub" ]]; then
    echo "CANON: could not parse git subcommand — blocking fail-closed." >&2
    exit 2
  fi

  args=$(git_subcommand_args "$segment" "$sub")

  case "$sub" in
    reset)
      if printf '%s' "$args" | grep -qE '(^|[[:space:]])--hard([[:space:]]|$)'; then
        if is_canon_worktree_command "$segment"; then
          continue
        fi
        cat <<EOF >&2
CANON: Destructive git operation detected — git reset --hard. This discards all uncommitted changes and cannot be undone. Ensure you have committed or stashed any work you want to keep.
EOF
        exit 2
      fi
      ;;
    clean)
      # Block on a short-flag bundle containing 'f' (-f, -fd, -xf, …) OR --force.
      if printf '%s' "$args" | grep -qE '(^|[[:space:]])-[a-zA-Z]*f' \
         || printf '%s' "$args" | grep -qE '(^|[[:space:]])--force([[:space:]]|$)'; then
        if is_canon_worktree_command "$segment"; then
          continue
        fi
        cat <<EOF >&2
CANON: Destructive git operation detected — git clean -f. This permanently deletes untracked files. Ensure no important untracked files will be lost.
EOF
        exit 2
      fi
      ;;
    checkout)
      # Block when a "--" pathspec separator appears in the checkout's args
      # (git checkout -- . / -- <path> discards working-tree changes). A plain
      # branch switch (git checkout <branch>) has no "--" and is not blocked.
      if printf '%s' "$args" | grep -qE '(^|[[:space:]])--([[:space:]]|$)'; then
        if is_canon_worktree_command "$segment"; then
          continue
        fi
        cat <<EOF >&2
CANON: Destructive git operation detected — git checkout -- . This discards all unstaged changes in the working tree and cannot be undone.
EOF
        exit 2
      fi
      ;;
    branch)
      # Block force-deletion (-D, or --delete with --force) unless EVERY branch
      # operand is a Canon-managed branch (canon/, canon-wave/, canon-task/).
      if printf '%s' "$args" | grep -qE '(^|[[:space:]])-D([[:space:]]|$)' \
         || { printf '%s' "$args" | grep -qE '(^|[[:space:]])--delete([[:space:]]|$)' \
              && printf '%s' "$args" | grep -qE '(^|[[:space:]])--force([[:space:]]|$)'; }; then
        # Extract branch operands: strip everything up to -D, drop quotes and
        # flag tokens, and check every remaining operand is Canon-prefixed.
        # Drop flag tokens AND blank lines. Quote-to-space neutralization above
        # can collapse adjacent quotes into runs of spaces, which tr would turn
        # into empty operand lines; an empty line must not be treated as a
        # non-Canon branch (that would falsely block a valid canon/* delete).
        branch_args=$(printf '%s' "$args" | sed 's/^.*-D[[:space:]]*//' | tr -d '"'"'" | tr ' \t' '\n' | grep -vE '^(-|$)' || true) # DOCUMENTED FAIL-OPEN -- empty operand list falls through to the block below
        if [[ -n "$branch_args" ]]; then
          all_canon=true
          while IFS= read -r branch; do
            if ! printf '%s' "$branch" | grep -qE '^canon(-wave|-task)?/'; then
              all_canon=false
              break
            fi
          done <<< "$branch_args"
          if [[ "$all_canon" == "true" ]]; then
            continue
          fi
        fi
        cat <<EOF >&2
CANON: Destructive git operation detected — git branch -D. This force-deletes a branch even if it has unmerged changes.
EOF
        exit 2
      fi
      ;;
  esac
done <<< "$SEGMENTS"

# No segment was a destructive command — allow
exit 0
