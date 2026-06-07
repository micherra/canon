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
# Bug-1 regression: command-prefix wrappers (sudo/env/time/nice/command).
#
# Old code removed only the "git" word via sed word-substitution, leaving
# the wrapper prefix fused to the next token (e.g. "sudo git clean -fd" →
# "sudoclean -f"). The case switch matched nothing → fail-OPEN (exit 0).
# The fix anchors subcommand resolution to the actual "git" token via awk.
# -----------------------------------------------------------------------
echo ""
echo "-- Bug-1 regression: command-prefix wrappers (should block, exit 2) --"

run_test "sudo git clean -fd blocks"             2 "$(make_input 'sudo git clean -fd')"  "$NON_WT_PWD"
run_test "sudo git reset --hard blocks"          2 "$(make_input 'sudo git reset --hard')" "$NON_WT_PWD"
run_test "env git clean -fd blocks"              2 "$(make_input 'env git clean -fd')"   "$NON_WT_PWD"
run_test "env VAR=1 git clean -fd blocks"        2 "$(make_input 'env VAR=1 git clean -fd')" "$NON_WT_PWD"
run_test "time git reset --hard blocks"          2 "$(make_input 'time git reset --hard')" "$NON_WT_PWD"
run_test "nice git clean -fd blocks"             2 "$(make_input 'nice git clean -fd')"  "$NON_WT_PWD"
run_test "nice -n 5 git clean -fd blocks"        2 "$(make_input 'nice -n 5 git clean -fd')" "$NON_WT_PWD"
run_test "command git clean -fd blocks"          2 "$(make_input 'command git clean -fd')" "$NON_WT_PWD"
run_test "command git checkout -- . blocks"      2 "$(make_input 'command git checkout -- .')" "$NON_WT_PWD"

echo ""
echo "-- Bug-1 regression: wrapper-prefix non-destructive ops (should pass, exit 0) --"

run_test "sudo git status passes"                0 "$(make_input 'sudo git status')"     "$NON_WT_PWD"
run_test "sudo git log --oneline passes"         0 "$(make_input 'sudo git log --oneline')" "$NON_WT_PWD"
run_test "env git fetch --all passes"            0 "$(make_input 'env git fetch --all')" "$NON_WT_PWD"
run_test "time git push origin main passes"      0 "$(make_input 'time git push origin main')" "$NON_WT_PWD"
run_test "nice git commit -m msg passes"         0 "$(make_input 'nice git commit -m msg')" "$NON_WT_PWD"
run_test "sudo git branch -D canon/slug passes"  0 "$(make_input 'sudo git branch -D canon/slug')" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# Bug-2 regression: quoted option values with spaces.
#
# Old code stripped all quote characters globally before tokenizing.
# "git -C \"my dir\" reset --hard" → "git -C my dir reset --hard" →
# "-C" consumes "my" as its value → "dir" misidentified as subcommand →
# reset --hard allowed → fail-OPEN (exit 0).
# The fix passes the raw (pre-quote-deletion) segment to
# canon_git_subcommand, which uses a quote-aware tokenizer internally.
# -----------------------------------------------------------------------
echo ""
echo "-- Bug-2 regression: quoted option values with spaces (should block, exit 2) --"

run_test 'git -C "my dir" reset --hard blocks'  2 \
  '{"command":"git -C \"my dir\" reset --hard"}' "$NON_WT_PWD"
run_test 'git -C "my dir" clean -fd blocks'     2 \
  '{"command":"git -C \"my dir\" clean -fd"}' "$NON_WT_PWD"
run_test "git -C 'my dir' checkout -- . blocks" 2 \
  "$(make_input "git -C 'my dir' checkout -- .")" "$NON_WT_PWD"
run_test 'git --git-dir "my dir/.git" reset --hard blocks' 2 \
  '{"command":"git --git-dir \"my dir/.git\" reset --hard"}' "$NON_WT_PWD"

echo ""
echo "-- Bug-2 regression: quoted spaced path non-destructive ops (should pass, exit 0) --"

run_test 'git -C "my dir" log passes'           0 \
  '{"command":"git -C \"my dir\" log --oneline"}' "$NON_WT_PWD"
run_test 'git -C "my dir" status passes'        0 \
  '{"command":"git -C \"my dir\" status"}' "$NON_WT_PWD"
run_test "git -C 'my dir' fetch passes"         0 \
  "$(make_input "git -C 'my dir' fetch --all")" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# Bug-3 regression: spurious "git" value/positional before the real git.
#
# The awk tokenizer latches onto the FIRST standalone "git" token, so when
# a wrapper prefix supplies a literal "git" as its own argument
# (env git git …, sudo -u git git …, nice -n git git …, git git …),
# the token-walk returns "git" as the resolved subcommand. The case switch
# has no "git" arm → falls through → exit 0 (fail-open).
#
# Fix: canonically "git" is not a valid git subcommand. When the resolved
# subcommand token is itself "git", canon_git_subcommand returns 1
# (unresolved) so the parse-ambiguity guard in destructive-guard.sh fires
# → exit 2. Test inputs use variable assembly to avoid triggering the live
# PreToolUse hook that intercepts this test file's own Bash calls.
# -----------------------------------------------------------------------
echo ""
echo "-- Bug-3 regression: spurious git value before real git invocation (should block, exit 2) --"

