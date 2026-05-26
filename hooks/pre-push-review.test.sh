#!/usr/bin/env bash
# Tests for pre-push-review.sh
# Run with: bash hooks/pre-push-review.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/pre-push-review.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

PASS=0
FAIL=0

TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

# ---------------------------------------------------------------------------
# Helper: check exit code
# ---------------------------------------------------------------------------
check_exit() {
  local description="$1"
  local expected_exit="$2"
  local dir="$3"
  local input_json="$4"

  local actual_exit=0
  (cd "$dir" && echo "$input_json" | bash "$HOOK" >/dev/null 2>&1) || actual_exit=$?

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------------------
# Helper: check output contains pattern
# ---------------------------------------------------------------------------
check_output_contains() {
  local description="$1"
  local pattern="$2"
  local dir="$3"
  local input_json="$4"

  local output
  local actual_exit=0
  output=$(cd "$dir" && echo "$input_json" | bash "$HOOK" 2>&1) || actual_exit=$?

  if echo "$output" | grep -q "$pattern"; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected output containing: $pattern"
    echo "        actual output: $output"
    FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------------------
# Helper: check output does NOT contain pattern (silent pass)
# ---------------------------------------------------------------------------
check_output_silent() {
  local description="$1"
  local dir="$2"
  local input_json="$3"

  local output
  local actual_exit=0
  output=$(cd "$dir" && echo "$input_json" | bash "$HOOK" 2>&1) || actual_exit=$?

  if [[ -z "$output" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description (expected silent, got: $output)"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "=== pre-push-review.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# Non-push commands: silent pass (exit 0)
# ---------------------------------------------------------------------------
echo "-- Non-push commands (should pass silently) --"

T_BASE="$TMPDIR_BASE/t_base"
setup_repo "$T_BASE"

check_output_silent "git commit does not trigger" "$T_BASE" '{"command":"git commit -m \"feat: x\""}'
check_output_silent "git status does not trigger" "$T_BASE" '{"command":"git status"}'
check_output_silent "npm test does not trigger"   "$T_BASE" '{"command":"npm test"}'
check_output_silent "empty command does not trigger" "$T_BASE" '{"command":""}'
check_output_silent "no command field does not trigger" "$T_BASE" '{"tool":"Bash","other":"value"}'

# ---------------------------------------------------------------------------
# git push with no reviews.jsonl: warns
# ---------------------------------------------------------------------------
echo ""
echo "-- Push with no reviews.jsonl (should warn) --"

T_NOREV="$TMPDIR_BASE/t_norev"
setup_repo "$T_NOREV"

check_output_contains "warns when no reviews.jsonl" "CANON WARNING" "$T_NOREV" '{"command":"git push origin main"}'
check_exit "always exits 0 (advisory)" 0 "$T_NOREV" '{"command":"git push origin main"}'

# ---------------------------------------------------------------------------
# git push with reviews.jsonl present but no upstream
# (no upstream → counts all commits not reachable from remote → likely warns)
# ---------------------------------------------------------------------------
echo ""
echo "-- Push with reviews.jsonl present --"

T_REV="$TMPDIR_BASE/t_rev"
setup_repo "$T_REV"
mkdir -p "$T_REV/.canon"

# Write a reviews.jsonl with a recent timestamp
NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")
echo "{\"timestamp\":\"${NOW_ISO}\",\"verdict\":\"CLEAN\"}" > "$T_REV/.canon/reviews.jsonl"

# Add and commit a second file so there is at least 1 commit not on remote
echo "export const x = 1;" > "$T_REV/src/extra.ts"
git -C "$T_REV" add "$T_REV/src/extra.ts"
git -C "$T_REV" commit -q -m "feat: extra"

# With a recent review (timestamp >= commit time) and no upstream, the hook
# should exit 0 (advisory only — never blocks)
check_exit "always exits 0 with reviews.jsonl present" 0 "$T_REV" '{"command":"git push origin main"}'

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi

exit 0
