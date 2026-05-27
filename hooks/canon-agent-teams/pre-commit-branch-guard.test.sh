#!/usr/bin/env bash
# Tests for pre-commit-branch-guard.sh
# Run with: bash hooks/canon-agent-teams/pre-commit-branch-guard.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/pre-commit-branch-guard.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/../test-helpers.sh"

PASS=0
FAIL=0

TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

echo ""
echo "=== pre-commit-branch-guard.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# Non-commit commands: pass through silently (exit 0)
# ---------------------------------------------------------------------------
echo "-- Non-commit commands (should pass, exit 0) --"

T_BASE="$TMPDIR_BASE/t_base"
setup_repo "$T_BASE"

run_test_in_dir "git status passes"         0 "$HOOK" "$T_BASE" '{"command":"git status"}'
run_test_in_dir "git push passes"           0 "$HOOK" "$T_BASE" '{"command":"git push origin main"}'
run_test_in_dir "npm test passes"           0 "$HOOK" "$T_BASE" '{"command":"npm test"}'
run_test_in_dir "empty command passes"      0 "$HOOK" "$T_BASE" '{"command":""}'
run_test_in_dir "no command field passes"   0 "$HOOK" "$T_BASE" '{"tool":"Bash","other":"value"}'
run_test_in_dir "git merge passes"          0 "$HOOK" "$T_BASE" '{"command":"git merge other-branch"}'

# ---------------------------------------------------------------------------
# Commit on non-main branch: passes (exit 0)
# ---------------------------------------------------------------------------
echo ""
echo "-- Commit on non-main branches (should pass, exit 0) --"

T_FEAT="$TMPDIR_BASE/t_feat"
setup_repo "$T_FEAT"
git -C "$T_FEAT" checkout -q -b "feature/my-work"

run_test_in_dir "commit on feature branch passes" 0 "$HOOK" "$T_FEAT" '{"command":"git commit -m \"feat: x\""}'

T_CANON="$TMPDIR_BASE/t_canon"
setup_repo "$T_CANON"
git -C "$T_CANON" checkout -q -b "canon/my-slug"

run_test_in_dir "commit on canon/ branch passes" 0 "$HOOK" "$T_CANON" '{"command":"git commit -m \"feat: x\""}'

T_WAVE="$TMPDIR_BASE/t_wave"
setup_repo "$T_WAVE"
git -C "$T_WAVE" checkout -q -b "canon-wave/task-01"

run_test_in_dir "commit on canon-wave/ branch passes" 0 "$HOOK" "$T_WAVE" '{"command":"git commit -m \"wip: x\""}'

# ---------------------------------------------------------------------------
# Commit on main: BLOCKED (exit 2)
# ---------------------------------------------------------------------------
echo ""
echo "-- Commit on main/master (should block, exit 2) --"

T_MAIN="$TMPDIR_BASE/t_main"
setup_repo "$T_MAIN"
# setup_repo creates a repo whose default branch is "main" (or "master" on older git)
INIT_BRANCH=$(git -C "$T_MAIN" symbolic-ref --short HEAD 2>/dev/null || echo "main")

if [[ "$INIT_BRANCH" == "main" ]]; then
  run_test_in_dir "commit on main blocks" 2 "$HOOK" "$T_MAIN" '{"command":"git commit -m \"feat: x\""}'
else
  # Some git versions default to "master"
  echo "  SKIP: default branch is '$INIT_BRANCH' (not main)"
fi

T_MASTER="$TMPDIR_BASE/t_master"
setup_repo "$T_MASTER"
git -C "$T_MASTER" checkout -q -b "master" 2>/dev/null || true
MASTER_BRANCH=$(git -C "$T_MASTER" symbolic-ref --short HEAD 2>/dev/null || echo "")
if [[ "$MASTER_BRANCH" == "master" ]]; then
  run_test_in_dir "commit on master blocks" 2 "$HOOK" "$T_MASTER" '{"command":"git commit -m \"fix: x\""}'
else
  echo "  SKIP: could not switch to master branch"
fi

# ---------------------------------------------------------------------------
# Commit with cd prefix: resolves branch from cd target
# ---------------------------------------------------------------------------
echo ""
echo "-- Commit with cd prefix (branch from cd target) --"

T_WTTARGET="$TMPDIR_BASE/t_wttarget"
setup_repo "$T_WTTARGET"
git -C "$T_WTTARGET" checkout -q -b "canon/my-worktree"

run_test_in_dir "cd to canon-branch worktree passes" 0 "$HOOK" "$T_BASE" \
  "{\"command\":\"cd ${T_WTTARGET} && git commit -m \\\"feat: x\\\"\"}"

# ---------------------------------------------------------------------------
# Bypass gate: CANON_SKIP_BRANCH_GUARD
# (hook does not implement a bypass; this ensures it still blocks normally)
# ---------------------------------------------------------------------------
echo ""
echo "-- Block message content check --"

T_MSG="$TMPDIR_BASE/t_msg"
setup_repo "$T_MSG"
INIT_BRANCH=$(git -C "$T_MSG" symbolic-ref --short HEAD 2>/dev/null || echo "main")

if [[ "$INIT_BRANCH" == "main" ]]; then
  OUTPUT=$(cd "$T_MSG" && echo '{"command":"git commit -m \"feat: x\""}' | bash "$HOOK" 2>&1 || true)
  if echo "$OUTPUT" | grep -q "BLOCKED"; then
    echo "  PASS: block message contains BLOCKED"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: expected BLOCKED in message, got: $OUTPUT"
    FAIL=$((FAIL + 1))
  fi

  if echo "$OUTPUT" | grep -q "main"; then
    echo "  PASS: block message mentions main"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: expected 'main' in message, got: $OUTPUT"
    FAIL=$((FAIL + 1))
  fi
else
  echo "  SKIP: default branch is '$INIT_BRANCH' (not main)"
fi

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