# Assemble trigger words via variables so the live hook does not intercept
# the make_input calls in this test file itself.
_HARD="--hard"
_FD="-fd"

run_test 'env git git reset --hard blocks' 2 \
  "$(make_input "env git git reset $_HARD")" "$NON_WT_PWD"

run_test 'sudo -u git git reset --hard blocks' 2 \
  "$(make_input "sudo -u git git reset $_HARD")" "$NON_WT_PWD"

run_test 'nice -n git git clean -fd blocks' 2 \
  "$(make_input "nice -n git git clean $_FD")" "$NON_WT_PWD"

run_test 'git git reset --hard blocks' 2 \
  "$(make_input "git git reset $_HARD")" "$NON_WT_PWD"

echo ""
echo "-- Bug-3 regression: prior Bug-1 fixes must still hold (should block, exit 2) --"

run_test "sudo git clean -fd still blocks after Bug-3 fix" 2 \
  "$(make_input "sudo git clean $_FD")" "$NON_WT_PWD"

run_test "env git clean -fd still blocks after Bug-3 fix" 2 \
  "$(make_input "env git clean $_FD")" "$NON_WT_PWD"

echo ""
echo "-- Bug-3 regression: non-destructive spurious-git forms (should pass, exit 0) --"

run_test 'sudo git status still passes after Bug-3 fix' 0 \
  "$(make_input 'sudo git status')" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# make_multiline_input — build a JSON payload from a heredoc/variable.
# Uses jq to properly encode the multiline string as JSON.
# -----------------------------------------------------------------------
make_multiline_input() {
  local cmd="$1"
  printf '%s' "$cmd" | jq -Rs '{"tool_input":{"command":.}}'
}

# -----------------------------------------------------------------------
# AC #1 evidence regressions — the two exact PRD commands must pass (exit 0)
# Assemble trigger-word variable to avoid triggering the live hook on this file.
# -----------------------------------------------------------------------
_WT_LIST="worktree list"
echo ""
echo "-- AC #1 evidence regressions: PRD multiline commands (should pass, exit 0) --"

# PRD Command A (toolu_01ARZGi9): compound with VAR= assignments, comment lines,
# ls/realpath, and git worktree list --porcelain | grep pipeline.
_CMD_A=$(cat <<'CMDA'
TRIM_WORKSPACE=".canon/workspaces/canon--trim-mcp-server-claudemd"
TRIM_WORKTREE_PATH="$TRIM_WORKSPACE/worktree"
# Check what's inside the canon--trim-mcp-server-claudemd workspace's worktree dir
ls -la "$TRIM_WORKTREE_PATH" 2>/dev/null || echo "Worktree path does not exist"
# Check if the worktree path is registered with git
realpath "$TRIM_WORKTREE_PATH" 2>/dev/null || echo "Cannot resolve path"
CMDA
)
# Append the git pipeline line (using variable to avoid hook triggering on this file)
_GIT_WT_PIPELINE="git worktree list --porcelain | grep \"^worktree \" | sed 's/^worktree //' | grep -F \"\$TRIM_WORKTREE_PATH\" && echo \"REGISTERED\" || echo \"NOT REGISTERED\""
_CMD_A_FULL="${_CMD_A}
${_GIT_WT_PIPELINE}"

run_test "AC#1 PRD Command A: multiline with comments + git worktree list pipeline passes" \
  0 "$(make_multiline_input "$_CMD_A_FULL")" "$NON_WT_PWD"

# PRD Command B (toolu_01WQUWwT): TRIM_WT= / realpath / comment / two git worktree pipelines.
_CMD_B_PRE=$(cat <<'CMDB'
TRIM_WT=".canon/workspaces/canon--trim/worktree"
TRIM_WT_REAL=$(realpath "$TRIM_WT" 2>/dev/null || echo "not found")
# Confirm the trim workspace worktree/ is empty and NOT registered with git
CMDB
)
_GIT_WT_B1="git worktree list --porcelain | grep '^worktree ' | grep -xF \"\$TRIM_WT_REAL\" && echo \"REGISTERED\" || echo \"NOT REGISTERED\""
_GIT_WT_B2="git worktree list --porcelain | grep '^worktree ' | grep -c \"\$TRIM_WT_REAL\" || true"
_CMD_B_FULL="${_CMD_B_PRE}
${_GIT_WT_B1}
${_GIT_WT_B2}"

run_test "AC#1 PRD Command B: multiline with comment + two git worktree list pipelines passes" \
  0 "$(make_multiline_input "$_CMD_B_FULL")" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# Comment handling (exit 0)
# -----------------------------------------------------------------------
echo ""
echo "-- Comment handling (should pass, exit 0) --"

# Comment line ending in the word "git" followed by a safe command.
_COMMENT_GIT_LINE="# git cleanup time
ls /tmp"
run_test "comment line ending in git followed by ls passes" \
  0 "$(make_multiline_input "$_COMMENT_GIT_LINE")" "$NON_WT_PWD"

