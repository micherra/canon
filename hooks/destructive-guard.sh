#!/bin/bash
# Canon Destructive Git Command Guard
# Runs as a PreToolUse hook on Bash commands.
# Blocks destructive git operations (reset --hard, clean -f, checkout -- .,
# branch -D) so the user is prompted for permission before they execute.
#
# Detection pipeline (in order):
#   1. Extract command via canon_extract_command (jq with grep/sed fallback).
#   2. Strip shell comments via canon_strip_comments (char-walk preserving
#      quote state; # inside quotes is NOT a comment; preserves newlines).
#   3. Delete shell quote characters via tr -d (bash quote-removal).
#   4. Segment on && || ; | to evaluate each segment independently.
#   5. For each segment, use canon_has_git_token (tokenizer-authoritative)
#      to check for a standalone "git" token — skips segments without one.
#   5a. String-executing-wrapper expansion: when a segment has no standalone
#      "git" token but its effective command is a string-executing wrapper
#      (eval, bash -c, sh -c, zsh -c, ksh -c — and their path-qualified and
#      prefixed forms via command/nohup/env/timeout/nice),
#      canon_unwrap_string_exec_arg extracts the inner string argument using a
#      three-way return code: (a) not a wrapper → skip-pass; (b) wrapper,
#      extracted → recurse on inner segments; (c) wrapper but unparseable →
#      fail-CLOSED (exit 2).  This ensures a recognised shell wrapper is never
#      silently skipped even when the inner command cannot be parsed.
#      Combined short flags (-ec, -lc, -xc where c is last) are handled.
#      Path-qualified wrappers (/bin/bash, /usr/bin/env) are matched by
#      basename.  Prefix-owned flags (env -i, command -p) are skipped before
#      resolving the wrapper name.  Recursion is capped at CANON_WRAPPER_MAX_DEPTH
#      (3) and fails closed on depth-exceeded.
#      Non-executing wrappers (echo "git reset --hard") remain pass-through.
#   6. Resolve the git subcommand of each segment via canon_git_subcommand,
#      which uses shape validation: subcommand tokens containing $ { } ( )
#      cannot be resolved → parse-ambiguity guard blocks fail-closed.
#   7. Inspect only that subcommand's own arguments for destructive flags.
#
# A segment with a real "git" token whose subcommand cannot be resolved
# blocks fail-closed (exit 2).
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

# Strip shell comments before any further processing. This must run BEFORE
# both RAW_COMMAND and the quote-deletion derivations so that both streams
# share the same comment-stripped base. A comment line that happens to end
# in the word "git" or contains a quoted git string is harmless after
# stripping. The newline is always preserved, so segment line pairing is
# unchanged. If the entire command reduces to empty (comments-only), the
# loop naturally no-ops and exits 0.
COMMAND=$(printf '%s' "$COMMAND" | canon_strip_comments)

# Preserve the raw (post-comment-strip, pre-quote-deletion) command for
# subcommand resolution. canon_git_subcommand requires the raw form so that
# quoted multi-word values for value-consuming globals (e.g. -C "my dir")
# are treated as ONE token — without this, quote deletion would split "my dir"
# into two tokens, causing "dir" to be misidentified as the subcommand →
# fail-OPEN (Bug-2 fix).
RAW_COMMAND="$COMMAND"

# canon_delete_quotes — single source of truth for quote-removal.
# Deletes all shell quote characters (" and ') from the input, exactly
# reproducing bash quote-removal.  Called at the top-level and at each
# recursive unwrap site so both paths apply the SAME transformation and
# can never drift apart.
canon_delete_quotes() {
  printf '%s' "$1" | tr -d '"'"'"''
}

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
COMMAND=$(canon_delete_quotes "$COMMAND")

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
# Two parallel segment streams:
#   SEGMENTS     — quote-deleted form (COMMAND); used for flag detection
#                  via git_subcommand_args and the per-subcommand case switch.
#   RAW_SEGMENTS — raw form (RAW_COMMAND, pre-quote-deletion); passed to
#                  canon_git_subcommand so quoted multi-word values for
#                  value-consuming globals (-C "my dir") are treated as ONE
#                  token during subcommand resolution (Bug-2 fix).
SEGMENTS=$(printf '%s' "$COMMAND" | sed -E 's/(&&|\|\||;|\|)/\n/g')
RAW_SEGMENTS=$(printf '%s' "$RAW_COMMAND" | sed -E 's/(&&|\|\||;|\|)/\n/g')

