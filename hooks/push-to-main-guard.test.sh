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
# F1: Shell-metacharacter refspec destinations — must block (fail-closed)
# A refspec destination containing $, backtick, {, or ( cannot be evaluated
# statically → block rather than risk a push to the protected branch.
# ---------------------------------------------------------------------------
echo "-- F1: shell-metacharacter refspec destinations (should block, exit 2) --"
# Refspec with command substitution in destination
run_test 'git push origin HEAD:$(echo main) (cmd-sub destination → block)' \
  2 "$(make_input 'git push origin HEAD:$(echo main)')"
# Variable expansion in destination
run_test 'git push origin HEAD:${X} (variable expansion → block)' \
  2 "$(make_input 'git push origin HEAD:${X}')"
# Command substitution in destination (src:dst form)
run_test 'git push origin main:$(echo main) (cmd-sub dst → block)' \
  2 "$(make_input 'git push origin main:$(echo main)')"
# Wrapper whose inner command is itself a shell expansion
run_test 'bash -c "$(echo git push origin HEAD:main)" (cmd-sub inner → block)' \
  2 "$(make_input 'bash -c "$(echo git push origin HEAD:main)"')"

echo ""
# ---------------------------------------------------------------------------
# F1: Legitimate forms that must NOT be over-blocked by metachar check
# Plain branch names have no $, backtick, {, or ( → still allowed
# ---------------------------------------------------------------------------
echo "-- F1: legitimate non-main pushes must not be over-blocked (should allow, exit 0) --"
run_test "git push origin feature (plain name, no metachar)" \
  0 "$(make_input 'git push origin feature')"
run_test "git push origin HEAD:canon/foo (slash, no metachar)" \
  0 "$(make_input 'git push origin HEAD:canon/foo')"
run_test "git push origin HEAD:refs/heads/feature (refs prefix, no metachar)" \
  0 "$(make_input 'git push origin HEAD:refs/heads/feature')"

echo ""
# ---------------------------------------------------------------------------
# ALLOWLIST posture — D6: new BLOCK-set rows (the obfuscation families)
# Every refspec that is not provably-literal-safe must exit 2.
# These cover F2 (${BRANCH:-main} operator-family), F1-retained, glob,
# brace-expansion, backtick, multi-colon, and whole-token-variable forms.
# NOTE: JSON encoding — metacharacters $, {, }, `, * reach the hook LITERALLY
# (the make_input printf does NOT shell-expand them; they are inside single
# quotes or escaped with \ so no shell expansion occurs before JSON encoding).
# ---------------------------------------------------------------------------
echo "-- ALLOWLIST: new BLOCK-set (obfuscation families, should block, exit 2) --"

# F2 primary regression: ${BRANCH:-main} operator family
run_test 'git push origin HEAD:${BRANCH:-main} (F2 operator — block)' \
  2 "$(make_input 'git push origin HEAD:${BRANCH:-main}')"
run_test 'git push origin HEAD:${BRANCH:=main} (F2 sibling := — block)' \
  2 "$(make_input 'git push origin HEAD:${BRANCH:=main}')"
run_test 'git push origin HEAD:${BRANCH:+main} (F2 sibling :+ — block)' \
  2 "$(make_input 'git push origin HEAD:${BRANCH:+main}')"
run_test 'git push origin ${BRANCH:-main} (F2 bare form — block)' \
  2 "$(make_input 'git push origin ${BRANCH:-main}')"

# No-operator variable in refspec (already blocked; lock it in)
run_test 'git push origin HEAD:${BRANCH} (no-operator var — block)' \
  2 "$(make_input 'git push origin HEAD:${BRANCH}')"

# F1 retained — command substitution (already blocked by fix-security patch;
# the allowlist gate now makes this structural rather than incidental)
run_test 'git push origin HEAD:$(echo main) (cmd-sub — F1 retain, block)' \
  2 "$(make_input 'git push origin HEAD:$(echo main)')"

# Backtick form
run_test 'git push origin HEAD:`echo main` (backtick — block)' \
  2 "$(printf '{"command":"%s"}' 'git push origin HEAD:`echo main`')"