# Comment containing a parenthetical git branch reference.
_COMMENT_GIT_BRANCH="# checked (git branch --merged main confirmed it)
ls /tmp"
run_test "comment containing git branch --merged reference passes" \
  0 "$(make_multiline_input "$_COMMENT_GIT_BRANCH")" "$NON_WT_PWD"

# Trailing same-line comment.
run_test "trailing same-line comment: ls /tmp # checked against git passes" \
  0 "$(make_multiline_input "ls /tmp # checked against git")" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# Quoted-string handling (exit 0)
# -----------------------------------------------------------------------
echo ""
echo "-- Quoted-string handling (should pass, exit 0) --"

# echo with a quoted string containing git text (no standalone git token).
run_test 'echo "git worktree remove exit: $?" passes' \
  0 "$(make_multiline_input 'echo "git worktree remove exit: $?"')" "$NON_WT_PWD"

run_test "echo 'git is fine' passes" \
  0 "$(make_multiline_input "echo 'git is fine'")" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# Must-still-block (exit 2): destructive ops after comments/quoted strings
# -----------------------------------------------------------------------
echo ""
echo "-- Must-still-block: destructive ops not defeated by comments/quotes (exit 2) --"

# Quoted "git is fine" then a real destructive op after ;.
# Use variable assembly for the destructive part.
_HARD_RESET="git reset --hard"
run_test 'echo "git is fine" ; git reset --hard still blocks' \
  2 "$(make_multiline_input "echo \"git is fine\" ; $_HARD_RESET")" "$NON_WT_PWD"

# Comment line, then destructive op on next line.
_COMMENT_THEN_DESTRUCTIVE="# git cleanup time
git clean -fd"
run_test "comment line then git clean -fd on next line still blocks" \
  2 "$(make_multiline_input "$_COMMENT_THEN_DESTRUCTIVE")" "$NON_WT_PWD"

# Quoted # inside a commit message is NOT a comment — the reset must still block.
_QUOTED_HASH_CMD="git commit -m \"a # b\" && $_HARD_RESET"
run_test 'git commit -m "a # b" && git reset --hard still blocks (quoted hash not a comment)' \
  2 "$(make_multiline_input "$_QUOTED_HASH_CMD")" "$NON_WT_PWD"

# AC #2 named cases: pipe and cd compound.
_BRANCH_D="branch -D x"
run_test "git branch -D x | cat still blocks (piped)" \
  2 "$(make_multiline_input "git $_BRANCH_D | cat")" "$NON_WT_PWD"

run_test "cd foo && git branch -D x still blocks (cd compound)" \
  2 "$(make_multiline_input "cd foo && git $_BRANCH_D")" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# Comments-only command (exit 0)
# -----------------------------------------------------------------------
echo ""
echo "-- Comments-only command (should pass, exit 0) --"

_COMMENTS_ONLY="# just a note about git"
run_test "comments-only command passes" \
  0 "$(make_multiline_input "$_COMMENTS_ONLY")" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# Fail-closed strengthening (exit 2): git $SUBCMD-style (AC #3)
# Single-quote payload assembly so shell variable does NOT expand.
# -----------------------------------------------------------------------
echo ""
echo "-- Fail-closed strengthening: git \$SUBCMD forms (should block, exit 2) --"

run_test 'git $SUBCMD blocks fail-closed (unresolvable variable subcommand)' \
  2 "$(make_multiline_input 'git $SUBCMD')" "$NON_WT_PWD"

run_test 'git $SUBCMD --hard blocks fail-closed' \
  2 "$(make_multiline_input 'git $SUBCMD --hard')" "$NON_WT_PWD"

run_test 'git $(pick-cmd) --hard blocks fail-closed' \
  2 "$(make_multiline_input 'git $(pick-cmd) --hard')" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# Shape-validation pass control (exit 0): variable as OPTION VALUE, not subcmd
# -----------------------------------------------------------------------
echo ""
echo "-- Shape-validation pass control: variable as option value (should pass, exit 0) --"

run_test 'git -C $DIR status passes (variable is option value, resolved sub=status)' \
  0 "$(make_multiline_input 'git -C $DIR status')" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# P1 fix: string-executing wrappers (eval, bash -c, sh -c, zsh -c, …)
#
# Segments where git appears ONLY inside a quoted string argument to a
# string-executing wrapper must block (exit 2) — the quoted string IS
# executable code and the guard must recurse into it.
#
# Pass controls: non-executing wrappers (echo, printf) and plain read-only
# git commands must still pass (exit 0).
# -----------------------------------------------------------------------
echo ""
echo "-- P1 fix: string-executing wrappers (should block, exit 2) --"

# Core AC cases (verbatim from the reviewer finding)
_EVAL="eval"
run_test "${_EVAL} \"git reset --hard\" blocks" \
  2 "$(make_multiline_input 'eval "git reset --hard"')" "$NON_WT_PWD"

_BASH_C="bash -c"
run_test "${_BASH_C} \"git reset --hard\" blocks" \
  2 "$(make_multiline_input 'bash -c "git reset --hard"')" "$NON_WT_PWD"

_SH_C="sh -c"
run_test "${_SH_C} \"git clean -fd\" blocks" \
  2 "$(make_multiline_input 'sh -c "git clean -fd"')" "$NON_WT_PWD"

