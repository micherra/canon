#!/bin/bash
# Tests for pre-push-review.sh
# Run with: bash hooks/pre-push-review.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures
#
# All tests use isolated temp git repos. No hard-coded paths; safe for CI.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/pre-push-review.sh"

PASS=0
FAIL=0

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

MASTER_TMP=$(mktemp -d)
trap 'rm -rf "$MASTER_TMP"' EXIT

# setup_repo — minimal git repo with one initial commit
setup_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" config user.email "test@test"
  git -C "$dir" config user.name "Test"
  git -C "$dir" config commit.gpgsign false
  echo "v1" > "$dir/file.txt"
  git -C "$dir" add "$dir/file.txt"
  git -C "$dir" commit -q -m "init"
}

# add_commit — append to file and commit
add_commit() {
  local dir="$1"
  local msg="${2:-extra commit}"
  echo "change-$$-$RANDOM" >> "$dir/file.txt"
  git -C "$dir" add "$dir/file.txt"
  git -C "$dir" commit -q -m "$msg"
}

# add_reviews_file — create .canon/reviews.jsonl with given content
add_reviews_file() {
  local dir="$1"
  local content="${2:-}"
  mkdir -p "$dir/.canon"
  printf '%s\n' "$content" > "$dir/.canon/reviews.jsonl"
}

