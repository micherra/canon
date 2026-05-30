#!/usr/bin/env bash
# canon-hook-lib.sh — Shared helper functions for Canon PreToolUse/PostToolUse hooks.
#
# Source this file from hook scripts to get three reusable utilities:
#
#   canon_extract_command "$INPUT"
#     Parses the "command" field from a Claude Code hook JSON input string.
#     Prints the command on stdout. Prints nothing if the field is absent or empty.
#
#   canon_git_dir_arg "$COMMAND"
#     Inspects a compound command (e.g. "cd /path && git commit ...") for a leading
#     `cd <dir>` segment and, if that directory exists, prints "-C <dir>" on stdout.
#     Prints nothing when no cd target is found or the directory does not exist.
#     Uses POSIX [[:space:]] for macOS BSD grep compatibility (no \s).
#
#   canon_is_git_cmd "$COMMAND" "$SUBCMD"
#     Returns 0 (true) when COMMAND invokes git with the exact subcommand SUBCMD,
#     without false-positiving on filenames that contain SUBCMD (e.g. "commit" in
#     "git diff pre-commit-branch-guard.sh").
#     Handles: plain "git commit", "git -C /path commit", "cd /x && git commit".

# ---------------------------------------------------------------------------
# canon_extract_command <json>
# ---------------------------------------------------------------------------
# Extracts the value of the "command" JSON key from a Claude Code hook payload.
# Handles optional whitespace around the colon and the surrounding quotes.
# Prints the extracted value on stdout; prints nothing if not found.
#
# NOTE: This is a grep/sed fallback sufficient for the string-typed "command"
# field. For deeply nested or escaped JSON, use jq if available.
canon_extract_command() {
  local input="$1"
  if [[ -z "$input" ]]; then
    return 0
  fi
  # Try jq first (most robust), fall back to grep/sed.
  if command -v jq >/dev/null 2>&1; then
    local result
    result=$(printf '%s' "$input" | jq -r '.tool_input.command // .command // empty' 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- empty result triggers caller's pass-through guard
    printf '%s' "$result"
  else
    printf '%s' "$input" \
      | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | head -1 \
      | sed 's/.*"command"[[:space:]]*:[[:space:]]*"//;s/"$//' \
      || true # DOCUMENTED FAIL-OPEN -- grep/sed fallback: no match means no command field in input
  fi
}

# ---------------------------------------------------------------------------
# canon_git_dir_arg <command>
# ---------------------------------------------------------------------------
# Detects a leading "cd <dir> &&" prefix in a shell command and, when the
# extracted directory exists on disk, prints "-C <dir>" so git commands can
# be scoped to that directory.
#
# Handles:
#   "cd /some/path && git commit -m msg"   → "-C /some/path"
#   "  cd ./relative && git commit"        → "-C ./relative"  (if dir exists)
#   "git commit -m msg"                    → ""
#   "cd /nonexistent && git commit"        → ""
#
# Uses POSIX [[:space:]] throughout — macOS BSD grep does not support \s.
canon_git_dir_arg() {
  local command="$1"
  local cd_target

  # Extract the first `cd <dir>` segment that appears before a `&&` or `;`.
  # Matches optional leading whitespace, then "cd", then the directory token.
  cd_target=$(printf '%s' "$command" \
    | grep -oE '^[[:space:]]*cd[[:space:]]+[^;&|]+' \
    | sed 's/^[[:space:]]*cd[[:space:]]*//' \
    | sed 's/[[:space:]]*$//' \
    || true) # DOCUMENTED FAIL-OPEN -- no cd prefix in command is the normal case

  if [[ -n "$cd_target" ]] && [[ -d "$cd_target" ]]; then
    printf '%s' "-C $cd_target"
  fi
}

# ---------------------------------------------------------------------------
# canon_is_git_cmd <command> <subcmd>
# ---------------------------------------------------------------------------
# Returns 0 when COMMAND is a git invocation of subcommand SUBCMD as a
# standalone word — not as part of a filename argument.
#
# Match logic:
#   Strip a leading "cd <dir> &&" prefix (compound commands).
#   Then check: git [flags] <subcmd>
#   where <subcmd> is bounded on both sides so "commit" does NOT match
#   "pre-commit-branch-guard.sh" in argument position.
#
# Examples (SUBCMD = "commit"):
#   "git commit -m msg"                          → 0 (true)
#   "git -C /path commit -m msg"                 → 0 (true)
#   "cd /x && git commit -m msg"                 → 0 (true)
#   "git diff pre-commit-branch-guard.sh"        → 1 (false)
#   "git log --oneline"                          → 1 (false, SUBCMD="commit")
#   "git commit" (bare)                          → 0 (true)
#
# Uses [[:space:]] and [[:alnum:]] throughout for POSIX/BSD compatibility.
canon_is_git_cmd() {
  local command="$1"
  local subcmd="$2"
  local stripped

  # Strip a leading "cd <dir> &&" prefix so compound commands are handled.
  stripped=$(printf '%s' "$command" \
    | sed 's/^[[:space:]]*cd[[:space:]]*[^;&|]*&&[[:space:]]*//' \
    || true) # DOCUMENTED FAIL-OPEN -- sed no-match means no cd prefix to strip
  # If sed produced nothing (no match), keep the original.
  if [[ -z "$stripped" ]]; then
    stripped="$command"
  fi

  # Match: git (optional flag tokens) <subcmd> (followed by whitespace or end)
  #
  # Strategy: extract the words between "git" and the subcommand boundary.
  # The subcommand is the FIRST word after "git" that does not begin with "-"
  # and is not a path argument to a preceding "-" flag.
  #
  # We handle this with a word-by-word loop:
  #   1. Strip "git" from the front of the command.
  #   2. Walk tokens: skip "-flag" words and their value arguments (non-"-" word).
  #   3. The first non-flag, non-argument word must equal the subcommand.
  local after_git
  after_git=$(printf '%s' "$stripped" \
    | sed -E 's/(^|[[:space:]])git[[:space:]]+//' \
    || true) # DOCUMENTED FAIL-OPEN -- sed no-match means "git" keyword not found

  local remaining="$after_git"
  local expect_value=0

  while true; do
    # Get first word
    local first
    first=$(printf '%s' "$remaining" | awk '{print $1}')
    if [[ -z "$first" ]]; then
      # No more tokens — subcommand not found
      return 1
    fi

    if [[ "$expect_value" -eq 1 ]]; then
      # This token is the value argument for the previous "-flag", skip it
      expect_value=0
      remaining=$(printf '%s' "$remaining" | sed -E 's/^[[:space:]]*[^[:space:]]+[[:space:]]*//' || true) # DOCUMENTED FAIL-OPEN -- advancing past token in word-by-word parser
      continue
    fi

    if [[ "$first" == -* ]]; then
      # Flag token — skip it; the next token is its value argument
      expect_value=1
      remaining=$(printf '%s' "$remaining" | sed -E 's/^[[:space:]]*[^[:space:]]+[[:space:]]*//' || true) # DOCUMENTED FAIL-OPEN -- advancing past token in word-by-word parser
      continue
    fi

    # First non-flag word — this must be the subcommand
    [[ "$first" == "$subcmd" ]]
    return $?
  done
}
