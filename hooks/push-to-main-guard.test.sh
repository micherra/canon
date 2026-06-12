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
# CRITICAL v3 fix: abbreviated push-everything flags (git-accepted abbreviations)
# git accepts unambiguous option prefixes: --al/--all, --mi/--mir/--mirr/--mirror.
# All must exit 2 — canonical-prefix expansion (is_push_everything_mode) must
# block them exactly as it blocks the full spellings.
# ---------------------------------------------------------------------------
echo "-- CRITICAL v3: abbreviated push-everything flags (should block, exit 2) --"
run_test "git push --al origin (--al = --all → block)"        2 "$(make_input 'git push --al origin')"
run_test "git push --mi origin (--mi = --mirror → block)"     2 "$(make_input 'git push --mi origin')"
run_test "git push --mir origin (--mir = --mirror → block)"   2 "$(make_input 'git push --mir origin')"
run_test "git push --mirr origin (--mirr = --mirror → block)" 2 "$(make_input 'git push --mirr origin')"
run_test "git push --mirro origin (--mirro = --mirror → block)" 2 "$(make_input 'git push --mirro origin')"

# Abbreviated forms through string-executing wrappers (wrapper recursion must preserve the block)
run_test "bash -c 'git push --al origin' (abbreviated --all, wrapper → block)"   2 "$(make_input 'bash -c \"git push --al origin\"')"
run_test "bash -c 'git push --mir origin' (abbreviated --mirror, wrapper → block)" 2 "$(make_input 'bash -c \"git push --mir origin\"')"

echo ""
# ---------------------------------------------------------------------------
# CRITICAL v3 fix: ALLOW rows — flags starting with --a or --m that are NOT
# push-everything modes must not be over-blocked.
# --atomic: starts with --at (not matched by --a(l(l)?)? pattern)
# --tags, --porcelain: different prefix families entirely
# ---------------------------------------------------------------------------
echo "-- CRITICAL v3: no over-block for --atomic/--tags/--porcelain (should allow, exit 0) --"
TMPDIR_ATOMIC=$(mktemp -d)
setup_repo "$TMPDIR_ATOMIC"
git -C "$TMPDIR_ATOMIC" checkout -q -b canon/foo

run_test "git push --atomic origin HEAD:canon/foo (--atomic is not push-everything → allow)" \
  0 "$(make_input 'git push --atomic origin HEAD:canon/foo')" "$TMPDIR_ATOMIC"
run_test "git push --porcelain origin HEAD:canon/foo (--porcelain is not push-everything → allow)" \
  0 "$(make_input 'git push --porcelain origin HEAD:canon/foo')" "$TMPDIR_ATOMIC"

rm -rf "$TMPDIR_ATOMIC"

# --tags confirmed safe already above, but add an explicit row documenting v3 scope
run_test "git push --tags origin (--tags is not push-everything — v3 reaffirm)" \
  0 "$(make_input 'git push --tags origin')"

echo ""
# ---------------------------------------------------------------------------
# MEDIUM v3 fix: config-driven bare-push main-movers
# remote.<remote>.push = refs/heads/* overrides push.default entirely.
# remote.<remote>.mirror = true makes bare 'git push origin' mirror all refs.
# Both must exit 2 (fail-closed) even from a feature branch.
# ---------------------------------------------------------------------------
echo "-- MEDIUM v3: config-driven bare-push main-movers (should block, exit 2) --"

TMPDIR_CFGPUSH=$(mktemp -d)
setup_repo "$TMPDIR_CFGPUSH"
git -C "$TMPDIR_CFGPUSH" checkout -q -b canon/feature
# Set a push refspec that would push all local branches (including main) on bare push
git -C "$TMPDIR_CFGPUSH" config "remote.origin.push" "refs/heads/*:refs/heads/*"

run_test "bare 'git push' with remote.origin.push=refs/heads/* (overrides push.default → block)" \
  2 "$(make_input 'git push')" "$TMPDIR_CFGPUSH"
run_test "bare 'git push origin' with remote.origin.push=refs/heads/* → block" \
  2 "$(make_input 'git push origin')" "$TMPDIR_CFGPUSH"

rm -rf "$TMPDIR_CFGPUSH"

TMPDIR_MIRROR=$(mktemp -d)
setup_repo "$TMPDIR_MIRROR"
git -C "$TMPDIR_MIRROR" checkout -q -b canon/feature
# Set mirror=true so bare 'git push origin' acts like --mirror
git -C "$TMPDIR_MIRROR" config --bool "remote.origin.mirror" "true"

run_test "bare 'git push origin' with remote.origin.mirror=true (mirror config → block)" \
  2 "$(make_input 'git push origin')" "$TMPDIR_MIRROR"
run_test "bare 'git push' with remote.origin.mirror=true → block" \
  2 "$(make_input 'git push')" "$TMPDIR_MIRROR"

rm -rf "$TMPDIR_MIRROR"

echo ""
# ---------------------------------------------------------------------------
# MEDIUM v3: ALLOW rows — default config (no remote.*.push, no remote.*.mirror)
# must continue to allow bare push from a non-protected feature branch.
# This is a regression guard: the config checks must not break the safe path.
# ---------------------------------------------------------------------------
echo "-- MEDIUM v3: default config bare push from feature branch (should allow, exit 0) --"

TMPDIR_DEFAULT=$(mktemp -d)
setup_repo "$TMPDIR_DEFAULT"
git -C "$TMPDIR_DEFAULT" checkout -q -b canon/foo

run_test "bare 'git push' from canon/foo, no config overrides (default config → allow)" \
  0 "$(make_input 'git push')" "$TMPDIR_DEFAULT"
run_test "bare 'git push origin' from canon/foo, no config overrides → allow" \
  0 "$(make_input 'git push origin')" "$TMPDIR_DEFAULT"