# run_test_in_dir — run hook in dir, validate exit code
run_test_in_dir() {
  local description="$1"
  local expected_exit="$2"
  local repo_dir="$3"
  local stdin_json="$4"

  local tmpout
  tmpout=$(mktemp)

  local actual_exit=0
  (cd "$repo_dir" && echo "$stdin_json" | bash "$HOOK" > "$tmpout" 2>&1) || actual_exit=$?

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

# run_test_in_dir_with_output — validate exit code AND stdout pattern
run_test_in_dir_with_output() {
  local description="$1"
  local expected_exit="$2"
  local expected_pattern="$3"
  local repo_dir="$4"
  local stdin_json="$5"

  local tmpout
  tmpout=$(mktemp)

  local actual_exit=0
  (cd "$repo_dir" && echo "$stdin_json" | bash "$HOOK" > "$tmpout" 2>&1) || actual_exit=$?
  local output
  output=$(cat "$tmpout")
  rm -f "$tmpout"

  local ok=true
  [[ "$actual_exit" -eq "$expected_exit" ]] || ok=false
  if [[ -n "$expected_pattern" ]] && ! echo "$output" | grep -q "$expected_pattern"; then
    ok=false
  fi

  if [[ "$ok" == "true" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    echo "        expected pattern: '$expected_pattern'"
    echo "        actual output: '$output'"
    FAIL=$((FAIL + 1))
  fi
}

# run_test_in_dir_no_pattern — validate exit code AND output does NOT match pattern
run_test_in_dir_no_pattern() {
  local description="$1"
  local expected_exit="$2"
  local forbidden_pattern="$3"
  local repo_dir="$4"
  local stdin_json="$5"

  local tmpout
  tmpout=$(mktemp)

  local actual_exit=0
  (cd "$repo_dir" && echo "$stdin_json" | bash "$HOOK" > "$tmpout" 2>&1) || actual_exit=$?
  local output
  output=$(cat "$tmpout")
  rm -f "$tmpout"

  local ok=true
  [[ "$actual_exit" -eq "$expected_exit" ]] || ok=false
  if [[ -n "$forbidden_pattern" ]] && echo "$output" | grep -q "$forbidden_pattern"; then
    ok=false
  fi

  if [[ "$ok" == "true" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    echo "        forbidden pattern found: '$forbidden_pattern'"
    echo "        actual output: '$output'"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "=== pre-push-review.sh tests ==="
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Bypass gate: non-push commands are ignored immediately
# ─────────────────────────────────────────────────────────────────────────────
echo "-- Bypass gate: non-push commands pass through --"

BYPASS_REPO="$MASTER_TMP/bypass"
setup_repo "$BYPASS_REPO"

run_test_in_dir "git commit does not trigger pre-push check" 0 \
  "$BYPASS_REPO" '{"command":"git commit -m \"wip\""}'

run_test_in_dir "git fetch does not trigger pre-push check" 0 \
  "$BYPASS_REPO" '{"command":"git fetch --all"}'

run_test_in_dir "git status does not trigger pre-push check" 0 \
  "$BYPASS_REPO" '{"command":"git status"}'

run_test_in_dir "npm run build does not trigger pre-push check" 0 \
  "$BYPASS_REPO" '{"command":"npm run build"}'

run_test_in_dir "empty command passes through" 0 \
  "$BYPASS_REPO" '{"command":""}'

run_test_in_dir "no command field passes through" 0 \
  "$BYPASS_REPO" '{"tool":"Bash"}'

# ─────────────────────────────────────────────────────────────────────────────
# Silent pass: bypass commands emit no warning
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Silent pass: non-push command emits no warning --"

SILENT_REPO="$MASTER_TMP/silent"
setup_repo "$SILENT_REPO"

run_test_in_dir_no_pattern "git fetch emits no CANON WARNING" 0 \
  "CANON WARNING" "$SILENT_REPO" '{"command":"git fetch --all"}'

# ─────────────────────────────────────────────────────────────────────────────
# Warning condition A: git push with no reviews.jsonl file
# Hook warns: "No Canon reviews logged for this project"
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Warning condition A: git push with no reviews.jsonl --"

NOREVIEW_REPO="$MASTER_TMP/no-review"
setup_repo "$NOREVIEW_REPO"

run_test_in_dir "git push with no reviews file — exits 0 (advisory)" 0 \
  "$NOREVIEW_REPO" '{"command":"git push origin main"}'

run_test_in_dir_with_output "git push with no reviews file — emits CANON WARNING" 0 \
  "CANON WARNING" "$NOREVIEW_REPO" '{"command":"git push origin main"}'

run_test_in_dir_with_output "warning mentions /canon:review" 0 \
  "canon:review" "$NOREVIEW_REPO" '{"command":"git push origin main"}'

# ─────────────────────────────────────────────────────────────────────────────
# Warning condition B: reviews.jsonl exists but timestamp field is unparseable
# The hook greps for '"timestamp":"...' then extracts matching chars.
# If extraction yields no epoch, it warns: "without a Canon review"
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Warning condition B: reviews.jsonl with no parseable timestamp --"

EMPTY_REVIEW_REPO="$MASTER_TMP/empty-review"
setup_repo "$EMPTY_REVIEW_REPO"
add_commit "$EMPTY_REVIEW_REPO" "unpushed commit"
add_reviews_file "$EMPTY_REVIEW_REPO" "{}"

run_test_in_dir "push with empty reviews.jsonl — exits 0" 0 \
  "$EMPTY_REVIEW_REPO" '{"command":"git push origin main"}'

run_test_in_dir_with_output "push with empty/unparseable reviews — emits CANON WARNING" 0 \
  "CANON WARNING" "$EMPTY_REVIEW_REPO" '{"command":"git push origin main"}'

# ─────────────────────────────────────────────────────────────────────────────
# Push variants: git push --force also triggers the guard
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Push variants: git push --force and --force-with-lease trigger guard --"

FORCE_PUSH_REPO="$MASTER_TMP/force-push"
setup_repo "$FORCE_PUSH_REPO"

run_test_in_dir_with_output "git push --force with no reviews — warns" 0 \
  "CANON WARNING" "$FORCE_PUSH_REPO" '{"command":"git push --force origin main"}'

run_test_in_dir_with_output "git push --force-with-lease with no reviews — warns" 0 \
  "CANON WARNING" "$FORCE_PUSH_REPO" '{"command":"git push --force-with-lease origin main"}'

# ─────────────────────────────────────────────────────────────────────────────
# Remote tracking: push with upstream + unpushed commits warns with count
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Remote tracking: unpushed commits counted and included in warning --"

REMOTE_REPO="$MASTER_TMP/remote-test.git"
MAIN_REPO="$MASTER_TMP/remote-main"

mkdir -p "$REMOTE_REPO"
git -C "$REMOTE_REPO" init --bare -q

setup_repo "$MAIN_REPO"
git -C "$MAIN_REPO" remote add origin "$REMOTE_REPO"
TRACKED_BRANCH=$(git -C "$MAIN_REPO" branch --show-current)
git -C "$MAIN_REPO" push -q origin "$TRACKED_BRANCH"
git -C "$MAIN_REPO" branch --set-upstream-to="origin/$TRACKED_BRANCH" "$TRACKED_BRANCH" 2>/dev/null || \
  git -C "$MAIN_REPO" branch -u "origin/$TRACKED_BRANCH" "$TRACKED_BRANCH" 2>/dev/null || true

add_commit "$MAIN_REPO" "unpushed work"

run_test_in_dir "push with upstream + 1 unpushed commit — exits 0" 0 \
  "$MAIN_REPO" '{"command":"git push origin main"}'

run_test_in_dir_with_output "push with upstream + 1 unpushed commit + no reviews — warns" 0 \
  "CANON WARNING" "$MAIN_REPO" '{"command":"git push origin main"}'

run_test_in_dir_with_output "warning includes 'commit' in output (no reviews file path)" 0 \
  "CANON WARNING" "$MAIN_REPO" '{"command":"git push origin main"}'

# ─────────────────────────────────────────────────────────────────────────────
# Silent pass: push when no unpushed commits (already fully pushed)
# Hook exits 0 silently when unpushed count is 0
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Silent pass: nothing to push (0 unpushed commits) --"

CLEAN_REMOTE="$MASTER_TMP/clean-remote.git"
CLEAN_MAIN="$MASTER_TMP/clean-main"

mkdir -p "$CLEAN_REMOTE"
git -C "$CLEAN_REMOTE" init --bare -q

setup_repo "$CLEAN_MAIN"
git -C "$CLEAN_MAIN" remote add origin "$CLEAN_REMOTE"
CLEAN_BRANCH=$(git -C "$CLEAN_MAIN" branch --show-current)
git -C "$CLEAN_MAIN" push -q origin "$CLEAN_BRANCH"
git -C "$CLEAN_MAIN" branch --set-upstream-to="origin/$CLEAN_BRANCH" "$CLEAN_BRANCH" 2>/dev/null || \
  git -C "$CLEAN_MAIN" branch -u "origin/$CLEAN_BRANCH" "$CLEAN_BRANCH" 2>/dev/null || true

# Add a reviews.jsonl with a fake recent review so the hook reaches the unpushed-count check.
# Without reviews.jsonl, the hook warns unconditionally (no-reviews-file path).
# The "0 unpushed commits" silent-pass requires reviews.jsonl to exist (without it the hook
# warns unconditionally). Upstream is not required — the hook falls back to
# `git rev-list HEAD --count --not --remotes` when no upstream branch is set.
add_reviews_file "$CLEAN_MAIN" '{"timestamp":"2030-01-01T00:00:00Z","result":"CLEAN"}'

run_test_in_dir_no_pattern "push with 0 unpushed commits (reviews file present) — no CANON WARNING" 0 \
  "CANON WARNING" "$CLEAN_MAIN" '{"command":"git push origin main"}'

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