# Maximum recursion depth for string-executing wrapper expansion.
# Handles nesting like: bash -c 'eval "git reset --hard"' (depth 2).
# Cap at 3 to prevent pathological inputs from looping.
CANON_WRAPPER_MAX_DEPTH=3

# ---------------------------------------------------------------------------
# process_segment <segment> <raw_segment> <depth>
#
# Evaluates a single segment pair for destructive git operations.
# Exits the script (exit 2) if a destructive op is found.
# Returns 0 otherwise (caller continues to the next segment).
#
# <depth> tracks how many times we've expanded a string-executing wrapper.
# When depth reaches CANON_WRAPPER_MAX_DEPTH and a wrapper is encountered,
# the guard fails closed (exit 2) rather than skipping — better to over-block
# than allow a deeply nested destructive op.
# ---------------------------------------------------------------------------
process_segment() {
  local segment="$1"
  local raw_segment="$2"
  local depth="$3"

  # Does this segment contain a standalone "git" token (quote-aware)?
  # canon_has_git_token tokenizes the RAW segment so quoted strings like
  # 'echo "git worktree remove exit: $?"' correctly return no git token.
  if ! canon_has_git_token "$raw_segment"; then
    # No standalone git token. Check whether this segment is a
    # string-executing wrapper whose quoted argument may contain git commands.
    # canon_unwrap_string_exec_arg uses a three-way return code:
    #   rc=0  — recognised wrapper, inner command extracted (printed on stdout)
    #   rc=1  — not a string-executing wrapper at all (echo, printf, etc.)
    #   rc=2  — recognised wrapper but inner arg unparseable/empty → fail-CLOSED
    local inner_cmd
    local _unwrap_rc=0
    inner_cmd=$(canon_unwrap_string_exec_arg "$raw_segment") || _unwrap_rc=$?

    if [[ "$_unwrap_rc" -eq 2 ]]; then
      # Outcome (c): recognised shell wrapper whose inner command cannot be
      # safely extracted.  Fail closed — never skip-pass a recognised wrapper.
      echo "CANON: string-executing wrapper inner command unparseable — blocking fail-closed." >&2
      exit 2
    fi

    if [[ "$_unwrap_rc" -ne 0 ]] || [[ -z "$inner_cmd" ]]; then
      # Outcome (a): not a string-executing wrapper — BUT check for ambiguous
      # git tokens (e.g. git$IFS, git${X}, git$(cmd)) that start with "git"
      # but are NOT exactly "git".  These defeat canon_has_git_token's exact
      # match and would otherwise silently pass through.  Since the runtime
      # value of the expansion is unknown, fail closed.
      if canon_has_ambiguous_git_token "$raw_segment"; then
        echo "CANON: ambiguous git-prefixed token detected — blocking fail-closed." >&2
        exit 2
      fi
      return 0
    fi

    # Depth guard: cap recursion to prevent pathological nesting.
    if [[ "$depth" -ge "$CANON_WRAPPER_MAX_DEPTH" ]]; then
      echo "CANON: string-executing wrapper nesting exceeds depth limit — blocking fail-closed." >&2
      exit 2
    fi

    # Expand the inner string: re-segment on && || ; | and recurse.
    local inner_segs
    inner_segs=$(printf '%s' "$inner_cmd" | sed -E 's/(&&|\|\||;|\|)/\n/g')
    local sub_depth=$(( depth + 1 ))
    while IFS= read -r inner_seg; do
      # Trim whitespace.
      inner_seg=$(printf '%s' "$inner_seg" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
      [[ -z "$inner_seg" ]] && continue
      # Mirror the top-level (quote-deleted, raw) pairing exactly:
      #   segment    — quote-deleted form for flag/pattern matching
      #   raw_segment — raw form for subcommand resolution (canon_git_subcommand)
      # canon_unwrap_string_exec_arg strips the enclosing quote chars from the
      # extracted string, but single/double quotes AROUND individual flags
      # (e.g. '--hard', "-fd") survive inside the string and must be deleted
      # before the flag-boundary greps.  Passing inner_seg as BOTH args leaves
      # those interior quotes intact → the flag greps miss → fail-OPEN.
      local inner_seg_qd
      inner_seg_qd=$(canon_delete_quotes "$inner_seg")
      process_segment "$inner_seg_qd" "$inner_seg" "$sub_depth"
    done <<< "$inner_segs"
    return 0
  fi

  # Resolve subcommand from the RAW segment (pre-quote-deletion) so that
  # quoted multi-word option values (e.g. -C "my dir") stay as one token.
  local sub
  sub=$(canon_git_subcommand "$raw_segment" || true) # DOCUMENTED FAIL-OPEN -- empty sub on a git segment triggers the parse-ambiguity block below

  # Fail-closed parse guard: a git invocation whose subcommand cannot be
  # resolved is ambiguous → block rather than risk passing a real destructive op.
  if [[ -z "$sub" ]]; then
    echo "CANON: could not parse git subcommand — blocking fail-closed." >&2
    exit 2
  fi

  local args
  args=$(git_subcommand_args "$segment" "$sub")

  case "$sub" in
    reset)
      if printf '%s' "$args" | grep -qE '(^|[[:space:]])--hard([[:space:]]|$)'; then
        if is_canon_worktree_command "$segment"; then
          return 0
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
          return 0
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
          return 0
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
        local branch_args
        branch_args=$(printf '%s' "$args" | sed 's/^.*-D[[:space:]]*//' | tr -d '"'"'" | tr ' \t' '\n' | grep -vE '^(-|$)' || true) # DOCUMENTED FAIL-OPEN -- empty operand list falls through to the block below
        if [[ -n "$branch_args" ]]; then
          local all_canon=true
          local branch
          while IFS= read -r branch; do
            if ! printf '%s' "$branch" | grep -qE '^canon(-wave|-task)?/'; then
              all_canon=false
              break
            fi
          done <<< "$branch_args"
          if [[ "$all_canon" == "true" ]]; then
            return 0
          fi
        fi
        cat <<EOF >&2
CANON: Destructive git operation detected — git branch -D. This force-deletes a branch even if it has unmerged changes.
EOF
        exit 2
      fi
      ;;
  esac
}

# Pair each quote-deleted segment with its corresponding raw segment by line
# number. Both streams have the same number of lines because they were built
# by the same sed substitution applied to strings that differ only in quote
# characters (which cannot introduce or remove separator characters).
seg_idx=0
while IFS= read -r segment; do
  seg_idx=$(( seg_idx + 1 ))
  raw_segment=$(printf '%s' "$RAW_SEGMENTS" | sed -n "${seg_idx}p" || true) # DOCUMENTED FAIL-OPEN -- missing raw segment falls back to quote-deleted segment for subcommand resolution
  [[ -z "$raw_segment" ]] && raw_segment="$segment"

  # Trim leading/trailing whitespace.
  segment=$(printf '%s' "$segment" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
  raw_segment=$(printf '%s' "$raw_segment" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
  [[ -z "$segment" ]] && continue

  process_segment "$segment" "$raw_segment" 0
done <<< "$SEGMENTS"

# No segment was a destructive command — allow
exit 0