rm -rf "$TMPDIR_DEFAULT"

echo ""
# ---------------------------------------------------------------------------
# Finding 1 (P1): --branches / --[no-]branches alias of --all
# Per 'git push -h', --[no-]branches is an alias of --all: it pushes every
# local branch including the protected branch. The affirmative form must be
# blocked wherever --all is blocked. The negation --no-branches cancels the
# option and is NOT a push-everything mode — it must NOT be over-blocked.
# Abbreviated forms (--b, --br, ..., --branch) must also be blocked (canonical-
# prefix expansion, matching the pattern already applied to --all/--mirror).
# ---------------------------------------------------------------------------
echo "-- Finding 1 (P1): --branches push-everything alias (should block, exit 2) --"
run_test "git push --branches origin (--branches = --all → block)" \
  2 "$(make_input 'git push --branches origin')"
run_test "git push --branches (no remote specified → block)" \
  2 "$(make_input 'git push --branches')"
run_test "git push --branch origin (abbreviated --branches → block)" \
  2 "$(make_input 'git push --branch origin')"
run_test "git push --branc origin (abbreviated --branches → block)" \
  2 "$(make_input 'git push --branc origin')"
run_test "git push --bran origin (abbreviated --branches → block)" \
  2 "$(make_input 'git push --bran origin')"
run_test "git push --bra origin (abbreviated --branches → block)" \
  2 "$(make_input 'git push --bra origin')"
run_test "git push --br origin (abbreviated --branches → block)" \
  2 "$(make_input 'git push --br origin')"
run_test "git push --b origin (abbreviated --branches → block)" \
  2 "$(make_input 'git push --b origin')"

echo ""
echo "-- Finding 1 (P1): --no-branches must NOT be over-blocked (should allow, exit 0) --"
# --no-branches cancels the --branches/--all flag; it is NOT a push-everything mode.
# A feature-branch push with --no-branches should still be allowed.
TMPDIR_NOBRANCHES=$(mktemp -d)
setup_repo "$TMPDIR_NOBRANCHES"
git -C "$TMPDIR_NOBRANCHES" checkout -q -b canon/feature
run_test "git push --no-branches origin HEAD:canon/feature (--no-branches cancels → allow)" \
  0 "$(make_input 'git push --no-branches origin HEAD:canon/feature')" "$TMPDIR_NOBRANCHES"
rm -rf "$TMPDIR_NOBRANCHES"

echo ""
# ---------------------------------------------------------------------------
# Finding 2 (P1): --repo preserves refspecs
# 'git push --repo origin main' — --repo supplies the repository; 'main' is
# still a REFSPEC, not the remote. The parser must mark remote_seen=true when
# --repo is consumed (both separate and equals forms) so that 'main' flows
# through the refspec-safety gate rather than being silently swallowed as the
# "first bare token = remote" slot, which would leave zero refspecs and allow
# the push via the bare_push_is_safe path.
# ---------------------------------------------------------------------------
echo "-- Finding 2 (P1): --repo preserves refspecs (should block, exit 2) --"

TMPDIR_REPO_SEP=$(mktemp -d)
setup_repo "$TMPDIR_REPO_SEP"
git -C "$TMPDIR_REPO_SEP" checkout -q -b canon/feature

# Separate form: 'git push --repo origin main' — main is a refspec → block
run_test "git push --repo origin main (separate form, main is refspec → block)" \
  2 "$(make_input 'git push --repo origin main')" "$TMPDIR_REPO_SEP"

# Equals form: 'git push --repo=origin main' — main is a refspec → block
run_test "git push --repo=origin main (equals form, main is refspec → block)" \
  2 "$(make_input 'git push --repo=origin main')" "$TMPDIR_REPO_SEP"

rm -rf "$TMPDIR_REPO_SEP"

echo ""
echo "-- Finding 2 (P1): --repo with benign refspec must allow (should allow, exit 0) --"

TMPDIR_REPO_ALLOW=$(mktemp -d)
setup_repo "$TMPDIR_REPO_ALLOW"
git -C "$TMPDIR_REPO_ALLOW" checkout -q -b canon/feature

# 'git push --repo origin feature-x' — feature-x is a non-protected refspec → allow
run_test "git push --repo origin feature-x (benign refspec → allow)" \
  0 "$(make_input 'git push --repo origin feature-x')" "$TMPDIR_REPO_ALLOW"

# 'git push --repo=origin HEAD:canon/feature' — non-protected destination → allow
run_test "git push --repo=origin HEAD:canon/feature (equals form, benign → allow)" \
  0 "$(make_input 'git push --repo=origin HEAD:canon/feature')" "$TMPDIR_REPO_ALLOW"

rm -rf "$TMPDIR_REPO_ALLOW"

echo ""
# ---------------------------------------------------------------------------
# Finding A (P1): HEAD refspec destination resolves to current branch
# 'git push origin HEAD' from main updates refs/heads/main — must be BLOCKED.
# 'git push origin HEAD' from a feature branch pushes that branch — must ALLOW.
# 'git push origin HEAD:main' is already blocked (dst=main), but HEAD without a
# dst colon is the new gap: dst=HEAD must resolve to current branch.
# Fail-closed: if current branch cannot be resolved, HEAD target unknown → BLOCK.
# ---------------------------------------------------------------------------
echo "-- Finding A (P1): HEAD refspec resolves to current branch --"

# git push origin HEAD from main — HEAD resolves to main → BLOCK
TMPDIR_HEAD_MAIN=$(mktemp -d)
setup_repo "$TMPDIR_HEAD_MAIN"
# Explicitly rename to 'main' — git-init may default to 'master' in CI when
# init.defaultBranch is not configured. This makes the test deterministic
# regardless of host git configuration.
git -C "$TMPDIR_HEAD_MAIN" branch -m main
run_test "git push origin HEAD from main (HEAD=main → block)" \
  2 "$(make_input 'git push origin HEAD')" "$TMPDIR_HEAD_MAIN"