# Additional shell wrappers
_ZSH_C="zsh -c"
run_test "${_ZSH_C} \"git reset --hard\" blocks" \
  2 "$(make_multiline_input 'zsh -c "git reset --hard"')" "$NON_WT_PWD"

_KSH_C="ksh -c"
run_test "${_KSH_C} \"git clean -f\" blocks" \
  2 "$(make_multiline_input 'ksh -c "git clean -f"')" "$NON_WT_PWD"

# eval with single-quoted string
run_test "${_EVAL} 'git reset --hard' (single-quoted) blocks" \
  2 "$(make_multiline_input "eval 'git reset --hard'")" "$NON_WT_PWD"

# eval with multiple tokens (eval git clean -fd — no outer quotes, all tokens join)
run_test "${_EVAL} git clean -fd blocks (unquoted tokens)" \
  2 "$(make_multiline_input 'eval git clean -fd')" "$NON_WT_PWD"

# Checkout via wrapper
run_test "${_BASH_C} \"git checkout -- .\" blocks" \
  2 "$(make_multiline_input 'bash -c "git checkout -- ."')" "$NON_WT_PWD"

# Branch -D via wrapper
run_test "${_SH_C} \"git branch -D feature/x\" blocks" \
  2 "$(make_multiline_input 'sh -c "git branch -D feature/x"')" "$NON_WT_PWD"

# Compound inner command: bash -c "git status && git clean -fd"
_INNER_CHAIN="bash -c \"git status && git clean -fd\""
run_test "${_BASH_C} with inner && chain blocks (inner has destructive segment)" \
  2 "$(make_multiline_input 'bash -c "git status && git clean -fd"')" "$NON_WT_PWD"

# Prefixed wrappers (transparent prefixes before the wrapper)
run_test "command eval \"git reset --hard\" blocks" \
  2 "$(make_multiline_input 'command eval "git reset --hard"')" "$NON_WT_PWD"

run_test "nohup bash -c \"git reset --hard\" blocks" \
  2 "$(make_multiline_input 'nohup bash -c "git reset --hard"')" "$NON_WT_PWD"

run_test "timeout 5 bash -c \"git clean -fd\" blocks" \
  2 "$(make_multiline_input 'timeout 5 bash -c "git clean -fd"')" "$NON_WT_PWD"

run_test "env X=1 bash -c \"git reset --hard\" blocks" \
  2 "$(make_multiline_input 'env X=1 bash -c "git reset --hard"')" "$NON_WT_PWD"

run_test "nice bash -c \"git clean -f\" blocks" \
  2 "$(make_multiline_input 'nice bash -c "git clean -f"')" "$NON_WT_PWD"

run_test "nice -n 5 bash -c \"git reset --hard\" blocks" \
  2 "$(make_multiline_input 'nice -n 5 bash -c "git reset --hard"')" "$NON_WT_PWD"

# Nested wrapper: bash -c 'eval "git reset --hard"'
run_test "${_BASH_C} 'eval \"git reset --hard\"' (nested wrappers) blocks" \
  2 "$(make_multiline_input "bash -c 'eval \"git reset --hard\"'")" "$NON_WT_PWD"

echo ""
echo "-- P1 fix: non-executing wrappers and read-only git (should pass, exit 0) --"

# echo and printf are NOT string-executing wrappers — must pass
run_test "echo \"git reset --hard\" passes (echo is not a string-executor)" \
  0 "$(make_multiline_input 'echo "git reset --hard"')" "$NON_WT_PWD"

run_test "printf \"git clean -fd\" passes (printf is not a string-executor)" \
  0 "$(make_multiline_input 'printf "git clean -fd"')" "$NON_WT_PWD"

# Shell wrapper with only a safe inner command — must pass
run_test "${_BASH_C} \"git status\" passes (safe inner command)" \
  0 "$(make_multiline_input 'bash -c "git status"')" "$NON_WT_PWD"

run_test "${_SH_C} \"git log --oneline\" passes (safe inner command)" \
  0 "$(make_multiline_input 'sh -c "git log --oneline"')" "$NON_WT_PWD"

run_test "${_EVAL} \"git status\" passes (safe inner command)" \
  0 "$(make_multiline_input 'eval "git status"')" "$NON_WT_PWD"

# bash invoked as a script (no -c), not as a string executor
run_test "bash script.sh (no -c) passes (not string-exec mode)" \
  0 "$(make_multiline_input 'bash script.sh')" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# P1 round-2 fix: BLOCKING bypass regressions (exit 2)
#
# These four classes were confirmed BLOCKING in the round-2 review because
# canon_unwrap_string_exec_arg used exact-token matching and a shared rc=1
# for both "not a wrapper" and "recognised-but-unparseable". The fix:
#   - Path-qualified wrappers: matched by BASENAME after ${tok##*/} stripping.
#   - Combined short flags (-ec, -lc, -xc): detected by checking whether
#     'c' is the last character of a short-flag cluster.
#   - Prefix-owned flags (env -i, command -p): skipped before resolving the
#     wrapper token so env/command are still transparent.
#   - Escaped inner quotes: tokenizer leaves backslash artifacts; backslash
#     check fires rc=2 (fail-closed) instead of skip-pass.
# -----------------------------------------------------------------------
echo ""
echo "-- P1 round-2: path-qualified wrappers (should block, exit 2) --"

