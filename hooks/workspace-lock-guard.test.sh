#!/usr/bin/env bash
# Tests for workspace-lock-guard.sh
# Run with: bash hooks/workspace-lock-guard.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/workspace-lock-guard.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

PASS=0
FAIL=0

TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

# ---------------------------------------------------------------------------
# Helpers
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

check_silent() {
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

# ---------------------------------------------------------------------------
# Helper: write a workspace lock file
# write_lock <repo_dir> <branch> <session_id> [started_ts]
# ---------------------------------------------------------------------------
write_lock() {
  local repo_dir="$1"
  local branch="$2"
  local session_id="$3"
  local started_ts="${4:-$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date +"%Y-%m-%dT%H:%M:%SZ")}"

  local sanitized
  sanitized=$(echo "$branch" | tr '/' '--' | tr ' ' '-' | tr -cd 'a-zA-Z0-9-' | tr '[:upper:]' '[:lower:]' | cut -c1-80)
  local lock_dir="$repo_dir/.canon/workspaces/$sanitized"
  mkdir -p "$lock_dir"
  cat > "$lock_dir/.lock" <<JSON
{"session_id":"${session_id}","branch":"${branch}","started":"${started_ts}"}
JSON
}

echo ""
echo "=== workspace-lock-guard.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# Non-commit/merge commands: silent pass (exit 0)
# ---------------------------------------------------------------------------
echo "-- Non-commit/merge commands (should pass silently) --"

T_BASE="$TMPDIR_BASE/t_base"
setup_repo "$T_BASE"

check_silent "git status passes silently"  "$T_BASE" '{"command":"git status"}'
check_silent "git push passes silently"    "$T_BASE" '{"command":"git push origin main"}'
check_silent "npm test passes silently"    "$T_BASE" '{"command":"npm test"}'
check_silent "empty command passes silently" "$T_BASE" '{"command":""}'

# ---------------------------------------------------------------------------
# No lock file: commit/merge pass silently
# ---------------------------------------------------------------------------
echo ""
echo "-- No lock file (should pass silently) --"

T_NOLOCK="$TMPDIR_BASE/t_nolock"
setup_repo "$T_NOLOCK"

check_silent "git commit, no lock — silent" "$T_NOLOCK" '{"command":"git commit -m \"feat: x\""}'
check_silent "git merge, no lock — silent"  "$T_NOLOCK" '{"command":"git merge some-branch"}'

# ---------------------------------------------------------------------------
# Lock belongs to same session: silent pass
# ---------------------------------------------------------------------------
echo ""
echo "-- Lock belongs to same session (should pass silently) --"

T_SAMESESS="$TMPDIR_BASE/t_samesess"
setup_repo "$T_SAMESESS"
# Lock on main with session abc-123
BRANCH=$(git -C "$T_SAMESESS" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
write_lock "$T_SAMESESS" "$BRANCH" "session-abc-123"

check_silent "same session — no warning" "$T_SAMESESS" \
  '{"session_id":"session-abc-123","command":"git commit -m \"feat: x\""}'

# ---------------------------------------------------------------------------
# Lock belongs to different session: warns (but still exits 0)
# ---------------------------------------------------------------------------
echo ""
echo "-- Lock belongs to different session (should warn, exit 0) --"

T_DIFFSESS="$TMPDIR_BASE/t_diffsess"
setup_repo "$T_DIFFSESS"
BRANCH=$(git -C "$T_DIFFSESS" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
write_lock "$T_DIFFSESS" "$BRANCH" "session-other-456"

check_output_contains "warns on different session lock" "CANON WARNING" "$T_DIFFSESS" \
  '{"session_id":"session-me-789","command":"git commit -m \"feat: x\""}'

check_exit "always exits 0 (advisory)" 0 "$T_DIFFSESS" \
  '{"session_id":"session-me-789","command":"git commit -m \"feat: x\""}'

# ---------------------------------------------------------------------------
# Stale lock (>2 hours old): passes silently (lock ignored)
# ---------------------------------------------------------------------------
echo ""
echo "-- Stale lock (>2h old, should pass silently) --"

T_STALE="$TMPDIR_BASE/t_stale"
setup_repo "$T_STALE"
BRANCH=$(git -C "$T_STALE" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
# Write lock with a timestamp 3 hours ago
STALE_TS=$(date -u -v-3H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u --date="3 hours ago" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u +"%Y-%m-%dT%H:%M:%SZ")
write_lock "$T_STALE" "$BRANCH" "session-stale" "$STALE_TS"

check_silent "stale lock ignored — silent pass" "$T_STALE" \
  '{"session_id":"session-me-789","command":"git commit -m \"feat: x\""}'

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