# git push origin HEAD from a feature branch — HEAD resolves to canon/feature → ALLOW
git -C "$TMPDIR_HEAD_MAIN" checkout -q -b canon/feature
run_test "git push origin HEAD from feature branch (HEAD=canon/feature → allow)" \
  0 "$(make_input 'git push origin HEAD')" "$TMPDIR_HEAD_MAIN"

rm -rf "$TMPDIR_HEAD_MAIN"

# git push origin HEAD:main — dst is explicit 'main', not HEAD; already blocked by existing logic
run_test "git push origin HEAD:main (explicit dst=main → block, pre-existing coverage)" \
  2 "$(make_input 'git push origin HEAD:main')"

echo ""
# ---------------------------------------------------------------------------
# Finding B (P1): --recurse-submodules consumes its value token
# 'git push --recurse-submodules check origin' — git consumes 'check' as the
# option value, not a positional. Without the fix, 'check' becomes the remote
# and 'origin' becomes a refspec (allowing an accidental bare push to origin).
# With the fix: skip_next=true consumes 'check'; 'origin' is the remote; no
# refspecs → bare_push_is_safe path → BLOCK when on main.
# 'git push --recurse-submodules=on-demand origin feature-x' — equals form is
# self-contained; 'origin' = remote, 'feature-x' = refspec → ALLOW (non-main).
# ---------------------------------------------------------------------------
echo "-- Finding B (P1): --recurse-submodules value-consuming option --"

# Separate form from main: 'check' consumed as value, 'origin' is remote, bare push → BLOCK
TMPDIR_RS_MAIN=$(mktemp -d)
setup_repo "$TMPDIR_RS_MAIN"
# Explicitly rename to 'main' — git-init may default to 'master' in CI when
# init.defaultBranch is not configured. This makes the test deterministic
# regardless of host git configuration.
git -C "$TMPDIR_RS_MAIN" branch -m main
run_test "git push --recurse-submodules check origin from main (separate form → block)" \
  2 "$(make_input 'git push --recurse-submodules check origin')" "$TMPDIR_RS_MAIN"
rm -rf "$TMPDIR_RS_MAIN"

# Equals form with non-main refspec: 'on-demand' is part of the option, 'feature-x' = refspec → ALLOW
run_test "git push --recurse-submodules=on-demand origin feature-x (equals form, non-main → allow)" \
  0 "$(make_input 'git push --recurse-submodules=on-demand origin feature-x')"

echo ""
# ---------------------------------------------------------------------------
# Finding B (P1): git -C <path> HEAD resolution uses the correct repo
# 'git -C <other-repo> push origin HEAD' must resolve HEAD in <other-repo>,
# not in the hook's cwd. Without the fix, HEAD is resolved in the cwd
# (CANON_GUARD_CWD), so a push to main from a different-directory main repo
# could slip through if the cwd happens to be on a feature branch.
# With the fix: canon_git_C_path extracts the -C path; HEAD resolves there.
# ---------------------------------------------------------------------------
echo "-- Finding B (P1, new): git -C <path> resolves HEAD in the correct repo --"

# git -C <main-repo> push origin HEAD — HEAD in <main-repo> is main → BLOCK
TMPDIR_C_MAIN=$(mktemp -d)
setup_repo "$TMPDIR_C_MAIN"
git -C "$TMPDIR_C_MAIN" branch -m main

# Feature-branch repo that owns CANON_GUARD_CWD — hook cwd is on a feature branch.
TMPDIR_C_FEATURE=$(mktemp -d)
setup_repo "$TMPDIR_C_FEATURE"
git -C "$TMPDIR_C_FEATURE" branch -m main
git -C "$TMPDIR_C_FEATURE" checkout -q -b canon/feature

# The command targets TMPDIR_C_MAIN (on main) via -C; CANON_GUARD_CWD is TMPDIR_C_FEATURE
# (on canon/feature). The hook must look at the -C target, not the cwd.
echo '{"command":"'"git -C $TMPDIR_C_MAIN push origin HEAD"'"}' \
  | CANON_GUARD_CWD="$TMPDIR_C_FEATURE" bash "$HOOK" >/dev/null 2>&1 && _exit_C_main=0 || _exit_C_main=$?
if [[ "$_exit_C_main" -eq 2 ]]; then
  echo "  PASS: git -C <main-repo> push origin HEAD blocks (HEAD=main in target repo)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: git -C <main-repo> push origin HEAD should block, got exit=$_exit_C_main"
  FAIL=$((FAIL + 1))
fi

# git -C <feature-repo> push origin HEAD — HEAD in <feature-repo> is canon/feature → ALLOW
# CANON_GUARD_CWD is a main-branch repo (would block without -C support).
TMPDIR_C_CWD_MAIN=$(mktemp -d)
setup_repo "$TMPDIR_C_CWD_MAIN"
git -C "$TMPDIR_C_CWD_MAIN" branch -m main

echo '{"command":"'"git -C $TMPDIR_C_FEATURE push origin HEAD"'"}' \
  | CANON_GUARD_CWD="$TMPDIR_C_CWD_MAIN" bash "$HOOK" >/dev/null 2>&1 && _exit_C_feat=0 || _exit_C_feat=$?
if [[ "$_exit_C_feat" -eq 0 ]]; then
  echo "  PASS: git -C <feature-repo> push origin HEAD allows (HEAD=canon/feature in target repo)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: git -C <feature-repo> push origin HEAD should allow, got exit=$_exit_C_feat"
  FAIL=$((FAIL + 1))
fi

rm -rf "$TMPDIR_C_MAIN" "$TMPDIR_C_FEATURE" "$TMPDIR_C_CWD_MAIN"