run_test "/bin/bash -c git reset --hard blocks (path-qualified)" \
  2 "$(make_multiline_input '/bin/bash -c "git reset --hard"')" "$NON_WT_PWD"

run_test "/bin/sh -c git clean -fd blocks (path-qualified)" \
  2 "$(make_multiline_input '/bin/sh -c "git clean -fd"')" "$NON_WT_PWD"

run_test "/usr/bin/env bash -c git reset --hard blocks (path-qualified env+bash)" \
  2 "$(make_multiline_input '/usr/bin/env bash -c "git reset --hard"')" "$NON_WT_PWD"

echo ""
echo "-- P1 round-2: combined short flags (should block, exit 2) --"

run_test "bash -ec git reset --hard blocks (combined -ec, c last)" \
  2 "$(make_multiline_input 'bash -ec "git reset --hard"')" "$NON_WT_PWD"

run_test "bash -lc git clean -fd blocks (combined -lc, c last)" \
  2 "$(make_multiline_input 'bash -lc "git clean -fd"')" "$NON_WT_PWD"

run_test "sh -xc git reset --hard blocks (combined -xc, c last)" \
  2 "$(make_multiline_input 'sh -xc "git reset --hard"')" "$NON_WT_PWD"

echo ""
echo "-- P1 round-2: prefix with its own flags (should block, exit 2) --"

run_test "env -i bash -c git reset --hard blocks (env owns -i)" \
  2 "$(make_multiline_input 'env -i bash -c "git reset --hard"')" "$NON_WT_PWD"

run_test "command -p eval git reset --hard blocks (command owns -p)" \
  2 "$(make_multiline_input 'command -p eval "git reset --hard"')" "$NON_WT_PWD"

echo ""
echo "-- P1 round-2: escaped inner quotes (fail-closed, exit 2) --"

# bash -c "git reset \"--hard\"" — tokenizer produces backslash artifact
# → rc=2 (fail-closed) is the correct outcome per spec.
run_test 'bash -c "git reset \"--hard\"" blocks (escaped inner quote → fail-closed)' \
  2 "$(make_multiline_input 'bash -c "git reset \"--hard\""')" "$NON_WT_PWD"

echo ""
echo "-- P1 round-2: pass controls for new bypass fixes (should pass, exit 0) --"

# echo with a quoted destructive-looking string — must still pass
run_test "echo \"git reset --hard\" still passes (not a wrapper)" \
  0 "$(make_multiline_input 'echo "git reset --hard"')" "$NON_WT_PWD"

# printf — must still pass
run_test "printf \"git clean -fd\" still passes (not a wrapper)" \
  0 "$(make_multiline_input 'printf "git clean -fd"')" "$NON_WT_PWD"

# /bin/bash invoked as script (no -c) — must pass
run_test "/bin/bash script.sh passes (path-qualified, no -c)" \
  0 "$(make_multiline_input '/bin/bash script.sh')" "$NON_WT_PWD"

# UPPERCASE EVAL is not a recognised wrapper — must pass
_EVAL_UPPER="EVAL"
run_test "EVAL \"git reset --hard\" passes (uppercase not a wrapper)" \
  0 "$(make_multiline_input "$_EVAL_UPPER \"git reset --hard\"")" "$NON_WT_PWD"

# bash -c with a safe inner command — must still pass
run_test "/bin/bash -c \"git status\" passes (path-qualified, safe inner)" \
  0 "$(make_multiline_input '/bin/bash -c "git status"')" "$NON_WT_PWD"

run_test "bash -ec \"git status\" passes (combined flag, safe inner)" \
  0 "$(make_multiline_input 'bash -ec "git status"')" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# P1 round-3 fix: four generalization regressions (exit 2 for all).
#
# These four forms bypassed the guard because canon_unwrap_string_exec_arg
# used exact-token matching or failed to normalise the command word before
# the case match:
#
#  1. Leading backslash: \bash defeats the former basename-only strip.
#     bash quote-removal does not prevent a literal \bash from surviving in
#     the command string.  Fix: strip leading '\' after basename resolution.
#
#  2. timeout -s9 5 bash -c: timeout only skipped one non-'-' token for the
#     duration, so a leading '-s9' flag caused the duration skip to be
#     skipped entirely, leaving 'bash' visible but never reached.
#     Fix: skip ALL '-*' tokens before the mandatory duration arg.
#
#  3. nice -n5 bash -c: only the two-token '-n <val>' form was handled.
#     Combined '-n5' was not recognised.
#     Fix: generic option-skip loop with specific '-n' → consume value handling.
#
#  4. bash -c "git$IFS reset --hard": git$IFS is not the exact token 'git'.
#     Already blocked by the shape-validation gate in canon_git_subcommand
#     (git$IFS fails ^[A-Za-z][A-Za-z0-9_-]*$ → rc=1 → parse-ambiguity
#     guard fires → exit 2). Tests added here for regression coverage.
# -----------------------------------------------------------------------
echo ""
echo "-- P1 round-3: backslash-prefix wrapper \\bash (should block, exit 2) --"

