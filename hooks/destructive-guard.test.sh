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
  local custom_pwd="${4:-}"

  # Use custom_pwd if provided, otherwise a non-worktree default so tests
  # are deterministic regardless of where the harness runs.
  local cwd="${custom_pwd:-/home/user/project}"
  local actual_exit=0
  echo "$command_json" | CANON_GUARD_CWD="$cwd" bash "$GUARD" >/dev/null 2>&1 || actual_exit=$?

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

make_nested_input() {
  local cmd="$1"
  printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$cmd"
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
# All tests use a non-worktree PWD to avoid the worktree exception
# (the test harness itself may run inside a worktree).
# -----------------------------------------------------------------------
NON_WT_PWD="/home/user/project"
echo ""
echo "-- Destructive commands (should block, exit 2) --"
run_test "git reset --hard blocks"                    2 "$(make_input 'git reset --hard')" "$NON_WT_PWD"
run_test "git reset --hard HEAD blocks"               2 "$(make_input 'git reset --hard HEAD')" "$NON_WT_PWD"
run_test "git reset --hard HEAD~3 blocks"             2 "$(make_input 'git reset --hard HEAD~3')" "$NON_WT_PWD"
run_test "git clean -f blocks"                        2 "$(make_input 'git clean -f')" "$NON_WT_PWD"
run_test "git clean -fd blocks"                       2 "$(make_input 'git clean -fd')" "$NON_WT_PWD"
run_test "git clean -fx blocks"                       2 "$(make_input 'git clean -fx')" "$NON_WT_PWD"
run_test "git checkout -- . blocks"                   2 "$(make_input 'git checkout -- .')" "$NON_WT_PWD"
run_test "git branch -D blocks (non-Canon branch)"    2 "$(make_input 'git branch -D feature/my-work')" "$NON_WT_PWD"
run_test "git branch -D main blocks"                  2 "$(make_input 'git branch -D main')" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# Canon-managed exceptions: should pass (exit 0)
# -----------------------------------------------------------------------
echo ""
echo "-- Canon-managed exceptions (should pass, exit 0) --"

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

# .claude/worktrees/ (Claude Code managed worktrees, via -C flag)
run_test "git -C .claude/worktrees/slug reset --hard passes" \
  0 "$(make_input 'git -C .claude/worktrees/agent-abc123 reset --hard HEAD')"

run_test "git -C /abs/.claude/worktrees/slug clean -f passes" \
  0 "$(make_input 'git -C /home/user/project/.claude/worktrees/agent-abc clean -f')"

run_test "git -C .claude/worktrees/slug checkout -- . passes" \
  0 "$(make_input 'git -C .claude/worktrees/my-slug checkout -- .')"

echo ""
echo "-- Canon-managed exceptions: PWD inside worktree (should pass, exit 0) --"

# PWD inside .canon/worktrees/
run_test "reset --hard passes when PWD is inside .canon/worktrees/" \
  0 "$(make_input 'git reset --hard HEAD')" \
  "/home/user/project/.canon/worktrees/my-slug"

run_test "clean -fd passes when PWD is inside .canon/worktrees/" \
  0 "$(make_input 'git clean -fd')" \
  "/home/user/project/.canon/worktrees/my-slug/subdir"

# PWD inside .claude/worktrees/
run_test "reset --hard passes when PWD is inside .claude/worktrees/" \
  0 "$(make_input 'git reset --hard HEAD')" \
  "/home/user/project/.claude/worktrees/enrich-domain-primers"

run_test "clean -f passes when PWD is inside .claude/worktrees/" \
  0 "$(make_input 'git clean -f')" \
  "/home/user/project/.claude/worktrees/agent-abc/mcp-server"

run_test "checkout -- . passes when PWD is inside .claude/worktrees/" \
  0 "$(make_input 'git checkout -- .')" \
  "/home/user/project/.claude/worktrees/my-slug"

# -----------------------------------------------------------------------
# Precision: Canon exceptions must not over-extend the guard
# -----------------------------------------------------------------------
echo ""
echo "-- Canon branch -D exemption: Canon-prefixed branches allowed (exit 0) --"

run_test "git branch -D canon/some-slug passes" \
  0 "$(make_input 'git branch -D canon/some-slug')" "$NON_WT_PWD"

run_test "git branch -D canon-wave/task-01 passes" \
  0 "$(make_input 'git branch -D canon-wave/task-01')" "$NON_WT_PWD"

run_test "git branch -D canon-task/wave-1 passes" \
  0 "$(make_input 'git branch -D canon-task/wave-1')" "$NON_WT_PWD"

run_test "git branch -D multiple Canon branches passes" \
  0 "$(make_input 'git branch -D canon/a canon-wave/b canon-task/c')" "$NON_WT_PWD"

run_test "git branch -D quoted Canon branches passes" \
  0 '{"command":"git branch -D \"canon/some-slug\" \"canon/other-slug\""}' "$NON_WT_PWD"

run_test "git branch -D mixed quoted Canon prefixes passes" \
  0 '{"command":"git branch -D \"canon/a\" \"canon-wave/b\" \"canon-task/c\""}' "$NON_WT_PWD"

run_test "git branch -D quoted non-Canon branch blocks" \
  2 '{"command":"git branch -D \"feature/my-work\""}' "$NON_WT_PWD"

echo ""
echo "-- Canon branch -D exemption: non-Canon branches still blocked (exit 2) --"

run_test "git branch -D feature/my-work blocks" \
  2 "$(make_input 'git branch -D feature/my-work')" "$NON_WT_PWD"

run_test "git branch -D main blocks" \
  2 "$(make_input 'git branch -D main')" "$NON_WT_PWD"

run_test "git branch -D mixed canon and non-canon blocks" \
  2 "$(make_input 'git branch -D canon/a feature/b')" "$NON_WT_PWD"

echo ""
echo "-- Precision: non-Canon branch -D still blocked --"

run_test "reset --hard with path that is not .canon/worktrees/ still blocked" \
  2 "$(make_input 'git -C /tmp/other-path reset --hard HEAD')" "$NON_WT_PWD"

run_test "clean -f with path that is not .canon/worktrees/ still blocked" \
  2 "$(make_input 'git -C /tmp/other-path clean -f')" "$NON_WT_PWD"

run_test "checkout -- . with path that is not .canon/worktrees/ still blocked" \
  2 "$(make_input 'git -C /tmp/other-path checkout -- .')" "$NON_WT_PWD"

run_test "reset --hard with non-worktree PWD still blocked" \
  2 "$(make_input 'git reset --hard HEAD')" \
  "/home/user/project"

run_test "clean -f with non-worktree PWD still blocked" \
  2 "$(make_input 'git clean -f')" \
  "/home/user/project/src"

echo ""
echo "-- Precision: chained commands not exempted by worktree exception --"

run_test "chained: worktree path then clean -f blocks" \
  2 "$(make_input 'git -C .canon/worktrees/slug status && git clean -f')" "$NON_WT_PWD"

run_test "chained: worktree path then reset --hard blocks" \
  2 "$(make_input 'git -C .canon/worktrees/slug log && git reset --hard HEAD')" "$NON_WT_PWD"

run_test "semicolon-chained: worktree path then checkout blocks" \
  2 "$(make_input 'git -C .canon/worktrees/slug fetch; git checkout -- .')" "$NON_WT_PWD"

echo ""
echo "-- Nested tool_input format (real Claude Code payload) --"

run_test "nested: git reset --hard blocks" \
  2 "$(make_nested_input 'git reset --hard HEAD')" "$NON_WT_PWD"

run_test "nested: git clean -f blocks" \
  2 "$(make_nested_input 'git clean -f')" "$NON_WT_PWD"

run_test "nested: git status passes" \
  0 "$(make_nested_input 'git status')" "$NON_WT_PWD"

run_test "nested: git branch -D canon/slug passes" \
  0 "$(make_nested_input 'git branch -D canon/some-slug')" "$NON_WT_PWD"

run_test "nested: git branch -D feature/x blocks" \
  2 "$(make_nested_input 'git branch -D feature/x')" "$NON_WT_PWD"

run_test "nested: git -C .canon/worktrees/slug reset --hard passes" \
  0 "$(make_nested_input 'git -C .canon/worktrees/my-slug reset --hard HEAD')" "$NON_WT_PWD"

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