echo ""
# ---------------------------------------------------------------------------
# Finding A (P1, round 4): multiple -C options — effective directory is the
# last absolute path (or composed relative), not the first.
# 'git -C /tmp/a -C /tmp/b push origin HEAD' must use HEAD from /tmp/b.
# ---------------------------------------------------------------------------
echo "-- Finding A (P1, round 4): multiple -C options — effective directory is the last --"

# Repo A: HEAD is on main (would block if the first -C were used).
TMPDIR_MULTI_A=$(mktemp -d)
setup_repo "$TMPDIR_MULTI_A"
git -C "$TMPDIR_MULTI_A" branch -m main

# Repo B: HEAD is on a feature branch (should allow because it is the last -C).
TMPDIR_MULTI_B=$(mktemp -d)
setup_repo "$TMPDIR_MULTI_B"
git -C "$TMPDIR_MULTI_B" branch -m main
git -C "$TMPDIR_MULTI_B" checkout -q -b canon/feature-b

# git -C <main-A> -C <feature-B> push origin HEAD → effective dir is B (feature branch) → ALLOW
echo '{"command":"'"git -C $TMPDIR_MULTI_A -C $TMPDIR_MULTI_B push origin HEAD"'"}' \
  | CANON_GUARD_CWD="$TMPDIR_MULTI_A" bash "$HOOK" >/dev/null 2>&1 && _exit_multi_allow=0 || _exit_multi_allow=$?
if [[ "$_exit_multi_allow" -eq 0 ]]; then
  echo "  PASS: git -C <main> -C <feature> push origin HEAD allows (last -C = feature branch)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: git -C <main> -C <feature> push origin HEAD should allow, got exit=$_exit_multi_allow"
  FAIL=$((FAIL + 1))
fi

# git -C <feature-B> -C <main-A> push origin HEAD → effective dir is A (main) → BLOCK
echo '{"command":"'"git -C $TMPDIR_MULTI_B -C $TMPDIR_MULTI_A push origin HEAD"'"}' \
  | CANON_GUARD_CWD="$TMPDIR_MULTI_B" bash "$HOOK" >/dev/null 2>&1 && _exit_multi_block=0 || _exit_multi_block=$?
if [[ "$_exit_multi_block" -eq 2 ]]; then
  echo "  PASS: git -C <feature> -C <main> push origin HEAD blocks (last -C = main)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: git -C <feature> -C <main> push origin HEAD should block, got exit=$_exit_multi_block"
  FAIL=$((FAIL + 1))
fi

rm -rf "$TMPDIR_MULTI_A" "$TMPDIR_MULTI_B"

echo ""
# ---------------------------------------------------------------------------
# Finding B (P1, round 4): path-with-spaces — a -C path containing spaces
# must be resolved correctly (no word-splitting bypass).
# ---------------------------------------------------------------------------
echo "-- Finding B (P1, round 4): -C path with spaces is resolved correctly --"

# Create a repo inside a directory whose name contains a space.
TMPDIR_SPACE_PARENT=$(mktemp -d)
TMPDIR_SPACE_REPO="${TMPDIR_SPACE_PARENT}/repo with spaces"
mkdir -p "$TMPDIR_SPACE_REPO"
setup_repo "$TMPDIR_SPACE_REPO"
git -C "$TMPDIR_SPACE_REPO" branch -m main

# Feature-branch repo for CANON_GUARD_CWD (on a feature branch — should NOT
# affect resolution when the command explicitly names the space-path repo).
TMPDIR_SPACE_CWD=$(mktemp -d)
setup_repo "$TMPDIR_SPACE_CWD"
git -C "$TMPDIR_SPACE_CWD" branch -m main
git -C "$TMPDIR_SPACE_CWD" checkout -q -b canon/space-feature

# The command uses a quoted -C path with a space. It targets the space-repo
# which is on main → must BLOCK (fail-closed).
echo "{\"command\":\"git -C '$TMPDIR_SPACE_REPO' push origin HEAD\"}" \
  | CANON_GUARD_CWD="$TMPDIR_SPACE_CWD" bash "$HOOK" >/dev/null 2>&1 && _exit_space=0 || _exit_space=$?
if [[ "$_exit_space" -eq 2 ]]; then
  echo "  PASS: git -C '<path with spaces>' push origin HEAD blocks (repo on main)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: git -C '<path with spaces>' push origin HEAD should block, got exit=$_exit_space"
  FAIL=$((FAIL + 1))
fi

# Now checkout a feature branch in the space-repo and verify ALLOW.
git -C "$TMPDIR_SPACE_REPO" checkout -q -b canon/space-feature2
echo "{\"command\":\"git -C '$TMPDIR_SPACE_REPO' push origin HEAD\"}" \
  | CANON_GUARD_CWD="$TMPDIR_SPACE_CWD" bash "$HOOK" >/dev/null 2>&1 && _exit_space_feat=0 || _exit_space_feat=$?
if [[ "$_exit_space_feat" -eq 0 ]]; then
  echo "  PASS: git -C '<path with spaces>' push origin HEAD allows (repo on feature branch)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: git -C '<path with spaces>' push origin HEAD should allow, got exit=$_exit_space_feat"
  FAIL=$((FAIL + 1))
fi

rm -rf "$TMPDIR_SPACE_PARENT" "$TMPDIR_SPACE_CWD"

echo ""
# ---------------------------------------------------------------------------
# CRASH REGRESSION (bash-3.x empty-array fix): bare git push under set -u
# The guard previously emitted "unbound variable" on stderr when git_dir_args
# was empty (no -C token in the command). Fixed by using the bash-3.x-safe
# conditional expansion ${arr[@]+"${arr[@]}"} at all 6 expansion sites.
# This test verifies stderr is clean (no "unbound variable") while the
# bare-push path still blocks (exit 2 — no real repo → fails bare_push_is_safe).
# Uses /bin/bash explicitly (macOS = 3.2.57) to match the crash environment.
# ---------------------------------------------------------------------------
echo "-- CRASH REGRESSION: bare 'git push' must not emit 'unbound variable' (bash 3.2) --"