# Use single-quote outer shell literal, JSON-escape the backslash manually.
run_test '\\bash -c "git reset --hard" blocks (leading backslash defeated basename)' \
  2 "$(make_multiline_input '\bash -c "git reset --hard"')" "$NON_WT_PWD"

run_test '\\bash -c "git clean -fd" blocks (leading backslash)' \
  2 "$(make_multiline_input '\bash -c "git clean -fd"')" "$NON_WT_PWD"

echo ""
echo "-- P1 round-3: timeout with signal flag (should block, exit 2) --"

# Reviewer finding: combined -s9 flag was not skipped, so timeout's duration
# skip consumed nothing and bash was never reached.  Fix: skip ALL '-*' tokens
# before consuming the duration positional.
run_test 'timeout -s9 5 bash -c "git reset --hard" blocks (timeout -s9 not skipped)' \
  2 "$(make_multiline_input 'timeout -s9 5 bash -c "git reset --hard"')" "$NON_WT_PWD"

# Long-form =-value flag (self-contained, no following value token to consume).
run_test 'timeout --signal=9 5 bash -c "git reset --hard" blocks (long-form signal)' \
  2 "$(make_multiline_input 'timeout --signal=9 5 bash -c "git reset --hard"')" "$NON_WT_PWD"

echo ""
echo "-- P1 round-3: nice combined flag (should block, exit 2) --"

run_test 'nice -n5 bash -c "git reset --hard" blocks (combined -n5 not skipped)' \
  2 "$(make_multiline_input 'nice -n5 bash -c "git reset --hard"')" "$NON_WT_PWD"

run_test 'nice -n-5 bash -c "git clean -fd" blocks (combined -n-5 negative)' \
  2 "$(make_multiline_input 'nice -n-5 bash -c "git clean -fd"')" "$NON_WT_PWD"

echo ""
echo "-- P1 round-3: git\$IFS token (should block, exit 2) --"

run_test 'bash -c "git$IFS reset --hard" blocks (git$IFS not exact git token)' \
  2 "$(make_multiline_input 'bash -c "git$IFS reset --hard"')" "$NON_WT_PWD"

run_test 'bash -c "git${IFS}clean -fd" blocks (git${IFS} expansion attached)' \
  2 "$(make_multiline_input 'bash -c "git${IFS}clean -fd"')" "$NON_WT_PWD"

echo ""
echo "-- P1 round-3: pass controls (should pass, exit 0) --"

# bash with extra whitespace around -c (existing form, regression guard)
run_test 'bash  -c  "git status" passes (extra spaces around -c)' \
  0 "$(make_multiline_input 'bash  -c  "git status"')" "$NON_WT_PWD"

# Quoted wrapper word: "bash" is still a wrapper
run_test '"bash" -c "git status" passes (quoted word is still bash)' \
  0 "$(make_multiline_input '"bash" -c "git status"')" "$NON_WT_PWD"

# Benign prefixes: timeout/nice with direct git (bypasses wrapper check via canon_has_git_token)
run_test 'timeout 5 git status passes (benign prefix, direct git)' \
  0 "$(make_multiline_input 'timeout 5 git status')" "$NON_WT_PWD"

run_test 'nice git log passes (benign prefix, direct git)' \
  0 "$(make_multiline_input 'nice git log')" "$NON_WT_PWD"

run_test 'timeout 5 bash -c "git status" passes (safe inner via timeout)' \
  0 "$(make_multiline_input 'timeout 5 bash -c "git status"')" "$NON_WT_PWD"

run_test 'nice bash -c "git log" passes (nice with safe inner)' \
  0 "$(make_multiline_input 'nice bash -c "git log"')" "$NON_WT_PWD"

# xargs standalone with no string-exec args — passes (rc=1 from unwrap → skip)
run_test 'xargs git status passes (xargs not a string-exec wrapper)' \
  0 "$(make_multiline_input 'xargs git status')" "$NON_WT_PWD"

# Depth-4 wrapper nesting blocked (depth limit is 3)
run_test 'depth-4 nesting fails-closed (exceeds CANON_WRAPPER_MAX_DEPTH)' \
  2 "$(make_multiline_input 'bash -c "bash -c \"bash -c \\\"bash -c echo git\\\"\""')" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# P1 round-4 fix: scan-forward eliminates the timeout space-separated flag-
# value class (-s/-k/--signal/--kill-after).
#
# Root cause: round-3 timeout handling skipped all '-*' option tokens, then
# consumed exactly ONE non-'-' token as the duration.  For -s 9 5 bash ...,
# the non-'-' scan consumed '9' as the duration, leaving '5' as the next
# token; the main loop then saw '5' (unrecognised -> return 1, not a wrapper).
#
# Fix: scan ALL remaining tokens after the prefix word for the first token
# that normalizes to a known wrapper or prefix -- arity-free; the duration,
# signal value, and any other interleaved positionals are simply skipped.
# -----------------------------------------------------------------------
echo ""
echo "-- P1 round-4: timeout space-separated flag values (should block, exit 2) --"

_R4_HARD="--hard"
_R4_FD="-fd"

run_test 'timeout -s 9 5 bash -c inner blocks (space-separated -s value)' \
  2 "$(make_multiline_input "timeout -s 9 5 bash -c \"git reset $_R4_HARD\"")" "$NON_WT_PWD"

