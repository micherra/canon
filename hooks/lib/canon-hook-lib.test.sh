#!/usr/bin/env bash
# canon-hook-lib.test.sh — Unit tests for canon-hook-lib.sh
#
# Run: bash hooks/lib/canon-hook-lib.test.sh
# Exit 0: all tests pass. Exit 1: one or more failures.

set -euo pipefail

# Locate the library relative to this test file.
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hooks/lib/canon-hook-lib.sh
source "${LIB_DIR}/canon-hook-lib.sh"

# ---------------------------------------------------------------------------
# Minimal test harness
# ---------------------------------------------------------------------------
PASS=0
FAIL=0
ERRORS=()

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    PASS=$(( PASS + 1 ))
    printf '  PASS  %s\n' "$label"
  else
    FAIL=$(( FAIL + 1 ))
    ERRORS+=("FAIL: $label — expected $(printf '%q' "$expected"), got $(printf '%q' "$actual")")
    printf '  FAIL  %s\n        expected: %q\n        actual:   %q\n' "$label" "$expected" "$actual"
  fi
}

assert_true() {
  local label="$1"
  shift
  if "$@" 2>/dev/null; then
    PASS=$(( PASS + 1 ))
    printf '  PASS  %s\n' "$label"
  else
    FAIL=$(( FAIL + 1 ))
    ERRORS+=("FAIL: $label — expected exit 0 (true), got non-zero")
    printf '  FAIL  %s  (expected true)\n' "$label"
  fi
}

assert_false() {
  local label="$1"
  shift
  if ! "$@" 2>/dev/null; then
    PASS=$(( PASS + 1 ))
    printf '  PASS  %s\n' "$label"
  else
    FAIL=$(( FAIL + 1 ))
    ERRORS+=("FAIL: $label — expected non-zero (false), got exit 0")
    printf '  FAIL  %s  (expected false)\n' "$label"
  fi
}

# ---------------------------------------------------------------------------
# canon_extract_command
# ---------------------------------------------------------------------------
printf '\n=== canon_extract_command ===\n'

VALID_JSON='{"tool_name":"Bash","command":"git commit -m test","session_id":"abc"}'
assert_eq "valid JSON — extracts command" \
  "git commit -m test" \
  "$(canon_extract_command "$VALID_JSON")"

EMPTY_JSON='{}'
assert_eq "empty JSON — returns empty string" \
  "" \
  "$(canon_extract_command "$EMPTY_JSON")"

MALFORMED_JSON='not json at all'
# Should not crash; may return empty.
RESULT=$(canon_extract_command "$MALFORMED_JSON" 2>/dev/null || true)
assert_eq "malformed JSON — does not crash" \
  "" \
  "$RESULT"

EMPTY_INPUT=''
assert_eq "empty input — returns empty string" \
  "" \
  "$(canon_extract_command "$EMPTY_INPUT")"

# YYY2 regression: the real Claude Code payload wraps command under tool_input.
# This is the extraction path the entire jq migration was built for.
NESTED_JSON='{"tool_name":"Bash","tool_input":{"command":"git commit -m \"test\""}}'
assert_eq "nested tool_input.command — extracts command" \
  'git commit -m "test"' \
  "$(canon_extract_command "$NESTED_JSON")"

NESTED_NO_CMD='{"tool_name":"Bash","tool_input":{"other":"value"}}'
assert_eq "nested tool_input without command — returns empty string" \
  "" \
  "$(canon_extract_command "$NESTED_NO_CMD")"

# Flat .command takes lower priority; .tool_input.command wins when both present.
BOTH_JSON='{"command":"flat-cmd","tool_input":{"command":"nested-cmd"}}'
assert_eq "both command paths — tool_input.command takes precedence" \
  "nested-cmd" \
  "$(canon_extract_command "$BOTH_JSON")"

# Escaped-quote value — the grep/sed fallback must NOT return a lone backslash.
# When jq is present it parses correctly; when jq is absent the fallback must
# return empty (fail-closed) rather than a garbage partial parse.
#
# Build a minimal PATH that includes grep/sed/bash/git/head/awk/printf/tr but
# NOT jq, so that command -v jq returns non-zero inside the subshell.
# Use /usr/bin/which to get the real binary path, not a shell function wrapper.
_LIB_TMPBIN=$(mktemp -d)
for _tool in grep sed awk head bash git printf tr cat echo dirname basename; do
  _tp=$(/usr/bin/which "$_tool" 2>/dev/null || true)
  if [[ -n "$_tp" ]]; then
    ln -sf "$_tp" "$_LIB_TMPBIN/$_tool" 2>/dev/null || true
  fi