# run_test_in_dir_no_pattern: assert exit 0 AND no pattern in stderr.
# Bare push exits 2, not 0 — so we must use a custom check here.
_crash_output=$( printf '%s' '{"command":"git push"}' | /bin/bash "$HOOK" 2>&1 ) || true
if echo "$_crash_output" | grep -q "unbound variable"; then
  echo "  FAIL: bare 'git push' emits 'unbound variable' on stderr (crash regression)"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: bare 'git push' does NOT emit 'unbound variable' (crash fixed)"
  PASS=$((PASS + 1))
fi
unset _crash_output

echo ""
# ---------------------------------------------------------------------------
# PASSTHROUGH additions (over-broad fix): non-git segments with $() / backticks
# The old over-broad block blocked ANY segment containing $() or backticks even
# when it had no git token at all. After the fix these must exit 0.
# ---------------------------------------------------------------------------
echo "-- PASSTHROUGH (over-broad fix): non-git segments with metacharacters must allow (exit 0) --"

# echo with command substitution (was blocked by the over-broad block)
# Input: {"command":"echo hello $(whoami)"}
_pt_echo_input='{"command":"echo hello $(whoami)"}'
_pt_echo_exit=0
printf '%s' "$_pt_echo_input" | bash "$HOOK" >/dev/null 2>&1 || _pt_echo_exit=$?
if [[ "$_pt_echo_exit" -eq 0 ]]; then
  echo "  PASS: echo hello \$(whoami) allowed (exit 0)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: echo hello \$(whoami) should be allowed, got exit=$_pt_echo_exit"
  FAIL=$((FAIL + 1))
fi
unset _pt_echo_input _pt_echo_exit

# gh pr comment with backtick in body (was blocked by the over-broad block)
# The backtick is inside the --body value, a non-git segment
_pt_gh_input='{"command":"gh pr comment 1 --body \"see `foo` here\""}'
_pt_gh_exit=0
printf '%s' "$_pt_gh_input" | bash "$HOOK" >/dev/null 2>&1 || _pt_gh_exit=$?
if [[ "$_pt_gh_exit" -eq 0 ]]; then
  echo "  PASS: gh pr comment body with backtick allowed (exit 0)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: gh pr comment body with backtick should be allowed, got exit=$_pt_gh_exit"
  FAIL=$((FAIL + 1))
fi
unset _pt_gh_input _pt_gh_exit

# heredoc-style body containing backticks
_pt_heredoc_input='{"command":"cat <<EOF\nsee `code` here\nEOF"}'
_pt_heredoc_exit=0
printf '%s' "$_pt_heredoc_input" | bash "$HOOK" >/dev/null 2>&1 || _pt_heredoc_exit=$?
if [[ "$_pt_heredoc_exit" -eq 0 ]]; then
  echo "  PASS: heredoc body with backtick allowed (exit 0)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: heredoc body with backtick should be allowed, got exit=$_pt_heredoc_exit"
  FAIL=$((FAIL + 1))
fi
unset _pt_heredoc_input _pt_heredoc_exit

# git log piped to tail (non-push git command with pipe + stderr redirect)
_pt_log_input='{"command":"git log --oneline 2>&1 | tail -5"}'
_pt_log_exit=0
printf '%s' "$_pt_log_input" | bash "$HOOK" >/dev/null 2>&1 || _pt_log_exit=$?
if [[ "$_pt_log_exit" -eq 0 ]]; then
  echo "  PASS: git log --oneline 2>&1 | tail -5 allowed (exit 0)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: git log --oneline 2>&1 | tail -5 should be allowed, got exit=$_pt_log_exit"
  FAIL=$((FAIL + 1))
fi
unset _pt_log_input _pt_log_exit

echo ""
# ---------------------------------------------------------------------------
# BYPASS MATRIX — obfuscation forms that must still BLOCK (exit 2)
# These existed before; this section adds explicit named rows to confirm
# the over-broad-fix does NOT weaken push-to-main protection.
# ---------------------------------------------------------------------------
echo "-- BYPASS MATRIX: obfuscated push forms must still block (exit 2) --"

# Obfuscated refspec: git push origin $(echo main)
# Takes git-token path → SAFE_REFSPEC_RE rejects the $() refspec → BLOCK
_bm_cmdsub_input='{"command":"git push origin $(echo main)"}'
_bm_cmdsub_exit=0
printf '%s' "$_bm_cmdsub_input" | bash "$HOOK" >/dev/null 2>&1 || _bm_cmdsub_exit=$?
if [[ "$_bm_cmdsub_exit" -eq 2 ]]; then
  echo "  PASS: git push origin \$(echo main) blocked (exit 2)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: git push origin \$(echo main) should block, got exit=$_bm_cmdsub_exit"
  FAIL=$((FAIL + 1))
fi
unset _bm_cmdsub_input _bm_cmdsub_exit

# Obfuscated refspec: git push origin ${B:-main}
# Already in F2 ALLOWLIST section above; add explicit named row for bypass matrix
run_test "git push origin \${B:-main} (bypass matrix — obfuscated refspec → block)" \
  2 "$(make_input 'git push origin ${B:-main}')"

# Obfuscated refspec: backtick form
run_test 'git push origin `echo main` (bypass matrix — backtick refspec → block)' \
  2 "$(printf '{"command":"%s"}' 'git push origin `echo main`')"

# Glued git token: git$(x) push origin main
# canon_has_ambiguous_git_token fires → fail-closed → BLOCK
run_test "git push origin main via glued token (bypass matrix → block)" \
  2 "$(printf '{"command":"%s"}' 'git$(x) push origin main')"