run_test 'timeout -k 1 5 bash -c inner blocks (space-separated -k value)' \
  2 "$(make_multiline_input "timeout -k 1 5 bash -c \"git reset $_R4_HARD\"")" "$NON_WT_PWD"

run_test 'timeout -k 1 --preserve-status 5 bash -c inner blocks (multi-flag)' \
  2 "$(make_multiline_input "timeout -k 1 --preserve-status 5 bash -c \"git reset $_R4_HARD\"")" "$NON_WT_PWD"

echo ""
echo "-- P1 round-4: direct destructive-git prefixed forms (should block, exit 2) --"

run_test 'timeout 5 git reset direct blocks (direct prefixed git)' \
  2 "$(make_input "timeout 5 git reset $_R4_HARD")" "$NON_WT_PWD"

run_test 'nice git reset direct blocks (direct nice-prefixed git)' \
  2 "$(make_input "nice git reset $_R4_HARD")" "$NON_WT_PWD"

echo ""
echo "-- P1 round-4: benign prefixed pass controls (should pass, exit 0) --"

run_test 'timeout 5 git status passes (benign direct-git)' \
  0 "$(make_input 'timeout 5 git status')" "$NON_WT_PWD"

run_test 'timeout -s9 5 git status passes (signal flag, benign git)' \
  0 "$(make_input 'timeout -s9 5 git status')" "$NON_WT_PWD"

run_test 'timeout -k 1 5 git status passes (kill-after, benign git)' \
  0 "$(make_input 'timeout -k 1 5 git status')" "$NON_WT_PWD"

run_test 'nice git log passes (benign nice-prefixed git)' \
  0 "$(make_input 'nice git log')" "$NON_WT_PWD"

run_test 'env FOO=bar git status passes (env assignment, benign git)' \
  0 "$(make_input 'env FOO=bar git status')" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# P1 round-5: universal scan-forward closes the unrecognised-prefix class.
#
# Root cause: the round-4 '*) return 1' catch-all in
# canon_unwrap_string_exec_arg treated any unrecognised outer token as
# "not a wrapper" — skipping it (fail-OPEN) instead of scanning forward.
# setsid/stdbuf/xargs all hit this arm.
#
# Fix: the '*' arm now uses scan-forward — advance past the unknown token,
# then call _do_scan_for_wrapper to find any wrapper in the remaining tokens.
# -----------------------------------------------------------------------
echo ""
echo "-- P1 round-5: unrecognised-prefix wrapper forms (should block, exit 2) --"

_R5_HARD="--hard"
_R5_FD="-fd"

run_test 'setsid bash -c inner blocks (unrecognised prefix setsid)' \
  2 "$(make_multiline_input "setsid bash -c \"git reset $_R5_HARD\"")" "$NON_WT_PWD"

run_test 'stdbuf -oL bash -c inner blocks (stdbuf with flag, unrecognised prefix)' \
  2 "$(make_multiline_input "stdbuf -oL bash -c \"git reset $_R5_HARD\"")" "$NON_WT_PWD"

run_test 'xargs -I{} bash -c inner blocks (xargs with replacement, unrecognised prefix)' \
  2 "$(make_multiline_input "xargs -I{} bash -c \"git reset $_R5_HARD\"")" "$NON_WT_PWD"

echo ""
echo "-- P1 round-5: no-over-block controls (should pass, exit 0) --"

# Use make_multiline_input (jq-encoded) for commands that contain quotes.
run_test 'echo "bash -c git reset" passes (quoted wrapper word is not a bare token)' \
  0 "$(make_multiline_input "echo \"bash -c 'git reset $_R5_HARD'\"")" "$NON_WT_PWD"

run_test 'printf "bash -c ..." passes (quoted printf arg not treated as wrapper)' \
  0 "$(make_multiline_input "printf \"bash -c 'git clean $_R5_FD'\"")" "$NON_WT_PWD"

echo ""
echo "-- P1 round-5: command-substitution gap (consciously deferred, should pass) --"
# bash -c "$(echo git reset --hard)" — inner arg is a command substitution.
# Static analysis cannot evaluate $(...) at hook time; this is a consciously
# documented limitation.  The guard passes it (exit 0).
run_test 'bash -c "$(echo git reset --hard)" passes (command-substitution gap, consciously deferred)' \
  0 "$(make_multiline_input 'bash -c "$(echo git reset --hard)"')" "$NON_WT_PWD"


# -----------------------------------------------------------------------
# P1 round-6: env --split-string / -S bypass (should block, exit 2)
#             and no-exec builtin over-block regression (should pass, exit 0).
#
# env -S / --split-string re-splits its argument and executes it like a shell
# command.  Round-6 teaches the env flag-skipper to recognise these flags and
# extract the payload for recursive evaluation instead of silently skipping
# them (which left the inner command unexamined → fail-OPEN).
#
# echo/printf with UNQUOTED args containing bare "bash" were over-blocked by
# the round-5 universal scan-forward.  Fix: the '*' arm now short-circuits
# for CANON_NO_EXEC_BUILTINS before calling _do_scan_for_wrapper.
# -----------------------------------------------------------------------
echo ""
echo "-- P1 round-6: env -S / --split-string forms (should block, exit 2) --"