done
NO_JQ_TEST_PATH="$_LIB_TMPBIN"
# Register cleanup for test dir
trap 'rm -rf "$_LIB_TMPBIN"' EXIT

ESCAPED_RESULT=$(PATH="$NO_JQ_TEST_PATH" bash -c '
  source "'"${LIB_DIR}/canon-hook-lib.sh"'"
  canon_extract_command '"'"'{"tool_input":{"command":"\"git checkout -- ."}}'"'"'
' 2>/dev/null || true)
assert_eq "truly-absent-jq: escaped-quote value returns empty (fail-closed)" \
  "" \
  "$ESCAPED_RESULT"

# Normal value with truly absent jq — must still extract correctly.
PLAIN_RESULT=$(PATH="$NO_JQ_TEST_PATH" bash -c '
  source "'"${LIB_DIR}/canon-hook-lib.sh"'"
  canon_extract_command '"'"'{"command":"git status"}'"'"'
' 2>/dev/null || true)
assert_eq "truly-absent-jq: plain command value extracts correctly" \
  "git status" \
  "$PLAIN_RESULT"

# ---------------------------------------------------------------------------
# canon_git_dir_arg
# ---------------------------------------------------------------------------
printf '\n=== canon_git_dir_arg ===\n'

# Use a directory that is guaranteed to exist on any system.
REAL_DIR="/tmp"

assert_eq "cd /tmp && git commit — returns -C /tmp" \
  "-C /tmp" \
  "$(canon_git_dir_arg "cd /tmp && git commit -m msg")"

assert_eq "no cd prefix — returns empty" \
  "" \
  "$(canon_git_dir_arg "git commit -m msg")"

assert_eq "nonexistent dir — returns empty" \
  "" \
  "$(canon_git_dir_arg "cd /this/path/does/not/exist/9x7z && git commit")"

assert_eq "leading spaces before cd — returns -C /tmp" \
  "-C /tmp" \
  "$(canon_git_dir_arg "  cd /tmp && git commit")"

assert_eq "cd with trailing space before && — returns -C /tmp" \
  "-C /tmp" \
  "$(canon_git_dir_arg "cd /tmp  && git commit")"

# ---------------------------------------------------------------------------
# canon_is_git_cmd
# ---------------------------------------------------------------------------
printf '\n=== canon_is_git_cmd (subcmd=commit) ===\n'

assert_true  "plain git commit" \
  canon_is_git_cmd "git commit -m msg" "commit"

assert_true  "git -C /path commit" \
  canon_is_git_cmd "git -C /some/path commit -m msg" "commit"

assert_true  "cd /x && git commit" \
  canon_is_git_cmd "cd /x && git commit -m msg" "commit"

assert_true  "bare git commit (no args)" \
  canon_is_git_cmd "git commit" "commit"

assert_false "git diff pre-commit-branch-guard.sh — must NOT match commit" \
  canon_is_git_cmd "git diff pre-commit-branch-guard.sh" "commit"

assert_false "git log --oneline — not a commit" \
  canon_is_git_cmd "git log --oneline" "commit"

assert_false "git stash — not a commit" \
  canon_is_git_cmd "git stash" "commit"

printf '\n=== canon_is_git_cmd (subcmd=merge) ===\n'

assert_true  "git merge branch" \
  canon_is_git_cmd "git merge feature/foo" "merge"

assert_false "git commit — not a merge" \
  canon_is_git_cmd "git commit -m msg" "merge"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
TOTAL=$(( PASS + FAIL ))
printf '\n--- Results: %d/%d passed ---\n' "$PASS" "$TOTAL"
if [[ $FAIL -gt 0 ]]; then
  printf '\nFailed tests:\n'
  for err in "${ERRORS[@]}"; do
    printf '  %s\n' "$err"
  done
  exit 1
fi
exit 0
