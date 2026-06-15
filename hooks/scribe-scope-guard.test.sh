#!/bin/bash
# Tests for scribe-scope-guard.sh
# Run with: bash hooks/scribe-scope-guard.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$SCRIPT_DIR/scribe-scope-guard.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

echo ""
echo "=== scribe-scope-guard.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# run_guard <expected_exit> <repo_dir> <base_commit> [threshold] <description>
run_guard() {
  local expected_exit="$1"
  local repo_dir="$2"
  local base_commit="$3"
  local threshold="${4:-}"
  local description="$5"

  local actual_exit=0
  if [[ -n "$threshold" ]]; then
    (cd "$repo_dir" && bash "$GUARD" "$base_commit" "$threshold") >/dev/null 2>&1 || actual_exit=$?
  else
    (cd "$repo_dir" && bash "$GUARD" "$base_commit") >/dev/null 2>&1 || actual_exit=$?
  fi

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

# run_guard_with_output <expected_exit> <expected_pattern> <repo_dir> <base_commit> [threshold] <description>
run_guard_with_output() {
  local expected_exit="$1"
  local expected_pattern="$2"
  local repo_dir="$3"
  local base_commit="$4"
  local threshold="${5:-}"
  local description="$6"

  local actual_exit=0
  local output
  if [[ -n "$threshold" ]]; then
    output=$(cd "$repo_dir" && bash "$GUARD" "$base_commit" "$threshold" 2>&1) || actual_exit=$?
  else
    output=$(cd "$repo_dir" && bash "$GUARD" "$base_commit" 2>&1) || actual_exit=$?
  fi

  local exit_ok=true
  local output_ok=true

  if [[ "$actual_exit" -ne "$expected_exit" ]]; then
    exit_ok=false
  fi

  if ! echo "$output" | grep -qF "$expected_pattern"; then
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
      echo "        expected output containing: $expected_pattern"
      echo "        actual output: $output"
    fi
    FAIL=$((FAIL + 1))
  fi
}

# setup_claude_repo <repo_dir>
# Creates a minimal git repo with a base commit (no CLAUDE.md).
setup_claude_repo() {
  local repo_dir="$1"
  mkdir -p "$repo_dir"
  git -C "$repo_dir" init -q
  git -C "$repo_dir" config user.email "test@example.com"
  git -C "$repo_dir" config user.name "Test User"
  git -C "$repo_dir" config commit.gpgsign false

  echo "placeholder" > "$repo_dir/placeholder.txt"
  git -C "$repo_dir" add placeholder.txt
  git -C "$repo_dir" commit -q -m "base"
}

# add_claude_md_change <repo_dir> <num_deleted_lines> <num_added_lines>
# Adds a commit that modifies CLAUDE.md: removes N lines and adds M lines.
add_claude_md_change() {
  local repo_dir="$1"
  local num_deleted="$2"
  local num_added="$3"

  # First create a CLAUDE.md with enough lines to delete
  {
    for i in $(seq 1 "$((num_deleted + 5))"); do
      echo "# Original line $i"
    done
  } > "$repo_dir/CLAUDE.md"

  git -C "$repo_dir" add "$repo_dir/CLAUDE.md"
  git -C "$repo_dir" commit -q -m "add CLAUDE.md base"

  # Now make a HEAD commit that removes num_deleted lines and adds num_added lines
  {
    # Only keep lines after the deleted ones
    for i in $(seq "$((num_deleted + 1))" "$((num_deleted + 5))"); do
      echo "# Original line $i"
    done
    # Add new lines
    for i in $(seq 1 "$num_added"); do
      echo "# New line $i"
    done
  } > "$repo_dir/CLAUDE.md"

  git -C "$repo_dir" add "$repo_dir/CLAUDE.md"
  git -C "$repo_dir" commit -q -m "modify CLAUDE.md"
}

# ---------------------------------------------------------------------------
# Test setup
# ---------------------------------------------------------------------------
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

# ---------------------------------------------------------------------------
# TC1: OVER THRESHOLD — deletions > 5 (default) → exit 2 + SCRIBE-SCOPE message
# ---------------------------------------------------------------------------
echo "-- Over threshold (default 5, should block, exit 2) --"

REPO1="$TMP_DIR/repo1"
setup_claude_repo "$REPO1"
add_claude_md_change "$REPO1" 10 2
BASE1=$(git -C "$REPO1" rev-parse HEAD~1)

run_guard_with_output 2 "SCRIBE-SCOPE: 10 CLAUDE.md lines deleted (threshold 5)" \
  "$REPO1" "$BASE1" "" \
  "10 deletions > default threshold 5 → exit 2 SCRIBE-SCOPE"

# ---------------------------------------------------------------------------
# TC2: UNDER THRESHOLD — deletions ≤ 5 (default) → exit 0
# ---------------------------------------------------------------------------
echo ""
echo "-- Under threshold (default 5, should pass, exit 0) --"

REPO2="$TMP_DIR/repo2"
setup_claude_repo "$REPO2"
add_claude_md_change "$REPO2" 3 2
BASE2=$(git -C "$REPO2" rev-parse HEAD~1)

run_guard 0 "$REPO2" "$BASE2" "" \
  "3 deletions ≤ default threshold 5 → exit 0"

# ---------------------------------------------------------------------------
# TC3: EXACTLY AT THRESHOLD — deletions == 5 (default) → exit 0 (not blocked)
# ---------------------------------------------------------------------------
echo ""
echo "-- Exactly at threshold (should pass, exit 0) --"

REPO3="$TMP_DIR/repo3"
setup_claude_repo "$REPO3"
add_claude_md_change "$REPO3" 5 2
BASE3=$(git -C "$REPO3" rev-parse HEAD~1)

run_guard 0 "$REPO3" "$BASE3" "" \
  "5 deletions == default threshold 5 → exit 0 (threshold is >, not >=)"

# ---------------------------------------------------------------------------
# TC4: CUSTOM THRESHOLD — threshold = 20, deletions = 15 → exit 0
# ---------------------------------------------------------------------------
echo ""
echo "-- Custom threshold honored (should pass, exit 0) --"

REPO4="$TMP_DIR/repo4"
setup_claude_repo "$REPO4"
add_claude_md_change "$REPO4" 15 2
BASE4=$(git -C "$REPO4" rev-parse HEAD~1)

run_guard 0 "$REPO4" "$BASE4" "20" \
  "15 deletions ≤ custom threshold 20 → exit 0"

# ---------------------------------------------------------------------------
# TC5: CUSTOM THRESHOLD — threshold = 10, deletions = 15 → exit 2
# ---------------------------------------------------------------------------
echo ""
echo "-- Custom threshold blocks (should block, exit 2) --"

REPO5="$TMP_DIR/repo5"
setup_claude_repo "$REPO5"
add_claude_md_change "$REPO5" 15 2
BASE5=$(git -C "$REPO5" rev-parse HEAD~1)

run_guard_with_output 2 "SCRIBE-SCOPE: 15 CLAUDE.md lines deleted (threshold 10)" \
  "$REPO5" "$BASE5" "10" \
  "15 deletions > custom threshold 10 → exit 2"

# ---------------------------------------------------------------------------
# TC6: MISSING BASE COMMIT ARG — fail-closed exit 2
# ---------------------------------------------------------------------------
echo ""
echo "-- Missing base commit (fail-closed, exit 2) --"

REPO6="$TMP_DIR/repo6"
setup_claude_repo "$REPO6"

actual_exit=0
(cd "$REPO6" && bash "$GUARD") >/dev/null 2>&1 || actual_exit=$?
if [[ "$actual_exit" -eq 2 ]]; then
  echo "  PASS: missing base commit → fail-closed exit 2"
  PASS=$((PASS + 1))
else
  echo "  FAIL: missing base commit → expected exit 2, got $actual_exit"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# TC7: INVALID BASE COMMIT — fail-closed exit 2
# ---------------------------------------------------------------------------
echo ""
echo "-- Invalid base commit (fail-closed, exit 2) --"

REPO7="$TMP_DIR/repo7"
setup_claude_repo "$REPO7"

run_guard_with_output 2 "CANON: scribe-scope-guard failed-closed" \
  "$REPO7" "deadbeefdeadbeefdeadbeef00000000deadbeef" "" \
  "invalid base commit → fail-closed exit 2"

# ---------------------------------------------------------------------------
# TC8: NO CLAUDE.MD IN DIFF — no deletions → exit 0
# ---------------------------------------------------------------------------
echo ""
echo "-- No CLAUDE.md in diff (should pass, exit 0) --"

REPO8="$TMP_DIR/repo8"
setup_claude_repo "$REPO8"

# Only change a non-CLAUDE.md file
echo "updated" > "$REPO8/placeholder.txt"
git -C "$REPO8" add "$REPO8/placeholder.txt"
git -C "$REPO8" commit -q -m "update placeholder"
BASE8=$(git -C "$REPO8" rev-parse HEAD~1)

run_guard 0 "$REPO8" "$BASE8" "" \
  "no CLAUDE.md changes → 0 deletions → exit 0"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
