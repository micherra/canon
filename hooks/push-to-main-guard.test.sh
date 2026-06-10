#!/bin/bash
# Tests for push-to-main-guard.sh
# Run with: bash hooks/push-to-main-guard.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures
#
# NOTE: Most tests do NOT require a real git repo because resolve_protected_branch
# falls back to 'main' when origin/HEAD is unset (fresh clone / no origin).
# This is explicitly the expected fail-safe path and is asserted in comments.
# Only the "bare-push allow sub-case" section uses setup_repo with a real repo
# and a checked-out canon/foo branch to exercise the D4 narrow positive-safety allow.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/push-to-main-guard.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

# Produce the top-level {"command":"..."} shape (canon_extract_command handles both)
make_input() {
  local cmd="$1"
  printf '{"command":"%s"}' "$cmd"
}

# Produce the nested {"tool_name":"Bash","tool_input":{"command":"..."}} shape
make_nested_input() {
  local cmd="$1"
  printf '{"tool_name":"Bash","tool_input":{"command":"%s"}}' "$cmd"
}

echo ""
echo "=== push-to-main-guard.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# BLOCK-set — all of these must exit 2
# Protected branch falls back to 'main' (no origin/HEAD in test env).
# ---------------------------------------------------------------------------
echo "-- BLOCK-set: direct pushes to main (should block, exit 2) --"
run_test "git push origin main"                         2 "$(make_input 'git push origin main')"
run_test "git push origin HEAD:main"                    2 "$(make_input 'git push origin HEAD:main')"
run_test "git push origin HEAD:refs/heads/main"         2 "$(make_input 'git push origin HEAD:refs/heads/main')"
run_test "git push origin abc1234:main"                 2 "$(make_input 'git push origin abc1234:main')"
run_test "git push origin +main"                        2 "$(make_input 'git push origin +main')"
run_test "git push origin main:main"                    2 "$(make_input 'git push origin main:main')"
run_test "git push origin +main:main"                   2 "$(make_input 'git push origin +main:main')"
run_test "git push -f origin main"                      2 "$(make_input 'git push -f origin main')"
run_test "git push --force origin main"                 2 "$(make_input 'git push --force origin main')"
run_test "git push --force-with-lease origin main"      2 "$(make_input 'git push --force-with-lease origin main')"
run_test "git push origin --force HEAD:main"            2 "$(make_input 'git push origin --force HEAD:main')"
run_test "git push origin feature main (multi-refspec)" 2 "$(make_input 'git push origin feature main')"
run_test "sh -c 'git push origin main' (wrapper)"       2 "$(make_input 'sh -c \"git push origin main\"')"
run_test "bash -lc 'git push origin main' (wrapper)"    2 "$(make_input 'bash -lc \"git push origin main\"')"
run_test "bash -c 'git push origin HEAD:main' (wrapper)" 2 "$(make_input 'bash -c '"'"'git push origin HEAD:main'"'"'')"
run_test "eval 'git push origin main' (wrapper)"        2 "$(make_input 'eval \"git push origin main\"')"

echo ""
# ---------------------------------------------------------------------------
# ALLOW-set — feature/PR-branch pushes (should exit 0)
# ---------------------------------------------------------------------------
echo "-- ALLOW-set: feature-branch and non-main pushes (should allow, exit 0) --"
run_test "git push origin feature"                      0 "$(make_input 'git push origin feature')"
run_test "git push origin HEAD:canon/foo"               0 "$(make_input 'git push origin HEAD:canon/foo')"
run_test "git push -u origin my-branch"                 0 "$(make_input 'git push -u origin my-branch')"
run_test "git push --set-upstream origin canon/some-slug" 0 "$(make_input 'git push --set-upstream origin canon/some-slug')"
run_test "git push origin feature:feature"              0 "$(make_input 'git push origin feature:feature')"
run_test "git push origin +canon/foo"                   0 "$(make_input 'git push origin +canon/foo')"
run_test "git push -f origin canon/foo (force to non-main)" 0 "$(make_input 'git push -f origin canon/foo')"
run_test "git push origin HEAD:develop"                 0 "$(make_input 'git push origin HEAD:develop')"
run_test "git push origin mainline (NOT main — word boundary)" 0 "$(make_input 'git push origin mainline')"
run_test "git push origin main-ish (NOT main — substring)" 0 "$(make_input 'git push origin main-ish')"
run_test "sh -c 'git push origin canon/foo' (wrapper allow)" 0 "$(make_input 'sh -c \"git push origin canon/foo\"')"