# Wrapper inner cmdsubst: bash -c "$(echo git push origin main)"
# wrapper-inner-cmdsubst block fires (line preserved after Edit B) → BLOCK
_bm_wrapper_input='{"command":"bash -c \"$(echo git push origin HEAD:main)\""}'
_bm_wrapper_exit=0
printf '%s' "$_bm_wrapper_input" | bash "$HOOK" >/dev/null 2>&1 || _bm_wrapper_exit=$?
if [[ "$_bm_wrapper_exit" -eq 2 ]]; then
  echo "  PASS: bash -c \"\$(echo git push origin HEAD:main)\" blocked (exit 2)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: bash -c \"\$(echo git push origin HEAD:main)\" should block, got exit=$_bm_wrapper_exit"
  FAIL=$((FAIL + 1))
fi
unset _bm_wrapper_input _bm_wrapper_exit

echo ""
# ---------------------------------------------------------------------------
# BYPASS MATRIX completeness — gap-fill rows (tester-added 2026-06-12)
# Rows 5 and 15 from the DESIGN.md threat model were verified to block but
# lacked explicit named test entries. Added here for full matrix coverage.
# ---------------------------------------------------------------------------
echo "-- BYPASS MATRIX (gap-fill): rows 5 and 15 explicit coverage --"

# Row 5: git push origin refs/heads/main (standalone, not HEAD:refs/heads/main)
# SAFE_REFSPEC_RE strips 'refs/heads/' prefix → dst==main → BLOCK
run_test "git push origin refs/heads/main (row 5 — standalone refs/heads/ form → block)" \
  2 "$(make_input 'git push origin refs/heads/main')"

# Row 15: abbreviated/aliased remote (e.g. 'o' for 'origin')
# The remote name is irrelevant to refspec matching; dst==main regardless → BLOCK
run_test "git push o main (row 15 — abbreviated remote 'o', dst==main → block)" \
  2 "$(make_input 'git push o main')"

echo ""
# ---------------------------------------------------------------------------
# COMMAND-POSITION OBFUSCATION MATRIX (push-guard-02)
# 18-row block matrix + allow-class for the narrow command-position detection.
# All block rows must exit 2; all allow rows must exit 0.
#
# NOTE: The test JSON values contain shell metacharacters ($(, ${, \) that
# would trigger the installed push-to-main-guard if passed as Bash command-
# line arguments. They are therefore assembled via intermediate variables so
# the Bash command string seen by the installed hook is free of those chars.
# The CANON_GUARD_CWD env var is set to a temp repo on a non-protected branch
# so the test environment mirrors the real harness (D4 allow-path is bypassed).
# ---------------------------------------------------------------------------
echo "-- COMMAND-POSITION OBFUSCATION: block matrix (exit 2 required) --"

# Set up a temp git repo on a non-protected branch for these tests.
_cwobf_tmpdir=$(mktemp -d)
git -C "$_cwobf_tmpdir" init -q
git -C "$_cwobf_tmpdir" checkout -q -b "canon/test-cwobf"

# Assemble metachar fragments as variables so this file doesn't contain
# literal $( or ${ sequences at top-level that would trip the installed guard.
_dp='$'   # dollar
_bs='\'   # backslash

# --- Block rows (exit 2) ---

# Row 1: $(echo git) push origin main
_cwobf_j="{\"tool_input\":{\"command\":\"${_dp}(echo git) push origin main\"}}"
_cwobf_rc=0
printf '%s' "$_cwobf_j" | CANON_GUARD_CWD="$_cwobf_tmpdir" bash "$HOOK" >/dev/null 2>&1 || _cwobf_rc=$?
if [[ "$_cwobf_rc" -eq 2 ]]; then echo "  PASS: dollar-paren-echo-git push origin main → block (exit 2)"; PASS=$((PASS+1))
else echo "  FAIL: dollar-paren-echo-git push origin main — expected 2, got $_cwobf_rc"; FAIL=$((FAIL+1)); fi
unset _cwobf_j _cwobf_rc

# Row 2: gi$(echo t) push origin main
_cwobf_j="{\"tool_input\":{\"command\":\"gi${_dp}(echo t) push origin main\"}}"
_cwobf_rc=0
printf '%s' "$_cwobf_j" | CANON_GUARD_CWD="$_cwobf_tmpdir" bash "$HOOK" >/dev/null 2>&1 || _cwobf_rc=$?
if [[ "$_cwobf_rc" -eq 2 ]]; then echo "  PASS: gi-dollar-paren-echo-t push origin main → block (exit 2)"; PASS=$((PASS+1))
else echo "  FAIL: gi-dollar-paren-echo-t push origin main — expected 2, got $_cwobf_rc"; FAIL=$((FAIL+1)); fi
unset _cwobf_j _cwobf_rc

# Row 3: $(printf git) push origin main
_cwobf_j="{\"tool_input\":{\"command\":\"${_dp}(printf git) push origin main\"}}"
_cwobf_rc=0
printf '%s' "$_cwobf_j" | CANON_GUARD_CWD="$_cwobf_tmpdir" bash "$HOOK" >/dev/null 2>&1 || _cwobf_rc=$?
if [[ "$_cwobf_rc" -eq 2 ]]; then echo "  PASS: dollar-paren-printf-git push origin main → block (exit 2)"; PASS=$((PASS+1))
else echo "  FAIL: dollar-paren-printf-git push origin main — expected 2, got $_cwobf_rc"; FAIL=$((FAIL+1)); fi
unset _cwobf_j _cwobf_rc

