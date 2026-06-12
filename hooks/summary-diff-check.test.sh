#!/bin/bash
# Tests for summary-diff-check.sh
# Run with: bash hooks/summary-diff-check.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKER="$SCRIPT_DIR/summary-diff-check.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

echo ""
echo "=== summary-diff-check.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# run_checker <expected_exit> <repo_dir> <summary_path> <base_commit> <description>
run_checker() {
  local expected_exit="$1"
  local repo_dir="$2"
  local summary_path="$3"
  local base_commit="$4"
  local description="$5"

  local actual_exit=0
  (cd "$repo_dir" && bash "$CHECKER" "$summary_path" "$base_commit") >/dev/null 2>&1 || actual_exit=$?

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

# run_checker_with_output <expected_exit> <expected_pattern> <repo_dir> <summary_path> <base_commit> <description>
run_checker_with_output() {
  local expected_exit="$1"
  local expected_pattern="$2"
  local repo_dir="$3"
  local summary_path="$4"
  local base_commit="$5"
  local description="$6"

  local actual_exit=0
  local output
  output=$(cd "$repo_dir" && bash "$CHECKER" "$summary_path" "$base_commit" 2>&1) || actual_exit=$?

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

# ---------------------------------------------------------------------------
# Fixture builder: creates a temp git repo with a base commit and a HEAD commit
# that adds <added_files> (list of space-separated relative paths).
# Each file gets trivial content that includes its name.
#
# Usage:
#   setup_diff_repo <repo_dir> <added_files...>
#   After: BASE=$(git -C <repo_dir> rev-parse HEAD~1)
# ---------------------------------------------------------------------------
setup_diff_repo() {
  local repo_dir="$1"
  shift
  local added_files=("$@")

  mkdir -p "$repo_dir"
  git -C "$repo_dir" init -q
  git -C "$repo_dir" config user.email "test@example.com"
  git -C "$repo_dir" config user.name "Test User"
  git -C "$repo_dir" config commit.gpgsign false

  # Base commit: a single placeholder file
  echo "base" > "$repo_dir/base.txt"
  git -C "$repo_dir" add base.txt
  git -C "$repo_dir" commit -q -m "base"

  # HEAD commit: add the requested files
  for f in "${added_files[@]}"; do
    local dir
    dir=$(dirname "$repo_dir/$f")
    mkdir -p "$dir"
    # Include the path in content + a symbol name for symbol detection tests
    echo "// added: $f" > "$repo_dir/$f"
    git -C "$repo_dir" add "$repo_dir/$f"
  done
  git -C "$repo_dir" commit -q -m "add files"
}

# build_summary <files_table_rows> <what_changed_content>
# Writes a minimal SUMMARY.md to stdout.
# files_table_rows: newline-separated table rows like: | `path` | added | purpose |
build_summary() {
  local files_rows="$1"
  local what_changed="$2"

  cat <<EOF
## Summary

Some summary text here.

### What Changed

$what_changed

### Files

| File | Action | Purpose |
|------|--------|---------|
$files_rows

### Status

DONE
EOF
}

# ---------------------------------------------------------------------------
# Test setup
# ---------------------------------------------------------------------------
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

# ---------------------------------------------------------------------------
# TC1: PHANTOM FILE — file claimed in SUMMARY but absent from diff → exit 2 + PHANTOM message
# ---------------------------------------------------------------------------
echo "-- Phantom file claim (should block, exit 2) --"

REPO1="$TMP_DIR/repo1"
setup_diff_repo "$REPO1" "hooks/real-file.sh"
BASE1=$(git -C "$REPO1" rev-parse HEAD~1)

SUMMARY1="$TMP_DIR/summary1.md"
build_summary \
  "| \`hooks/real-file.sh\` | added | real |
| \`hooks/phantom-file.sh\` | added | phantom |" \
  "Added \`realFunction\` to hooks/real-file.sh." \
  > "$SUMMARY1"

run_checker_with_output 2 "PHANTOM-CLAIM (file): hooks/phantom-file.sh" \
  "$REPO1" "$SUMMARY1" "$BASE1" \
  "phantom file claim → exit 2 with PHANTOM message"

# ---------------------------------------------------------------------------
# TC2: PHANTOM SYMBOL — symbol claimed in What Changed but absent from diff → exit 2
# ---------------------------------------------------------------------------
echo ""
echo "-- Phantom symbol claim (should block, exit 2) --"

REPO2="$TMP_DIR/repo2"
setup_diff_repo "$REPO2" "hooks/real-file.sh"
BASE2=$(git -C "$REPO2" rev-parse HEAD~1)

# Add a file with a known symbol in the diff
echo "export function realFunction() { return 1; }" >> "$REPO2/hooks/real-file.sh"
git -C "$REPO2" add "$REPO2/hooks/real-file.sh"
git -C "$REPO2" commit -q --amend --no-edit

SUMMARY2="$TMP_DIR/summary2.md"
build_summary \
  "| \`hooks/real-file.sh\` | added | real |" \
  "Added \`realFunction\`. Also added \`phantomSymbol\` (not in diff)." \
  > "$SUMMARY2"

run_checker_with_output 2 "PHANTOM-CLAIM (symbol): phantomSymbol" \
  "$REPO2" "$SUMMARY2" "$BASE2" \
  "phantom symbol claim → exit 2 with PHANTOM (symbol) message"

# ---------------------------------------------------------------------------
# TC3: UNREPORTED CHANGE ONLY — file in diff not in SUMMARY → exit 0 + ADVISORY
# ---------------------------------------------------------------------------
echo ""
echo "-- Unreported change only (should exit 0 with ADVISORY) --"

REPO3="$TMP_DIR/repo3"
setup_diff_repo "$REPO3" "hooks/file-a.sh" "hooks/file-b.sh"
BASE3=$(git -C "$REPO3" rev-parse HEAD~1)

SUMMARY3="$TMP_DIR/summary3.md"
# Note: ### What Changed has no backtick-quoted symbols so symbol check doesn't fire.
# The test is purely about unreported files (file-b.sh in diff but not in SUMMARY).
build_summary \
  "| \`hooks/file-a.sh\` | added | documented |" \
  "Added file-a.sh with new content." \
  > "$SUMMARY3"

run_checker_with_output 0 "ADVISORY (unreported change): hooks/file-b.sh" \
  "$REPO3" "$SUMMARY3" "$BASE3" \
  "unreported change → exit 0 with ADVISORY"

# ---------------------------------------------------------------------------
# TC4: CLEAN — all claimed files match diff, no unreported → exit 0
# ---------------------------------------------------------------------------
echo ""
echo "-- Clean SUMMARY (exit 0) --"

REPO4="$TMP_DIR/repo4"
setup_diff_repo "$REPO4" "hooks/file-c.sh"
BASE4=$(git -C "$REPO4" rev-parse HEAD~1)

SUMMARY4="$TMP_DIR/summary4.md"
build_summary \
  "| \`hooks/file-c.sh\` | added | clean |" \
  "Added some content." \
  > "$SUMMARY4"

run_checker 0 "$REPO4" "$SUMMARY4" "$BASE4" \
  "clean SUMMARY → exit 0"

# ---------------------------------------------------------------------------
# TC5: MISSING SUMMARY FILE — fail-closed exit 2
# ---------------------------------------------------------------------------
echo ""
echo "-- Missing summary file (fail-closed, exit 2) --"

REPO5="$TMP_DIR/repo5"
setup_diff_repo "$REPO5" "hooks/any.sh"
BASE5=$(git -C "$REPO5" rev-parse HEAD~1)

run_checker_with_output 2 "CANON: summary-diff-check failed-closed" \
  "$REPO5" "/nonexistent/path/summary.md" "$BASE5" \
  "missing summary file → fail-closed exit 2"

# ---------------------------------------------------------------------------
# TC6: RENAMED SYMBOL DESCRIBED ACCURATELY — no false block
# The SUMMARY uses the NEW name in backticks; the diff contains the new name.
# This tests the mitigation: no false-block when the symbol is accurately described.
# ---------------------------------------------------------------------------
echo ""
echo "-- Renamed symbol described accurately (no false block) --"

REPO6="$TMP_DIR/repo6"
mkdir -p "$REPO6"
git -C "$REPO6" init -q
git -C "$REPO6" config user.email "test@example.com"
git -C "$REPO6" config user.name "Test User"
git -C "$REPO6" config commit.gpgsign false

# Base: file exists with old function
mkdir -p "$REPO6/hooks"
echo "export function oldName() { return 1; }" > "$REPO6/hooks/myfunc.sh"
git -C "$REPO6" add "$REPO6/hooks/myfunc.sh"
git -C "$REPO6" commit -q -m "base"

# HEAD: rename the function
echo "export function newName() { return 1; }" > "$REPO6/hooks/myfunc.sh"
git -C "$REPO6" add "$REPO6/hooks/myfunc.sh"
git -C "$REPO6" commit -q -m "rename"

BASE6=$(git -C "$REPO6" rev-parse HEAD~1)

SUMMARY6="$TMP_DIR/summary6.md"
build_summary \
  "| \`hooks/myfunc.sh\` | modified | rename |" \
  "Renamed \`oldName\` to \`newName\`." \
  > "$SUMMARY6"

# newName is in the diff (added line); oldName is also in the diff (removed line).
# The diff body contains both symbols, so neither should be a phantom.
run_checker 0 "$REPO6" "$SUMMARY6" "$BASE6" \
  "renamed symbol described accurately → no false block (exit 0)"

# ---------------------------------------------------------------------------
# TC7: MISSING BASE COMMIT ARG — fail-closed exit 2
# ---------------------------------------------------------------------------
echo ""
echo "-- Missing arguments (fail-closed, exit 2) --"

REPO7="$TMP_DIR/repo7"
setup_diff_repo "$REPO7" "hooks/any2.sh"
BASE7=$(git -C "$REPO7" rev-parse HEAD~1)

SUMMARY7="$TMP_DIR/summary7.md"
build_summary "| \`hooks/any2.sh\` | added | x |" "Added \`funcX\`." > "$SUMMARY7"

# No base_commit argument
actual_exit=0
(cd "$REPO7" && bash "$CHECKER" "$SUMMARY7") >/dev/null 2>&1 || actual_exit=$?
if [[ "$actual_exit" -eq 2 ]]; then
  echo "  PASS: missing base commit arg → fail-closed exit 2"
  PASS=$((PASS + 1))
else
  echo "  FAIL: missing base commit arg → expected exit 2, got $actual_exit"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