# Glob in refspec destination
run_test 'git push origin HEAD:ma*n (glob — block)' \
  2 "$(make_input 'git push origin HEAD:ma*n')"

# Brace-expansion in refspec destination
run_test 'git push origin HEAD:m{a,a}in (brace-expansion — block)' \
  2 "$(make_input 'git push origin HEAD:m{a,a}in')"

# Whole-token variable (the entire refspec is a variable)
run_test 'git push origin "$DEST" (whole-token variable — block)' \
  2 "$(make_input 'git push origin $DEST')"

# Multi-colon refspec (regex allows at most one colon → rejects → block)
run_test 'git push origin HEAD:main:extra (multi-colon — block)' \
  2 "$(make_input 'git push origin HEAD:main:extra')"

echo ""
# ---------------------------------------------------------------------------
# ALLOWLIST posture — new ALLOW-set rows (legitimate forms must NOT over-block)
# Lookalike names, dots, tags, slashes — all must exit 0.
# ---------------------------------------------------------------------------
echo "-- ALLOWLIST: new ALLOW-set (legitimate forms, should allow, exit 0) --"
run_test "git push origin release/1.2.3 (version branch — allow)" \
  0 "$(make_input 'git push origin release/1.2.3')"
run_test "git push origin v1.0.0 (tag-style — allow)" \
  0 "$(make_input 'git push origin v1.0.0')"
run_test "git push origin HEAD:feature.x (dot in name — allow)" \
  0 "$(make_input 'git push origin HEAD:feature.x')"
run_test "git push origin HEAD:canon/some-slug (slash — reaffirm allow)" \
  0 "$(make_input 'git push origin HEAD:canon/some-slug')"

echo ""
# ---------------------------------------------------------------------------
# F3: Custom default-branch derivation — origin/HEAD → master
# Sets up a repo whose origin/HEAD symbolic-ref resolves to 'master',
# then asserts:
#   - git push origin HEAD:master → BLOCKED (exit 2)  [master is the protected branch]
#   - git push origin HEAD:main → ALLOWED (exit 0)   [main is NOT the protected branch]
# This guards the D2 derivation path (resolve_protected_branch) against regression.
# ---------------------------------------------------------------------------
echo "-- F3: custom default-branch (origin/HEAD → master) regression tests --"

TMPDIR_MASTER=$(mktemp -d)
setup_repo "$TMPDIR_MASTER"

# Create a fake origin (bare repo) whose HEAD points to master
TMPDIR_ORIGIN=$(mktemp -d)
git -C "$TMPDIR_ORIGIN" init -q --bare
git -C "$TMPDIR_ORIGIN" symbolic-ref HEAD refs/heads/master

# Add remote and set origin/HEAD on the test repo
git -C "$TMPDIR_MASTER" remote add origin "$TMPDIR_ORIGIN"
# Create origin/HEAD symbolic-ref directly so resolve_protected_branch finds it
git -C "$TMPDIR_MASTER" remote set-head origin master 2>/dev/null || \
  git -C "$TMPDIR_MASTER" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master

# With CANON_GUARD_CWD set to the master-default repo:
#   - push to master → BLOCK (master is the derived protected branch)
run_test "git push origin HEAD:master (master is protected → block)" \
  2 "$(make_input 'git push origin HEAD:master')" "$TMPDIR_MASTER"

#   - push to main → ALLOW (main is not the protected branch; master is)
run_test "git push origin HEAD:main (main is not protected in master-repo → allow)" \
  0 "$(make_input 'git push origin HEAD:main')" "$TMPDIR_MASTER"

#   - push to feature branch → ALLOW
run_test "git push origin HEAD:feature (non-protected → allow)" \
  0 "$(make_input 'git push origin HEAD:feature')" "$TMPDIR_MASTER"

#   - bare push from master branch → BLOCK (on the protected branch)
git -C "$TMPDIR_MASTER" checkout -q -b master 2>/dev/null || true
run_test "bare 'git push' from master (protected branch → block)" \
  2 "$(make_input 'git push')" "$TMPDIR_MASTER"

