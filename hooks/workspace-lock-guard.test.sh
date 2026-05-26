#!/bin/bash
# Tests for workspace-lock-guard.sh
# Run with: bash hooks/workspace-lock-guard.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$SCRIPT_DIR/workspace-lock-guard.sh"

PASS=0
FAIL=0

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

MASTER_TMP=$(mktemp -d)
trap 'rm -rf "$MASTER_TMP"' EXIT

# run_test — validate exit code only, hook invoked from current directory
# Usage: run_test "description" expected_exit stdin_json
run_test() {
  local description="$1"
  local expected_exit="$2"
  local stdin_json="$3"

  local actual_exit=0
  echo "$stdin_json" | bash "$GUARD" >/dev/null 2>&1 || actual_exit=$?

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

# run_test_in_dir — validate exit code only, hook invoked from a specific dir
# Usage: run_test_in_dir "description" expected_exit repo_dir stdin_json
run_test_in_dir() {
  local description="$1"
  local expected_exit="$2"
  local repo_dir="$3"
  local stdin_json="$4"

  local tmpout
  tmpout=$(mktemp)

  local actual_exit=0
  (cd "$repo_dir" && echo "$stdin_json" | bash "$GUARD" > "$tmpout" 2>&1) || actual_exit=$?

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    echo "        output: $(cat "$tmpout")"
    FAIL=$((FAIL + 1))
  fi
  rm -f "$tmpout"
}

# run_test_in_dir_with_output — validate exit code AND stdout/stderr content
# Usage: run_test_in_dir_with_output "description" expected_exit expected_pattern repo_dir stdin_json
run_test_in_dir_with_output() {
  local description="$1"
  local expected_exit="$2"
  local expected_pattern="$3"
  local repo_dir="$4"
  local stdin_json="$5"

  local tmpout
  tmpout=$(mktemp)

  local actual_exit=0
  (cd "$repo_dir" && echo "$stdin_json" | bash "$GUARD" > "$tmpout" 2>&1) || actual_exit=$?
  local output
  output=$(cat "$tmpout")
  rm -f "$tmpout"

  local exit_ok=true
  local output_ok=true

  if [[ "$actual_exit" -ne "$expected_exit" ]]; then
    exit_ok=false
  fi

  if [[ -n "$expected_pattern" ]] && ! echo "$output" | grep -q "$expected_pattern"; then
    output_ok=false
  fi

  if [[ "$exit_ok" == "true" ]] && [[ "$output_ok" == "true" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    if [[ "$exit_ok" == "false" ]]; then
      echo "        expected exit=$expected_exit, got exit=$actual_exit"
    fi
    if [[ "$output_ok" == "false" ]]; then
      echo "        expected output matching: $expected_pattern"
      echo "        actual output: $output"
    fi
    FAIL=$((FAIL + 1))
  fi
}

# run_test_in_dir_no_pattern — validate exit code AND that output does NOT match pattern
run_test_in_dir_no_pattern() {
  local description="$1"
  local expected_exit="$2"
  local forbidden_pattern="$3"
  local repo_dir="$4"
  local stdin_json="$5"

  local tmpout
  tmpout=$(mktemp)

  local actual_exit=0
  (cd "$repo_dir" && echo "$stdin_json" | bash "$GUARD" > "$tmpout" 2>&1) || actual_exit=$?
  local output
  output=$(cat "$tmpout")
  rm -f "$tmpout"

  local exit_ok=true
  local output_ok=true

  if [[ "$actual_exit" -ne "$expected_exit" ]]; then
    exit_ok=false
  fi

  if [[ -n "$forbidden_pattern" ]] && echo "$output" | grep -q "$forbidden_pattern"; then
    output_ok=false
  fi

  if [[ "$exit_ok" == "true" ]] && [[ "$output_ok" == "true" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    if [[ "$exit_ok" == "false" ]]; then
      echo "        expected exit=$expected_exit, got exit=$actual_exit"
    fi
    if [[ "$output_ok" == "false" ]]; then
      echo "        expected no output matching: $forbidden_pattern"
      echo "        actual output: $output"
    fi
    FAIL=$((FAIL + 1))
  fi
}

# setup_repo — create a minimal temp git repo
setup_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" config user.email "test@test"
  git -C "$dir" config user.name "Test"
  git -C "$dir" config commit.gpgsign false
  echo "initial" > "$dir/file.txt"
  git -C "$dir" add "$dir/file.txt"
  git -C "$dir" commit -q -m "init"
}

# create_lock — write a .lock file for the current branch in a repo
# Usage: create_lock <repo_dir> <lock_json>
create_lock() {
  local repo_dir="$1"
  local lock_json="$2"

  local branch
  branch=$(git -C "$repo_dir" branch --show-current 2>/dev/null || echo "main")

  local sanitized
  sanitized=$(echo "$branch" | tr '/' '--' | tr ' ' '-' | tr -cd 'a-zA-Z0-9-' | tr '[:upper:]' '[:lower:]' | cut -c1-80)

  local lock_dir="$repo_dir/.canon/workspaces/$sanitized"
  mkdir -p "$lock_dir"
  echo "$lock_json" > "$lock_dir/.lock"
}

# fresh_ts — ISO-8601 UTC timestamp (now)
fresh_ts() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# stale_ts — ISO-8601 UTC timestamp 3 hours in the past
stale_ts() {
  if date -d "3 hours ago" +%Y-%m-%dT%H:%M:%SZ >/dev/null 2>&1; then
    date -ud "3 hours ago" +%Y-%m-%dT%H:%M:%SZ
  else
    date -u -v-3H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "2000-01-01T00:00:00Z"
  fi
}

echo ""
echo "=== workspace-lock-guard.sh tests ==="
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Bypass gate: non-commit/merge commands exit 0 immediately (no git context needed)
# ─────────────────────────────────────────────────────────────────────────────
echo "-- Bypass gate: non-commit/merge commands pass through --"

run_test "git push does not trigger guard" 0 \
  '{"command":"git push origin main"}'

run_test "git status does not trigger guard" 0 \
  '{"command":"git status"}'

run_test "git log does not trigger guard" 0 \
  '{"command":"git log --oneline -5"}'

run_test "npm test does not trigger guard" 0 \
  '{"command":"npm test"}'

run_test "empty command passes through" 0 \
  '{"command":""}'

run_test "no command field passes through" 0 \
  '{"tool":"Bash","other":"value"}'

# ─────────────────────────────────────────────────────────────────────────────
# Silent pass: commit/merge with no lock file — no warning, exit 0
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Silent pass: no lock file present --"

REPO_NO_LOCK="$MASTER_TMP/no-lock"
setup_repo "$REPO_NO_LOCK"

run_test_in_dir "git commit with no lock — exits 0" 0 \
  "$REPO_NO_LOCK" \
  '{"command":"git commit -m \"test\""}'

run_test_in_dir_no_pattern "git commit with no lock — no CANON WARNING emitted" 0 \
  "CANON WARNING" \
  "$REPO_NO_LOCK" \
  '{"command":"git commit -m \"test\""}'

# ─────────────────────────────────────────────────────────────────────────────
# Silent pass: stale lock (>2 hours old) is ignored
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Silent pass: stale lock (>2 hours old) --"

REPO_STALE="$MASTER_TMP/stale-lock"
setup_repo "$REPO_STALE"
create_lock "$REPO_STALE" "{\"session_id\":\"other-session\",\"started\":\"$(stale_ts)\"}"

run_test_in_dir "stale lock — exits 0" 0 \
  "$REPO_STALE" \
  '{"command":"git commit -m \"test\"","session_id":"my-session"}'

run_test_in_dir_no_pattern "stale lock — no CANON WARNING emitted" 0 \
  "CANON WARNING" \
  "$REPO_STALE" \
  '{"command":"git commit -m \"test\"","session_id":"my-session"}'

# ─────────────────────────────────────────────────────────────────────────────
# Silent pass: lock belongs to the SAME session — no warning
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Silent pass: lock belongs to same session --"

REPO_SAME="$MASTER_TMP/same-session"
setup_repo "$REPO_SAME"
create_lock "$REPO_SAME" "{\"session_id\":\"my-session-abc\",\"started\":\"$(fresh_ts)\"}"

run_test_in_dir "same-session lock — exits 0" 0 \
  "$REPO_SAME" \
  '{"command":"git commit -m \"test\"","session_id":"my-session-abc"}'

run_test_in_dir_no_pattern "same-session lock — no CANON WARNING" 0 \
  "CANON WARNING" \
  "$REPO_SAME" \
  '{"command":"git commit -m \"test\"","session_id":"my-session-abc"}'

# ─────────────────────────────────────────────────────────────────────────────
# Silent pass: lock has no session_id — treat as no contention
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Silent pass: lock with no session_id --"

REPO_NO_SID="$MASTER_TMP/no-session-id"
setup_repo "$REPO_NO_SID"
create_lock "$REPO_NO_SID" "{\"started\":\"$(fresh_ts)\"}"

run_test_in_dir "lock with no session_id — exits 0" 0 \
  "$REPO_NO_SID" \
  '{"command":"git commit -m \"test\"","session_id":"my-session"}'

run_test_in_dir_no_pattern "lock with no session_id — no CANON WARNING" 0 \
  "CANON WARNING" \
  "$REPO_NO_SID" \
  '{"command":"git commit -m \"test\"","session_id":"my-session"}'

# ─────────────────────────────────────────────────────────────────────────────
# Warning condition: fresh lock from a DIFFERENT session — emit warning, exit 0
# (advisory: never blocks — exit code is always 0)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Warning condition: fresh lock from different session --"

REPO_DIFF="$MASTER_TMP/diff-session"
setup_repo "$REPO_DIFF"
create_lock "$REPO_DIFF" "{\"session_id\":\"other-session-xyz\",\"started\":\"$(fresh_ts)\"}"

run_test_in_dir "different-session lock — exits 0 (advisory, never blocks)" 0 \
  "$REPO_DIFF" \
  '{"command":"git commit -m \"test\"","session_id":"my-session-abc"}'

run_test_in_dir_with_output "different-session lock — emits CANON WARNING" 0 \
  "CANON WARNING" \
  "$REPO_DIFF" \
  '{"command":"git commit -m \"test\"","session_id":"my-session-abc"}'

# Warning should contain the branch name
BRANCH=$(git -C "$REPO_DIFF" branch --show-current)
run_test_in_dir_with_output "warning message includes branch name '$BRANCH'" 0 \
  "$BRANCH" \
  "$REPO_DIFF" \
  '{"command":"git commit -m \"test\"","session_id":"my-session-abc"}'

# ─────────────────────────────────────────────────────────────────────────────
# Warning condition: git merge also triggers the guard
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Warning condition: git merge with different-session lock --"

REPO_MERGE="$MASTER_TMP/merge"
setup_repo "$REPO_MERGE"
create_lock "$REPO_MERGE" "{\"session_id\":\"other-session-xyz\",\"started\":\"$(fresh_ts)\"}"

run_test_in_dir "git merge triggers guard — exits 0" 0 \
  "$REPO_MERGE" \
  '{"command":"git merge feature/branch","session_id":"my-session-abc"}'

run_test_in_dir_with_output "git merge with different-session lock — emits CANON WARNING" 0 \
  "CANON WARNING" \
  "$REPO_MERGE" \
  '{"command":"git merge feature/branch","session_id":"my-session-abc"}'

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi

exit 0