echo ""
# ---------------------------------------------------------------------------
# AMBIGUOUS / fail-closed-set — unresolvable → must exit 2
# ---------------------------------------------------------------------------
echo "-- AMBIGUOUS-set: fail-closed on unresolvable push (should block, exit 2) --"

# Bare git push: CANON_GUARD_CWD is a non-repo path → branch resolution fails → block
# (This also covers the "git push while on main" incident class.)
run_test "bare 'git push' (unresolvable → fail-closed)"   2 "$(make_input 'git push')"
run_test "git push origin (no refspec, unresolvable)"     2 "$(make_input 'git push origin')"

# Shape-invalid subcommand: git $CMD origin main → canon_git_subcommand returns empty → fail-closed
run_test "git \$CMD origin main (ambiguous subcommand)"   2 "$(make_input 'git \$CMD origin main')"

# Unparseable-wrapper artifact: escaped/garbled inner → canon_unwrap_string_exec_arg rc=2 → block
# bash -c "git pu''sh origin main" — the empty-string concatenation makes the inner unparseable
run_test "bash -c with garbled inner (rc=2 → block)"      2 "$(make_input 'bash -c \"git pu'\'''\''sh origin main\"')"

# Empty-inner wrapper adjacent to a push: bash -c "" — recognised wrapper, empty inner → rc=2
run_test "bash -c empty inner (recognised wrapper, fail-closed)" 2 "$(make_input 'bash -c \"\"')"

echo ""
# ---------------------------------------------------------------------------
# PASSTHROUGH-set — non-push Bash (should exit 0, zero false positives — AC#6)
# ---------------------------------------------------------------------------
echo "-- PASSTHROUGH-set: non-push Bash commands (should pass, exit 0) --"
run_test "ls -la"                                       0 "$(make_input 'ls -la')"
run_test "git status"                                   0 "$(make_input 'git status')"
run_test "git commit -m msg"                            0 "$(make_input 'git commit -m \"msg\"')"
run_test "git fetch --all"                              0 "$(make_input 'git fetch --all')"
run_test "git log --oneline -5"                         0 "$(make_input 'git log --oneline -5')"
run_test "git pull origin main (pull is NOT push)"      0 "$(make_input 'git pull origin main')"
run_test "echo 'git push origin main' (quoted text)"    0 "$(make_input 'echo \"git push origin main\"')"
run_test "git worktree remove --force /tmp/x"           0 "$(make_input 'git worktree remove --force /tmp/x')"
run_test "empty command"                                0 '{"command":""}'

echo ""
# ---------------------------------------------------------------------------
# JSON shape parity — both input shapes must work via canon_extract_command
# ---------------------------------------------------------------------------
echo "-- JSON shape parity: both top-level and nested tool_input shapes --"
run_test "nested: git push origin main → block"         2 "$(make_nested_input 'git push origin main')"
run_test "nested: git push origin feature → allow"      0 "$(make_nested_input 'git push origin feature')"

echo ""
# ---------------------------------------------------------------------------
# Bare-push allow sub-case — D4 narrow positive-safety path
# Requires a real git repo where current branch = canon/foo (not protected).
# Protected branch falls back to 'main' (no origin/HEAD configured).
# push.default unset → defaults to 'simple' → current branch != main → ALLOW.
# ---------------------------------------------------------------------------
echo "-- Bare-push allow sub-case: canon/foo checkout, push.default unset → allow --"

TMPDIR_REPO=$(mktemp -d)
setup_repo "$TMPDIR_REPO"
# Checkout a non-protected branch so bare 'git push' would push canon/foo, not main
git -C "$TMPDIR_REPO" checkout -q -b canon/foo

# Run the hook with cwd = the test repo so git symbolic-ref HEAD resolves
run_test "bare 'git push' from canon/foo (push.default unset → allow)" \
  0 "$(make_input 'git push')" "$TMPDIR_REPO"

# Bare push from main itself must still block
run_test "bare 'git push' from main (still blocks)" \
  2 "$(make_input 'git push')"

rm -rf "$TMPDIR_REPO"

echo ""
# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "=== Results: PASS=$PASS FAIL=$FAIL ==="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
