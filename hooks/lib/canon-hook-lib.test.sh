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