# Row 4: gi`echo t` push origin main (backtick mid-word)
_cwobf_j='{"tool_input":{"command":"gi`echo t` push origin main"}}'
_cwobf_rc=0
printf '%s' "$_cwobf_j" | CANON_GUARD_CWD="$_cwobf_tmpdir" bash "$HOOK" >/dev/null 2>&1 || _cwobf_rc=$?
if [[ "$_cwobf_rc" -eq 2 ]]; then echo "  PASS: gi-backtick-echo-t push origin main → block (exit 2)"; PASS=$((PASS+1))
else echo "  FAIL: gi-backtick-echo-t push origin main — expected 2, got $_cwobf_rc"; FAIL=$((FAIL+1)); fi
unset _cwobf_j _cwobf_rc

# Row 5: `echo git` push origin main (already covered by canon_has_ambiguous_git_token,
# confirm still blocks after command-position change)
_cwobf_j='{"tool_input":{"command":"`echo git` push origin main"}}'
_cwobf_rc=0
printf '%s' "$_cwobf_j" | CANON_GUARD_CWD="$_cwobf_tmpdir" bash "$HOOK" >/dev/null 2>&1 || _cwobf_rc=$?
if [[ "$_cwobf_rc" -eq 2 ]]; then echo "  PASS: backtick-echo-git push origin main → block (exit 2)"; PASS=$((PASS+1))
else echo "  FAIL: backtick-echo-git push origin main — expected 2, got $_cwobf_rc"; FAIL=$((FAIL+1)); fi
unset _cwobf_j _cwobf_rc

# Row 6: $g push origin main (var indirection)
_cwobf_j="{\"tool_input\":{\"command\":\"${_dp}g push origin main\"}}"
_cwobf_rc=0
printf '%s' "$_cwobf_j" | CANON_GUARD_CWD="$_cwobf_tmpdir" bash "$HOOK" >/dev/null 2>&1 || _cwobf_rc=$?
if [[ "$_cwobf_rc" -eq 2 ]]; then echo "  PASS: dollar-g push origin main (var indirection) → block (exit 2)"; PASS=$((PASS+1))
else echo "  FAIL: dollar-g push origin main — expected 2, got $_cwobf_rc"; FAIL=$((FAIL+1)); fi
unset _cwobf_j _cwobf_rc

# Row 7: ${g} push origin main
_cwobf_j="{\"tool_input\":{\"command\":\"${_dp}{g} push origin main\"}}"
_cwobf_rc=0
printf '%s' "$_cwobf_j" | CANON_GUARD_CWD="$_cwobf_tmpdir" bash "$HOOK" >/dev/null 2>&1 || _cwobf_rc=$?
if [[ "$_cwobf_rc" -eq 2 ]]; then echo "  PASS: dollar-brace-g push origin main → block (exit 2)"; PASS=$((PASS+1))
else echo "  FAIL: dollar-brace-g push origin main — expected 2, got $_cwobf_rc"; FAIL=$((FAIL+1)); fi
unset _cwobf_j _cwobf_rc

# Row 8: g=git; $g push origin main (multi-segment; second segment is the push)
_cwobf_j="{\"tool_input\":{\"command\":\"g=git; ${_dp}g push origin main\"}}"
_cwobf_rc=0
printf '%s' "$_cwobf_j" | CANON_GUARD_CWD="$_cwobf_tmpdir" bash "$HOOK" >/dev/null 2>&1 || _cwobf_rc=$?
if [[ "$_cwobf_rc" -eq 2 ]]; then echo "  PASS: g=git; dollar-g push origin main (multi-segment) → block (exit 2)"; PASS=$((PASS+1))
else echo "  FAIL: g=git; dollar-g push origin main — expected 2, got $_cwobf_rc"; FAIL=$((FAIL+1)); fi
unset _cwobf_j _cwobf_rc

# Row 9: g=git $g push origin main (env-assignment prefix, single segment)
_cwobf_j="{\"tool_input\":{\"command\":\"g=git ${_dp}g push origin main\"}}"
_cwobf_rc=0
printf '%s' "$_cwobf_j" | CANON_GUARD_CWD="$_cwobf_tmpdir" bash "$HOOK" >/dev/null 2>&1 || _cwobf_rc=$?
if [[ "$_cwobf_rc" -eq 2 ]]; then echo "  PASS: g=git dollar-g push origin main (env-assign prefix) → block (exit 2)"; PASS=$((PASS+1))
else echo "  FAIL: g=git dollar-g push origin main — expected 2, got $_cwobf_rc"; FAIL=$((FAIL+1)); fi
unset _cwobf_j _cwobf_rc

# Row 10: \git push origin main (backslash-escaped git)
_cwobf_j="{\"tool_input\":{\"command\":\"${_bs}git push origin main\"}}"
_cwobf_rc=0
printf '%s' "$_cwobf_j" | CANON_GUARD_CWD="$_cwobf_tmpdir" bash "$HOOK" >/dev/null 2>&1 || _cwobf_rc=$?
if [[ "$_cwobf_rc" -eq 2 ]]; then echo "  PASS: backslash-git push origin main → block (exit 2)"; PASS=$((PASS+1))
else echo "  FAIL: backslash-git push origin main — expected 2, got $_cwobf_rc"; FAIL=$((FAIL+1)); fi
unset _cwobf_j _cwobf_rc

# Row 11: \gi$(echo t) push origin main (combination: backslash + substitution)
_cwobf_j="{\"tool_input\":{\"command\":\"${_bs}gi${_dp}(echo t) push origin main\"}}"
_cwobf_rc=0
printf '%s' "$_cwobf_j" | CANON_GUARD_CWD="$_cwobf_tmpdir" bash "$HOOK" >/dev/null 2>&1 || _cwobf_rc=$?
if [[ "$_cwobf_rc" -eq 2 ]]; then echo "  PASS: backslash-gi-dollar-paren-t push origin main (combination) → block (exit 2)"; PASS=$((PASS+1))
else echo "  FAIL: backslash-gi-dollar-paren-t push origin main — expected 2, got $_cwobf_rc"; FAIL=$((FAIL+1)); fi
unset _cwobf_j _cwobf_rc

