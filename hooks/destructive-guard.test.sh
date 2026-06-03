#!/bin/bash
# Tests for destructive-guard.sh
# Run with: bash hooks/destructive-guard.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/destructive-guard.sh"
GUARD="$HOOK"  # keep alias for clarity in test descriptions

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

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
run_test "git commit passes"                          0 '{"command":"git commit -m fix-thing"}'
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
# Fail-closed: jq unavailable — destructive command still BLOCKED (exit 2)
# Shadow jq with a stub that returns 127 so the hook must fall back to
# grep/sed extraction (via canon_extract_command) and still block.
# -----------------------------------------------------------------------
echo ""
echo "-- Fail-closed: jq absent — destructive command still blocked (exit 2) --"

run_test_no_jq() {
  local description="$1"
  local expected_exit="$2"
  local command_json="$3"
  local custom_pwd="${4:-/home/user/project}"

  local actual_exit=0
  # Create a temp dir with a fake jq that exits 127 (not found)
  local fake_bin
  fake_bin=$(mktemp -d)
  printf '#!/bin/bash\nexit 127\n' > "$fake_bin/jq"
  chmod +x "$fake_bin/jq"
  # Run the hook with the fake jq at the front of PATH
  echo "$command_json" | CANON_GUARD_CWD="$custom_pwd" PATH="$fake_bin:$PATH" bash "$GUARD" >/dev/null 2>&1 || actual_exit=$?
  rm -rf "$fake_bin"

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

run_test_no_jq "jq absent: git reset --hard still blocks (exit 2)" \
  2 "$(make_input 'git reset --hard')" "$NON_WT_PWD"

run_test_no_jq "jq absent: nested git reset --hard still blocks (exit 2)" \
  2 "$(make_nested_input 'git reset --hard HEAD')" "$NON_WT_PWD"

run_test_no_jq "jq absent: git clean -f still blocks (exit 2)" \
  2 "$(make_input 'git clean -f')" "$NON_WT_PWD"

run_test_no_jq "jq absent: git branch -D feature/x still blocks (exit 2)" \
  2 "$(make_input 'git branch -D feature/x')" "$NON_WT_PWD"

# Fail-closed: payload with no "command" key — should pass (exit 0), not block
echo ""
echo "-- Fail-closed: no command field in payload — pass (exit 0) --"

run_test_no_jq "jq absent: payload without command field passes (exit 0)" \
  0 '{"tool":"Write","tool_input":{"file_path":"/tmp/foo.txt","content":"hello"}}' "$NON_WT_PWD"

run_test "payload without command field passes (exit 0)" \
  0 '{"tool":"Write","tool_input":{"file_path":"/tmp/foo.txt","content":"hello"}}' "$NON_WT_PWD"

# -----------------------------------------------------------------------
# Fail-closed: truly absent jq (grep/sed fallback) + escaped-quote payload
#
# SECURITY: The run_test_no_jq helper prepends a fake jq that exits 127 to
# PATH — this makes command -v jq SUCCEED, so the jq branch runs (and
# returns empty on failure → fail-closed via normal path). That does NOT
# exercise the grep/sed fallback.
#
# These tests build a temp bin dir with symlinks to grep/sed/git/bash/etc.
# but NOT jq, so that command -v jq returns non-zero and the grep/sed
# branch of canon_extract_command runs.  They assert that an escaped-quote
# command value does NOT bypass the guard: must block (exit 2).
# -----------------------------------------------------------------------
echo ""
echo "-- Fail-closed: truly absent jq (grep/sed fallback) + escaped-quote payload --"

# Build a minimal PATH: symlinks to needed tools, excluding jq.
# Use /usr/bin/which to get the real binary path (not a shell function wrapper).
_DG_TMPBIN=$(mktemp -d)
for _tool in grep sed awk head bash git printf tr cat echo dirname basename; do
  _tp=$(/usr/bin/which "$_tool" 2>/dev/null || true)
  if [[ -n "$_tp" ]]; then
    ln -sf "$_tp" "$_DG_TMPBIN/$_tool" 2>/dev/null || true
  fi
done

run_test_truly_no_jq() {
  local description="$1"
  local expected_exit="$2"
  local command_json="$3"
  local custom_pwd="${4:-/home/user/project}"

  local actual_exit=0
  echo "$command_json" | CANON_GUARD_CWD="$custom_pwd" PATH="$_DG_TMPBIN" bash "$GUARD" >/dev/null 2>&1 || actual_exit=$?

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

# Escaped-quote prefix — the canonical bypass payload identified in the security assessment.
# The command value starts with \" which the grep/sed fallback mis-parses as lone backslash.
# Must block (exit 2).
run_test_truly_no_jq \
  "truly-absent-jq: escaped-quote destructive payload blocks (exit 2)" \
  2 \
  '{"tool_input":{"command":"\"git checkout -- ."}}' \
  "$NON_WT_PWD"

run_test_truly_no_jq \
  "truly-absent-jq: escaped-quote nested reset --hard blocks (exit 2)" \
  2 \
  '{"tool_input":{"command":"\"git clean -fd"}}' \
  "$NON_WT_PWD"

# Control: a plain (no backslash) destructive command with truly absent jq still blocks.
run_test_truly_no_jq \
  "truly-absent-jq: plain destructive command still blocks (exit 2)" \
  2 \
  '{"command":"git clean -f"}' \
  "$NON_WT_PWD"

# Control: a genuine no-command payload (truly absent jq) still passes (no over-block).
run_test_truly_no_jq \
  "truly-absent-jq: no command field still passes (exit 0)" \
  0 \
  '{"tool":"Write","tool_input":{"file_path":"/tmp/x.txt","content":"ok"}}' \
  "$NON_WT_PWD"

rm -rf "$_DG_TMPBIN"

# -----------------------------------------------------------------------
# False-positive regression: branch/ref/path NAME contains a trigger word
# (clean/reset/checkout) or ends in -…f. These are push/fetch/pull/log/merge
# operations — the trigger word is an ARGUMENT, not the subcommand.
# Must ALLOW (exit 0).  (PRD AC-1)
# -----------------------------------------------------------------------
echo ""
echo "-- False-positive regression: trigger word in branch/ref/path name (should pass, exit 0) --"

run_test "push branch HEAD:canon/...clean-profile... passes (session repro)" \
  0 "$(make_input 'git push origin HEAD:canon/fix-canon-mcp-boot-for-clean-profile-installs-x')" "$NON_WT_PWD"

run_test "fetch canon/fix-clean-profile-installs-x passes" \
  0 "$(make_input 'git fetch origin canon/fix-clean-profile-installs-x')" "$NON_WT_PWD"

run_test "pull canon/some-reset-hard-branch passes" \
  0 "$(make_input 'git pull origin canon/some-reset-hard-branch')" "$NON_WT_PWD"

run_test "log --oneline canon/checkout-rework passes" \
  0 "$(make_input 'git log --oneline canon/checkout-rework')" "$NON_WT_PWD"

run_test "merge canon/feature-cleanup-f passes (ends in -...f)" \
  0 "$(make_input 'git merge canon/feature-cleanup-f')" "$NON_WT_PWD"

run_test "push feature/reset-defaults passes" \
  0 "$(make_input 'git push origin feature/reset-defaults')" "$NON_WT_PWD"

run_test "branch -d canon/clean-profile-x passes (safe lowercase delete, name has clean)" \
  0 "$(make_input 'git branch -d canon/clean-profile-x')" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# True-positive: real destructive ops behind self-contained git GLOBAL
# options. The prototype canon_is_git_cmd fails-OPEN on these (it assumes
# every -flag consumes the next token, skipping the real subcommand).
# Must BLOCK (exit 2).  (PRD AC-2/3/4 — closes the fail-open gap)
# -----------------------------------------------------------------------
echo ""
echo "-- True-positive: real destructive ops behind self-contained globals (should block, exit 2) --"

run_test "git -p clean -fd blocks (self-contained -p global)" \
  2 "$(make_input 'git -p clean -fd')" "$NON_WT_PWD"

run_test "git --no-pager clean -f blocks (self-contained global)" \
  2 "$(make_input 'git --no-pager clean -f')" "$NON_WT_PWD"

run_test "git --git-dir=/x reset --hard blocks (=-form global)" \
  2 "$(make_input 'git --git-dir=/x reset --hard')" "$NON_WT_PWD"

run_test "git -c core.pager=cat clean -fd blocks (=-form -c value)" \
  2 "$(make_input 'git -c core.pager=cat clean -fd')" "$NON_WT_PWD"

run_test "git clean --force blocks (long flag form)" \
  2 "$(make_input 'git clean --force')" "$NON_WT_PWD"

run_test "git checkout -- src/app.ts blocks (path form, not '.')" \
  2 "$(make_input 'git checkout -- src/app.ts')" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# Compound commands: segment on && || ; | and block if ANY segment is a
# real destructive op (decision -02). A scary branch name in a
# non-destructive segment must NOT trip the guard.
# -----------------------------------------------------------------------
echo ""
echo "-- Compound commands (segmentation, decision -02) --"

run_test "compound: git status && git clean -fd blocks" \
  2 "$(make_input 'git status && git clean -fd')" "$NON_WT_PWD"

run_test "compound: echo canon/clean-profile && git push origin canon/clean-profile passes" \
  0 "$(make_input 'echo canon/clean-profile && git push origin canon/clean-profile')" "$NON_WT_PWD"

run_test "compound: git fetch origin canon/clean-x ; git log passes" \
  0 "$(make_input 'git fetch origin canon/clean-x ; git log')" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# Parse-ambiguity fail-closed: a segment contains a 'git' token but no
# subcommand can be resolved (e.g. git followed only by an unterminated
# value-consuming global option). Must BLOCK (exit 2).  (PRD AC-7)
# -----------------------------------------------------------------------
echo ""
echo "-- Parse-ambiguity fail-closed (should block, exit 2) --"

run_test "parse-ambiguity: git -C with no subcommand blocks" \
  2 "$(make_input 'git -C /some/dir')" "$NON_WT_PWD"

run_test "parse-ambiguity: bare git with only a value-consuming global blocks" \
  2 "$(make_input 'git --git-dir /x')" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# Bypass 1 regression: a quote character between the whitespace boundary and
# the trigger flag (git reset "--hard", git clean "-f") must NOT defeat the
# flag boundary. These are genuine destructive ops once the shell strips the
# quotes. Must BLOCK (exit 2). (review fix iteration 1)
# -----------------------------------------------------------------------
echo ""
echo "-- Bypass 1: quoted trigger flag (should block, exit 2) --"

run_test "git reset \"--hard\" blocks (double-quoted flag)" \
  2 '{"command":"git reset \"--hard\""}' "$NON_WT_PWD"

run_test "git reset \"--hard\" HEAD blocks" \
  2 '{"command":"git reset \"--hard\" HEAD"}' "$NON_WT_PWD"

run_test "git clean \"-f\" blocks (double-quoted flag)" \
  2 '{"command":"git clean \"-f\""}' "$NON_WT_PWD"

run_test "git clean '-f' blocks (single-quoted flag)" \
  2 "$(make_input "git clean '-f'")" "$NON_WT_PWD"

run_test "git \"clean\" \"-f\" blocks (quoted subcommand and flag)" \
  2 '{"command":"git \"clean\" \"-f\""}' "$NON_WT_PWD"

run_test "git \"clean\" -f blocks (quoted subcommand)" \
  2 '{"command":"git \"clean\" -f"}' "$NON_WT_PWD"

run_test "git branch \"-D\" feature-x blocks (quoted -D, non-Canon)" \
  2 '{"command":"git branch \"-D\" feature-x"}' "$NON_WT_PWD"

# -----------------------------------------------------------------------
# Bypass 2 regression: greedy arg-extraction. When the subcommand word
# reappears as a later operand (a ref/pathspec literally named clean/reset/
# checkout), the greedy sed must not strip through the LAST occurrence and
# swallow the destructive flag. Must BLOCK (exit 2). (review fix iteration 1)
# -----------------------------------------------------------------------
echo ""
echo "-- Bypass 2: subcommand word as operand (should block, exit 2) --"

run_test "git clean -f clean blocks (operand named clean)" \
  2 "$(make_input 'git clean -f clean')" "$NON_WT_PWD"

run_test "git clean -fd -- clean blocks (pathspec named clean)" \
  2 "$(make_input 'git clean -fd -- clean')" "$NON_WT_PWD"

run_test "git reset --hard reset blocks (ref named reset)" \
  2 "$(make_input 'git reset --hard reset')" "$NON_WT_PWD"

run_test "git checkout -- checkout blocks (pathspec named checkout)" \
  2 "$(make_input 'git checkout -- checkout')" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# Bypass 3 regression: intra-token quotes. Bash quote-removal CONCATENATES
# quotes inside a token (it does not insert a space). Replacing quotes with
# spaces splits a token the guard sees but the shell runs joined, letting a
# destructive op slip past. The guard must DELETE quote chars (matching bash
# quote-removal) so -""f → -f, --ha""rd → --hard, cl""ean → clean.
# Each form is a genuine destructive op once the shell strips the quotes and
# must BLOCK (exit 2). (review fix iteration 2)
# -----------------------------------------------------------------------
echo ""
echo "-- Bypass 3: intra-token quotes (should block, exit 2) --"

run_test "git clean -\"\"f blocks (intra-token double quotes in flag)" \
  2 '{"command":"git clean -\"\"f"}' "$NON_WT_PWD"

run_test "git clean '-''f' blocks (intra-token single quotes in flag)" \
  2 "$(make_input "git clean '-''f'")" "$NON_WT_PWD"

run_test "git reset --ha\"\"rd blocks (intra-token double quotes in flag)" \
  2 '{"command":"git reset --ha\"\"rd"}' "$NON_WT_PWD"

run_test "git reset --h\"\"ard HEAD blocks (intra-token quotes + operand)" \
  2 '{"command":"git reset --h\"\"ard HEAD"}' "$NON_WT_PWD"

run_test "git cl\"\"ean -f blocks (intra-token quotes in subcommand)" \
  2 '{"command":"git cl\"\"ean -f"}' "$NON_WT_PWD"

run_test "git checkout -\"\"- . blocks (intra-token quotes in pathspec sep)" \
  2 '{"command":"git checkout -\"\"- ."}' "$NON_WT_PWD"

run_test "git branch -\"\"D feature-x blocks (intra-token quotes, non-Canon)" \
  2 '{"command":"git branch -\"\"D feature-x"}' "$NON_WT_PWD"

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