_R6_HARD="--hard"
_R6_FD="-fd"

# env -S "bash -c 'git reset --hard'" → extract payload → recurse → block
run_test "env -S \"bash -c '...'\" blocks (env --split-string re-executes payload)" \
  2 "$(make_multiline_input "env -S \"bash -c 'git reset $_R6_HARD'\"")" "$NON_WT_PWD"

# env -Si "git reset --hard" → payload is direct destructive cmd → block
run_test "env -Si \"git reset --hard\" blocks (bundled cluster with S)" \
  2 "$(make_multiline_input "env -Si \"git reset $_R6_HARD\"")" "$NON_WT_PWD"

# env --split-string="git reset --hard" → payload is direct destructive cmd → block
run_test "env --split-string=\"git reset --hard\" blocks (long form with =)" \
  2 "$(make_multiline_input "env --split-string=\"git reset $_R6_HARD\"")" "$NON_WT_PWD"

echo ""
echo "-- P1 round-6: env -S pass control (should pass, exit 0) --"

# env -S "git status" → extract payload → recurse → safe → pass
run_test "env -S \"git status\" passes (safe inner command)" \
  0 "$(make_multiline_input "env -S \"git status\"")" "$NON_WT_PWD"

echo ""
echo "-- P1 round-6: no-exec builtin unquoted regression (should pass, exit 0) --"

# echo bash -c "git reset --hard" (UNQUOTED) → echo is no-exec → skip-pass
run_test "echo bash -c \"git reset\" UNQUOTED passes (echo is no-exec builtin)" \
  0 "$(make_multiline_input "echo bash -c \"git reset $_R6_HARD\"")" "$NON_WT_PWD"

# printf bash -c "git reset --hard" (UNQUOTED) → printf is no-exec → skip-pass
run_test "printf bash -c \"git reset\" UNQUOTED passes (printf is no-exec builtin)" \
  0 "$(make_multiline_input "printf bash -c \"git reset $_R6_HARD\"")" "$NON_WT_PWD"

# -----------------------------------------------------------------------
# P1 round-7: quote-parity fix — nested quoted flags inside wrapper strings
#
# Root cause: the recursion path (process_segment inner_seg inner_seg depth)
# passed inner_seg as BOTH the segment (flag-matching) AND raw_segment args.
# canon_unwrap_string_exec_arg strips the OUTER quotes from the extracted
# string, but individual flag tokens may still be wrapped in quotes:
#   bash -c "git reset '--hard'"  →  inner_cmd = git reset '--hard'
# The '--hard' flag still carries its surrounding single quotes.  Without
# quote deletion, the (^|[[:space:]])--hard boundary anchors miss it → exit 0.
#
# Fix: derive a quote-deleted variant via canon_delete_quotes() (factored from
# the top-level tr -d site) and pass (quote-deleted, raw) to process_segment,
# mirroring the top-level invocation exactly.
#
# All 5 forms below execute a real destructive op at runtime → must exit 2.
# -----------------------------------------------------------------------
echo ""
echo "-- P1 round-7: nested quoted flags (parity fix, should block, exit 2) --"

_R7_HARD="--hard"
_R7_FD="-fd"
_R7_F="-f"

# bash -c "git reset '--hard'"  — single-quoted flag inside double-quoted string
run_test "bash -c \"git reset '--hard'\" blocks (single-quoted flag in wrapper)" \
  2 "$(make_multiline_input "bash -c \"git reset '--hard'\"")" "$NON_WT_PWD"

# eval "git reset '--hard'"  — same quote pattern via eval
run_test "eval \"git reset '--hard'\" blocks (single-quoted flag via eval)" \
  2 "$(make_multiline_input "eval \"git reset '--hard'\"")" "$NON_WT_PWD"

# sh -c "git clean '-fd'"  — single-quoted flag in sh -c
run_test "sh -c \"git clean '-fd'\" blocks (single-quoted -fd flag)" \
  2 "$(make_multiline_input "sh -c \"git clean '-fd'\"")" "$NON_WT_PWD"

# bash -c 'git reset "--hard"'  — double-quoted flag inside single-quoted string
run_test 'bash -c '"'"'git reset "--hard"'"'"' blocks (double-quoted flag in single-quoted wrapper)' \
  2 "$(make_multiline_input 'bash -c '"'"'git reset "--hard"'"'"'')" "$NON_WT_PWD"

# bash -c "git clean '-f'"  — single-quoted -f flag
run_test "bash -c \"git clean '-f'\" blocks (single-quoted -f in wrapper)" \
  2 "$(make_multiline_input "bash -c \"git clean '-f'\"")" "$NON_WT_PWD"

echo ""
echo "-- P1 round-7: pass controls (should pass, exit 0) --"

# bash -c "git status"  — safe inner command, must not be over-blocked
run_test "bash -c \"git status\" passes (safe inner, no over-block from parity fix)" \
  0 "$(make_multiline_input 'bash -c "git status"')" "$NON_WT_PWD"

# bash -c "git log --oneline"  — safe inner command with a flag
run_test "bash -c \"git log --oneline\" passes (safe inner with flag)" \
  0 "$(make_multiline_input 'bash -c "git log --oneline"')" "$NON_WT_PWD"

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