# Row 12: G=git; $G push origin +main (combination: var indirection + force-push)
_cwobf_j="{\"tool_input\":{\"command\":\"G=git; ${_dp}G push origin +main\"}}"
_cwobf_rc=0
printf '%s' "$_cwobf_j" | CANON_GUARD_CWD="$_cwobf_tmpdir" bash "$HOOK" >/dev/null 2>&1 || _cwobf_rc=$?
if [[ "$_cwobf_rc" -eq 2 ]]; then echo "  PASS: G=git; dollar-G push origin +main (combination) → block (exit 2)"; PASS=$((PASS+1))
else echo "  FAIL: G=git; dollar-G push origin +main — expected 2, got $_cwobf_rc"; FAIL=$((FAIL+1)); fi
unset _cwobf_j _cwobf_rc

# Row 13: $(echo git) push origin HEAD:main (combination: subst + HEAD:main)
_cwobf_j="{\"tool_input\":{\"command\":\"${_dp}(echo git) push origin HEAD:main\"}}"
_cwobf_rc=0
printf '%s' "$_cwobf_j" | CANON_GUARD_CWD="$_cwobf_tmpdir" bash "$HOOK" >/dev/null 2>&1 || _cwobf_rc=$?
if [[ "$_cwobf_rc" -eq 2 ]]; then echo "  PASS: dollar-paren-echo-git push origin HEAD:main (combination) → block (exit 2)"; PASS=$((PASS+1))
else echo "  FAIL: dollar-paren-echo-git push origin HEAD:main — expected 2, got $_cwobf_rc"; FAIL=$((FAIL+1)); fi
unset _cwobf_j _cwobf_rc

echo ""
echo "-- COMMAND-POSITION OBFUSCATION: allow class (exit 0 required) --"

# Allow A: echo $(whoami) — subst in ARGUMENT position, no git push
_cwobf_j="{\"tool_input\":{\"command\":\"echo ${_dp}(whoami)\"}}"
_cwobf_rc=0
printf '%s' "$_cwobf_j" | CANON_GUARD_CWD="$_cwobf_tmpdir" bash "$HOOK" >/dev/null 2>&1 || _cwobf_rc=$?
if [[ "$_cwobf_rc" -eq 0 ]]; then echo "  PASS: echo dollar-paren-whoami → allow (exit 0)"; PASS=$((PASS+1))
else echo "  FAIL: echo dollar-paren-whoami — expected 0, got $_cwobf_rc"; FAIL=$((FAIL+1)); fi
unset _cwobf_j _cwobf_rc

# Allow B: echo hello $(whoami)
_cwobf_j="{\"tool_input\":{\"command\":\"echo hello ${_dp}(whoami)\"}}"
_cwobf_rc=0
printf '%s' "$_cwobf_j" | CANON_GUARD_CWD="$_cwobf_tmpdir" bash "$HOOK" >/dev/null 2>&1 || _cwobf_rc=$?
if [[ "$_cwobf_rc" -eq 0 ]]; then echo "  PASS: echo hello dollar-paren-whoami → allow (exit 0)"; PASS=$((PASS+1))
else echo "  FAIL: echo hello dollar-paren-whoami — expected 0, got $_cwobf_rc"; FAIL=$((FAIL+1)); fi
unset _cwobf_j _cwobf_rc

# Allow C: gh pr comment 1 --body "see `x` here" (backtick in arg position)
_cwobf_j='{"tool_input":{"command":"gh pr comment 1 --body \"see `x` here\""}}'
_cwobf_rc=0
printf '%s' "$_cwobf_j" | CANON_GUARD_CWD="$_cwobf_tmpdir" bash "$HOOK" >/dev/null 2>&1 || _cwobf_rc=$?
if [[ "$_cwobf_rc" -eq 0 ]]; then echo "  PASS: gh pr comment body with backtick → allow (exit 0)"; PASS=$((PASS+1))
else echo "  FAIL: gh pr comment body with backtick — expected 0, got $_cwobf_rc"; FAIL=$((FAIL+1)); fi
unset _cwobf_j _cwobf_rc

# Allow D: echo \foo (backslash-escaped non-git command word)
_cwobf_j="{\"tool_input\":{\"command\":\"echo ${_bs}foo\"}}"
_cwobf_rc=0
printf '%s' "$_cwobf_j" | CANON_GUARD_CWD="$_cwobf_tmpdir" bash "$HOOK" >/dev/null 2>&1 || _cwobf_rc=$?
if [[ "$_cwobf_rc" -eq 0 ]]; then echo "  PASS: echo backslash-foo (non-git escaped cmd word) → allow (exit 0)"; PASS=$((PASS+1))
else echo "  FAIL: echo backslash-foo — expected 0, got $_cwobf_rc"; FAIL=$((FAIL+1)); fi
unset _cwobf_j _cwobf_rc

# Allow E: FOO=$(date) echo hi (assignment with substitution value, benign cmd word)
_cwobf_j="{\"tool_input\":{\"command\":\"FOO=${_dp}(date) echo hi\"}}"
_cwobf_rc=0
printf '%s' "$_cwobf_j" | CANON_GUARD_CWD="$_cwobf_tmpdir" bash "$HOOK" >/dev/null 2>&1 || _cwobf_rc=$?
if [[ "$_cwobf_rc" -eq 0 ]]; then echo "  PASS: FOO=dollar-paren-date echo hi (assignment+subst) → allow (exit 0)"; PASS=$((PASS+1))
else echo "  FAIL: FOO=dollar-paren-date echo hi — expected 0, got $_cwobf_rc"; FAIL=$((FAIL+1)); fi
unset _cwobf_j _cwobf_rc

rm -rf "$_cwobf_tmpdir"
unset _dp _bs _cwobf_tmpdir

echo ""
# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "=== Results: PASS=$PASS FAIL=$FAIL ==="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