#   - bare push from a non-protected branch → ALLOW
git -C "$TMPDIR_MASTER" checkout -q -b canon/bar 2>/dev/null || true
run_test "bare 'git push' from canon/bar in master-repo → allow" \
  0 "$(make_input 'git push')" "$TMPDIR_MASTER"

rm -rf "$TMPDIR_MASTER" "$TMPDIR_ORIGIN"

echo ""
# ---------------------------------------------------------------------------
# CRITICAL fix: --all / --mirror bypass (security v2 finding)
# These "push everything" modes push EVERY local branch (incl. local main)
# regardless of the current branch and push.default. They must be blocked
# unconditionally from any checkout (dc-05: fail-closed-on-ambiguity).
# ---------------------------------------------------------------------------
echo "-- CRITICAL: --all/--mirror push-everything modes (should block, exit 2) --"

# Basic --all and --mirror blocks (default cwd, no real repo needed for the flag check)
run_test "git push --all origin (feature branch, no repo cwd)"     2 "$(make_input 'git push --all origin')"
run_test "git push --mirror origin (feature branch, no repo cwd)"  2 "$(make_input 'git push --mirror origin')"
run_test "git push --all (no remote specified)"                     2 "$(make_input 'git push --all')"
run_test "git push --mirror (no remote specified)"                  2 "$(make_input 'git push --mirror')"

# The exploit state: from a canon/<slug> feature branch (CANON_GUARD_CWD = real repo)
# --all still pushes local main to remote even from a feature branch checkout.
TMPDIR_ALL=$(mktemp -d)
setup_repo "$TMPDIR_ALL"
# Create local main and switch to a feature branch (mirrors real Canon state)
git -C "$TMPDIR_ALL" checkout -q -b canon/some-task 2>/dev/null || true

run_test "git push --all origin from canon/* feature branch (exploit state → block)" \
  2 "$(make_input 'git push --all origin')" "$TMPDIR_ALL"
run_test "git push --mirror origin from canon/* feature branch (exploit state → block)" \
  2 "$(make_input 'git push --mirror origin')" "$TMPDIR_ALL"

# Wrappers: --all reachable through string-executing wrappers
run_test "bash -c 'git push --all origin' (wrapper exploit path → block)" \
  2 "$(make_input 'bash -c \"git push --all origin\"')"
run_test "eval 'git push --mirror origin' (eval exploit path → block)" \
  2 "$(make_input 'eval \"git push --mirror origin\"')"

# master-default repo: --all also pushes master when origin/HEAD→master
TMPDIR_MASTER2=$(mktemp -d)
setup_repo "$TMPDIR_MASTER2"
TMPDIR_ORIGIN2=$(mktemp -d)
git -C "$TMPDIR_ORIGIN2" init -q --bare
git -C "$TMPDIR_ORIGIN2" symbolic-ref HEAD refs/heads/master
git -C "$TMPDIR_MASTER2" remote add origin "$TMPDIR_ORIGIN2"
git -C "$TMPDIR_MASTER2" remote set-head origin master 2>/dev/null || \
  git -C "$TMPDIR_MASTER2" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/master
git -C "$TMPDIR_MASTER2" checkout -q -b canon/other 2>/dev/null || true

run_test "git push --all origin in master-default repo (would push master → block)" \
  2 "$(make_input 'git push --all origin')" "$TMPDIR_MASTER2"

rm -rf "$TMPDIR_ALL" "$TMPDIR_MASTER2" "$TMPDIR_ORIGIN2"

# Prove --tags is NOT over-blocked (pushes only refs/tags/*, never branch main)
echo ""
echo "-- CRITICAL: --tags must NOT be over-blocked (should allow, exit 0) --"
run_test "git push --tags origin (tags only, cannot push branch main → allow)" \
  0 "$(make_input 'git push --tags origin')"
run_test "git push --tags (tags only, no remote → allow)" \
  0 "$(make_input 'git push --tags')"

rm -rf "$TMPDIR_ALL" 2>/dev/null || true

echo ""
# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "=== Results: PASS=$PASS FAIL=$FAIL ==="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
