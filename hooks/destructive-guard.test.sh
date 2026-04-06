#!/bin/bash
# Tests for destructive-guard.sh
# Run with: bash hooks/destructive-guard.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$SCRIPT_DIR/destructive-guard.sh"

PASS=0
FAIL=0

run_test() {
  local description="$1"
  local expected_exit="$2"
  local command_json="$3"

  local actual_exit=0
  echo "$command_json" | bash "$GUARD" >/dev/null 2>&1 || actual_exit=$?

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

make_input() {
  local cmd="$1"
  printf '{"command":"%s"}' "$cmd"
}

echo ""
echo "=== destructive-guard.sh tests ==="
echo ""

# -----------------------------------------------------------------------
# Baseline: non-destructive commands pass through (exit 0)
# -----------------------------------------------------------------------
echo "-- Non-destructive commands (should pass) --"
run_test "git status passes"                          0 "$(make_input 'git status')"
run_test "git log passes"                             0 "$(make_input 'git log --oneline -5')"
run_test "git commit passes"                          0 "$(make_input 'git commit -m "fix: thing"')"
run_test "git push passes"                            0 "$(make_input 'git push origin main')"
run_test "git fetch passes"                           0 "$(make_input 'git fetch --all')"
run_test "git branch -d passes (safe delete)"         0 "$(make_input 'git branch -d feature/my-branch')"
run_test "git worktree remove passes"                 0 "$(make_input 'git worktree remove --force /tmp/some-path')"
run_test "empty command passes"                       0 '{"command":""}'
run_test "non-git command passes"                     0 "$(make_input 'npm test')"
run_test "no command field passes"                    0 '{"tool":"Bash","other":"value"}'

# -----------------------------------------------------------------------
# Destructive commands: blocked (exit 2)
# -----------------------------------------------------------------------
echo ""
echo "-- Destructive commands (should block, exit 2) --"
run_test "git reset --hard blocks"                    2 "$(make_input 'git reset --hard')"
run_test "git reset --hard HEAD blocks"               2 "$(make_input 'git reset --hard HEAD')"
run_test "git reset --hard HEAD~3 blocks"             2 "$(make_input 'git reset --hard HEAD~3')"
run_test "git clean -f blocks"                        2 "$(make_input 'git clean -f')"
run_test "git clean -fd blocks"                       2 "$(make_input 'git clean -fd')"
run_test "git clean -fx blocks"                       2 "$(make_input 'git clean -fx')"
run_test "git checkout -- . blocks"                   2 "$(make_input 'git checkout -- .')"
run_test "git branch -D blocks (non-Canon branch)"    2 "$(make_input 'git branch -D feature/my-work')"
run_test "git branch -D main blocks"                  2 "$(make_input 'git branch -D main')"

# -----------------------------------------------------------------------
# Canon-managed exceptions: should pass (exit 0)
# -----------------------------------------------------------------------
echo ""
echo "-- Canon-managed exceptions (should pass, exit 0) --"

# git branch -D for canon-session/* branches
run_test "git branch -D canon-session/main/slug-abc123 passes" \
  0 "$(make_input 'git branch -D canon-session/main/slug-abc123')"

run_test "git branch -D canon-session/feat/fix-it-a1b2c3 passes" \
  0 "$(make_input 'git branch -D canon-session/feat/fix-it-a1b2c3')"

run_test "git branch -D canon-session/any-base/any-slug passes" \
  0 "$(make_input 'git branch -D canon-session/any-base/any-slug')"

# git reset --hard within .canon/worktrees/ (via -C flag)
run_test "git -C .canon/worktrees/slug reset --hard passes" \
  0 "$(make_input 'git -C .canon/worktrees/my-slug-abc reset --hard HEAD')"

run_test "git -C /abs/path/.canon/worktrees/slug reset --hard passes" \
  0 "$(make_input 'git -C /home/user/project/.canon/worktrees/my-slug reset --hard')"

# git clean -f within .canon/worktrees/ (via -C flag)
run_test "git -C .canon/worktrees/slug clean -f passes" \
  0 "$(make_input 'git -C .canon/worktrees/my-slug-abc clean -f')"

run_test "git -C /abs/path/.canon/worktrees/slug clean -f passes" \
  0 "$(make_input 'git -C /home/user/project/.canon/worktrees/slug clean -f')"

# git checkout -- . within .canon/worktrees/ (via -C flag)
run_test "git -C .canon/worktrees/slug checkout -- . passes" \
  0 "$(make_input 'git -C .canon/worktrees/my-slug checkout -- .')"

# -----------------------------------------------------------------------
# Precision: Canon exceptions must not over-extend the guard
# -----------------------------------------------------------------------
echo ""
echo "-- Precision: non-Canon branch -D still blocked --"

run_test "branch named 'canon-session-fork' still blocked (not matching prefix)" \
  2 "$(make_input 'git branch -D canon-session-fork')"

run_test "reset --hard with path that is not .canon/worktrees/ still blocked" \
  2 "$(make_input 'git -C /tmp/other-path reset --hard HEAD')"

run_test "clean -f with path that is not .canon/worktrees/ still blocked" \
  2 "$(make_input 'git -C /tmp/other-path clean -f')"

run_test "checkout -- . with path that is not .canon/worktrees/ still blocked" \
  2 "$(make_input 'git -C /tmp/other-path checkout -- .')"

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi

exit 0
