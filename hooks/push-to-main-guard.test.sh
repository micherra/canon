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
# bash 3.2 set -u regression: empty array expansion must not throw
# "unbound variable". In bash 3.2 (macOS default), "${arr[@]}" with an empty
# array throws "arr[@]: unbound variable" when set -u is active. The fix is
# the ${arr[@]+"${arr[@]}"} (+‑guard) idiom applied to every git invocation
# that passes a potentially-empty array of -C flags or HEAD-resolution args.
# These tests run the hook through /bin/bash (3.2 on macOS) and verify that:
#   (a) a normal block-case still exits 2 (not a set -u crash),
#   (b) a normal allow-case still exits 0 (not a set -u crash),
#   (c) a bare push with no repo cwd (empty git_dir_args) still exits 2.
# In all three cases exit code 1 would indicate a bash 3.2 set -u crash
# rather than the expected policy decision.
# ---------------------------------------------------------------------------
echo "-- bash 3.2 set -u: empty-array guard (${arr[@]+...} idiom) must not crash --"

# (a) block-case: git push origin main → must exit 2, NOT 1 (set -u crash)
_exit_bash32_block=0
printf '{"command":"git push origin main"}' \
  | /bin/bash "$HOOK" >/dev/null 2>&1 || _exit_bash32_block=$?
if [[ "$_exit_bash32_block" -eq 2 ]]; then
  echo "  PASS: bash 3.2 set-u guard — block-case still exits 2 (not a crash)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: bash 3.2 set-u guard — block-case got exit=$_exit_bash32_block (expected 2; exit 1 = unbound-variable crash)"
  FAIL=$((FAIL + 1))
fi

# (b) allow-case: git push origin feature → must exit 0, NOT 1
_exit_bash32_allow=0
printf '{"command":"git push origin feature"}' \
  | /bin/bash "$HOOK" >/dev/null 2>&1 || _exit_bash32_allow=$?
if [[ "$_exit_bash32_allow" -eq 0 ]]; then
  echo "  PASS: bash 3.2 set-u guard — allow-case still exits 0 (not a crash)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: bash 3.2 set-u guard — allow-case got exit=$_exit_bash32_allow (expected 0; exit 1 = unbound-variable crash)"
  FAIL=$((FAIL + 1))
fi

# (c) bare push from a scratch repo where HEAD is on main (git_dir_args is empty
# in the hook — no -C in the command; CANON_GUARD_CWD points to the scratch repo).
# resolve_protected_branch and bare_push_is_safe both receive empty git_dir_args,
# which previously triggered "arr[@]: unbound variable" in bash 3.2. With the
# +‑guard idiom they must not crash; the hook sees HEAD=main and must exit 2.
_TMPDIR_BASH32=$(mktemp -d)
setup_repo "$_TMPDIR_BASH32"
git -C "$_TMPDIR_BASH32" branch -m main
_exit_bash32_bare=0
printf '{"command":"git push"}' \
  | CANON_GUARD_CWD="$_TMPDIR_BASH32" /bin/bash "$HOOK" >/dev/null 2>&1 || _exit_bash32_bare=$?
rm -rf "$_TMPDIR_BASH32"
if [[ "$_exit_bash32_bare" -eq 2 ]]; then
  echo "  PASS: bash 3.2 set-u guard — bare-push from main (empty git_dir_args) exits 2 (not a crash)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: bash 3.2 set-u guard — bare-push got exit=$_exit_bash32_bare (expected 2; exit 1 = unbound-variable crash)"
  FAIL=$((FAIL + 1))
fi

echo ""
# ---------------------------------------------------------------------------
# watch_GGGGGGGG1 fix: PASSTHROUGH-set (false-positives now fixed — exit 0)
# Non-git, non-wrapper segments containing $(...) / backticks / pipes / redirects
# must pass through the hook without blocking (they cannot be a disguised git push).
# ---------------------------------------------------------------------------
echo "-- watch_GGGGGGGG1 FIX: non-git metachar commands must pass (should allow, exit 0) --"
# NOTE: commands containing $(...) / backticks / $ must NOT use make_input (which
# embeds the value in printf's format arg — shell expansion would fire or quoting
# would be wrong). Use printf directly with single-quote literals so the JSON
# payload reaches the hook literally without further shell interpretation.
_echo_date_input='{"command":"echo \"$(date)\""}'
run_test 'echo "$(date)" (command substitution — not git, must pass)' \
  0 "$_echo_date_input"
run_test 'grep -rn foo src | head -5 (pipe — not git, must pass)' \
  0 "$(make_input 'grep -rn foo src | head -5')"
run_test 'npm run build > /tmp/out.txt 2>&1 (redirect — not git, must pass)' \
  0 "$(make_input 'npm run build > /tmp/out.txt 2>&1')"
_ls_pwd_input='{"command":"ls $(pwd)"}'
run_test 'ls $(pwd) (command-sub arg to non-git cmd — must pass)' \
  0 "$_ls_pwd_input"
_printf_var_input='{"command":"printf \"%s\" \"$VAR\""}'
run_test 'printf "%s" "$VAR" (no git token — must pass)' \
  0 "$_printf_var_input"
_node_symlink_input='{"command":"node -e \"require('"'"'fs'"'"').symlinkSync(require('"'"'fs'"'"').realpathSync('"'"'/a'"'"'),'"'"'/b'"'"','"'"'dir'"'"')\""}'
run_test 'node -e symlinkSync(realpathSync(...)) (node symlink — must pass)' \
  0 "$_node_symlink_input"
# dc-03: VAR=val prefix + real cmd + arg-pos substitution must pass (no false positive)
_foo_ls_pwd_input='{"command":"FOO=bar ls $(pwd)"}'
run_test 'FOO=bar ls $(pwd) (VAR=val prefix + real cmd + arg-pos sub — must pass, dc-03)' \
  0 "$_foo_ls_pwd_input"

echo ""
# ---------------------------------------------------------------------------
# watch_GGGGGGGG1 NO-REGRESSION: obfuscated-push vector still blocked
# The disguised-push path (bash -c "$(echo git push ...)") must still exit 2.
# This is caught by the post-unwrap guard (inner_cmd starts with '$(' → block),
# NOT by the removed pre-git-token metachar scan.
# ---------------------------------------------------------------------------
echo "-- watch_GGGGGGGG1 NO-REGRESSION: obfuscated push still blocked (should block, exit 2) --"
run_test 'bash -c "$(echo git push origin main)" (cmd-sub inner — obfuscated, still blocked)' \
  2 "$(make_input 'bash -c "$(echo git push origin main)"')"
run_test 'git push origin main (direct push — unchanged, still blocked)' \
  2 "$(make_input 'git push origin main')"
run_test 'git push --all origin (push-everything — unchanged, still blocked)' \
  2 "$(make_input 'git push --all origin')"
# dc-01: command-NAME-position $(...) bypass — Codex P1 fix
# NOTE: payload contains $( literally — must NOT use make_input (shell would expand).
# Use direct printf with single-quote literals.
_echo_git_input='{"command":"$(echo git) push origin main"}'
run_test '$(echo git) push origin main (cmd-name-position $() bypass — must block, dc-01)' \
  2 "$_echo_git_input"
# dc-02: backtick command-name-position form (lock-in; already blocked incidentally via
# ambiguous-git-token, this test locks in the guarantee explicitly)
_backtick_git_input='{"command":"`echo git` push origin main"}'
run_test '`echo git` push origin main (cmd-name-position backtick — must block, dc-02)' \
  2 "$_backtick_git_input"
# dc-01 extended: VAR=val prefix before command-name-position substitution — still blocked
_foo_echo_git_input='{"command":"FOO=bar $(echo git) push origin main"}'
run_test 'FOO=bar $(echo git) push origin main (VAR=val prefix + cmd-name-pos $() — must block)' \
  2 "$_foo_echo_git_input"

echo ""
# ---------------------------------------------------------------------------
# UNBOUND-VAR: assert no "unbound variable" text on stderr (set -u safety)
# Both the git_dir_args and _gda_head arrays can be empty when no -C flag and
# no CANON_GUARD_CWD is set. The ${arr[@]+"${arr[@]}"} idiom must suppress the
# bash 3.2 "unbound variable" error that "${arr[@]}" produces on empty arrays.
# ---------------------------------------------------------------------------
echo "-- UNBOUND-VAR: no 'unbound variable' on stderr under set -u --"

_unbound_bare=$(printf '{"command":"git push"}' | bash "$HOOK" 2>&1 >/dev/null || true)
if printf '%s' "$_unbound_bare" | grep -q "unbound variable"; then
  echo "  FAIL: bare 'git push' produced 'unbound variable' on stderr"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: bare 'git push' — no 'unbound variable' on stderr"
  PASS=$((PASS + 1))
fi

_unbound_nonpush=$(printf '{"command":"echo \\"$(date)\\""}' | bash "$HOOK" 2>&1 >/dev/null || true)
if printf '%s' "$_unbound_nonpush" | grep -q "unbound variable"; then
  echo "  FAIL: non-git command produced 'unbound variable' on stderr"
  FAIL=$((FAIL + 1))
else
  echo "  PASS: non-git metachar command — no 'unbound variable' on stderr"
  PASS=$((PASS + 1))
fi

echo ""
# ---------------------------------------------------------------------------
# P1-SECURITY (CRITICAL): transparent-exec prefix + group-opener bypass
#
# These 8 payloads all pass the current guard (exit 0) but invoke
# `git push origin main` at runtime. After the normalization fix they MUST
# exit 2. Payloads contain $( literals — use direct printf/single-quotes,
# NOT make_input, so the JSON reaches the hook without shell expansion.
# ---------------------------------------------------------------------------
echo "-- P1-SECURITY: transparent-exec + group-opener bypass (must block, exit 2) --"

run_test 'env $(echo git) push origin main (transparent-exec — must block)' \
  2 '{"command":"env $(echo git) push origin main"}'

run_test 'command $(echo git) push origin main (transparent-exec — must block)' \
  2 '{"command":"command $(echo git) push origin main"}'

run_test 'exec $(echo git) push origin main (transparent-exec — must block)' \
  2 '{"command":"exec $(echo git) push origin main"}'

run_test 'nice $(echo git) push origin main (transparent-exec — must block)' \
  2 '{"command":"nice $(echo git) push origin main"}'

run_test 'timeout 5 $(echo git) push origin main (timeout+arg — must block)' \
  2 '{"command":"timeout 5 $(echo git) push origin main"}'

run_test 'stdbuf -o0 $(echo git) push origin main (stdbuf+flag — must block)' \
  2 '{"command":"stdbuf -o0 $(echo git) push origin main"}'

run_test '( $(echo git) push origin main ) (subshell group — must block)' \
  2 '{"command":"( $(echo git) push origin main )"}'

run_test '{ $(echo git) push origin main ; } (brace group — must block)' \
  2 '{"command":"{ $(echo git) push origin main ; }"}'

echo ""
# ---------------------------------------------------------------------------
# P1-SECURITY: FALSE-POSITIVE regression locks for transparent-exec fix
#
# These must stay exit 0 — they are inert commands (no git push) and must
# not be broken by the V2 span predicate (PR #386 V2, ADR-0012).
# ---------------------------------------------------------------------------
echo "-- P1-SECURITY PASSTHROUGH: false-positive regression locks (must pass, exit 0) --"

# ls $(pwd) — ordinary non-git cmd with arg-position substitution (clause-final → inert)
run_test 'ls $(pwd) (arg-pos sub behind real cmd — must stay exit 0)' \
  0 '{"command":"ls $(pwd)"}'

# a=$(echo git) push origin main — substitution is the assignment VALUE; command
# word is empty → runtime rc=127 (no push). Keep current behavior (not forced-blocked).
run_test 'a=$(echo git) push origin main (assignment value, empty cmd word — must stay exit 0)' \
  0 '{"command":"a=$(echo git) push origin main"}'

# ${x} push — parameter expansion (not cmd-sub); V2 does not touch it.
run_test '${x} push (param expansion, not cmd-sub — must stay exit 0)' \
  0 '{"command":"${x} push"}'

# "$(echo git)" push origin main — quoted form; already blocks via ambiguous-token
# path (SECURITY.md LOW finding). Keep blocked — this is a regression lock.
run_test '"$(echo git)" push origin main (quoted-cmdsub — already blocked via ambiguous-token, keep exit 2)' \
  2 '{"command":"\"$(echo git)\" push origin main"}'

# env non-git-cmd — transparent-exec prefix behind a real non-git command name
# must NOT be false-blocked (env only becomes dangerous when paired with cmd-sub).
run_test 'env ls /tmp (transparent-exec + real cmd, no cmd-sub — must stay exit 0)' \
  0 '{"command":"env ls /tmp"}'

# env VAR=val cmd — env with assignment prefix before a real literal command
run_test 'env FOO=bar ls /tmp (env + assignment + real cmd — must stay exit 0)' \
  0 '{"command":"env FOO=bar ls /tmp"}'

# stacked prefixes with real command — env command ls (no cmd-sub)
run_test 'env command ls /tmp (stacked prefixes + real cmd — must stay exit 0)' \
  0 '{"command":"env command ls /tmp"}'

echo ""
# ---------------------------------------------------------------------------
# V2 PREDICATE (ADR-0012): denylist-omitted wrapper BLOCK cases
#
# These were NOT blocked by the V1 denylist (nohup/time/setsid/ionice/taskset/
# chrt/unbuffer/doas/env -i) but ARE blocked by the V2 span-final predicate.
# The substitution is FOLLOWED BY further command tokens in every case → BLOCK.
# DEC-386-guard-v2-fail-closed-span: denylist-free, fail-closed on ambiguity.
# ---------------------------------------------------------------------------
echo "-- V2 PREDICATE: denylist-omitted wrappers BLOCK (exit 2) --"

run_test 'nohup $(echo git) push origin main (nohup — V2 blocks, exit 2)' \
  2 '{"command":"nohup $(echo git) push origin main"}'

run_test 'time $(echo git) push origin main (time — V2 blocks, exit 2)' \
  2 '{"command":"time $(echo git) push origin main"}'

run_test 'setsid $(echo git) push origin main (setsid — V2 blocks, exit 2)' \
  2 '{"command":"setsid $(echo git) push origin main"}'

run_test 'ionice $(echo git) push origin main (ionice — V2 blocks, exit 2)' \
  2 '{"command":"ionice $(echo git) push origin main"}'

run_test 'taskset -c 0 $(echo git) push origin main (taskset — V2 blocks, exit 2)' \
  2 '{"command":"taskset -c 0 $(echo git) push origin main"}'

run_test 'chrt -b 0 $(echo git) push origin main (chrt — V2 blocks, exit 2)' \
  2 '{"command":"chrt -b 0 $(echo git) push origin main"}'

run_test 'unbuffer $(echo git) push origin main (unbuffer — V2 blocks, exit 2)' \
  2 '{"command":"unbuffer $(echo git) push origin main"}'

run_test 'doas $(echo git) push origin main (doas — V2 blocks, exit 2)' \
  2 '{"command":"doas $(echo git) push origin main"}'

run_test 'env -i $(echo git) push origin main (env -i — V2 blocks, exit 2)' \
  2 '{"command":"env -i $(echo git) push origin main"}'

run_test 'env -i nohup $(echo git) push origin main (stacked env+nohup — V2 blocks, exit 2)' \
  2 '{"command":"env -i nohup $(echo git) push origin main"}'

echo ""
# ---------------------------------------------------------------------------
# V2 PREDICATE (ADR-0012): nested / complex forms
#
# A nested substitution like $(echo $(echo git)) also has a non-final sub-span
# (the outer span is followed by "push") → BLOCK.
# ---------------------------------------------------------------------------
echo "-- V2 PREDICATE: nested/complex BLOCK forms (exit 2) --"

run_test '$(echo $(echo git)) push origin main (nested sub — V2 blocks, exit 2)' \
  2 '{"command":"$(echo $(echo git)) push origin main"}'

echo ""
# ---------------------------------------------------------------------------
# V2 PREDICATE (ADR-0012): SACRIFICED FALSE-POSITIVE (intentional over-block)
#
# ln -s "$(realpath x)" mcp-server/node_modules — the substitution $(realpath x)
# is NOT clause-final (mcp-server/node_modules follows it) → V2 BLOCKS.
#
# Per DEC-386-guard-v2-fail-closed-span: this form is intentionally fail-closed.
# The motivating Canon command (worktree node_modules symlink) is created via
# TypeScript symlinkSync (init-workspace.ts), NOT shell ln; so no real Canon
# command path regresses. Any genuine need rewrites to put the substitution last
# or uses a VAR=$(…) assignment (which the V2 predicate skips).
#
# This test documents the sacrificed FP — do NOT revert it to exit 0 without
# re-opening the entire denylist-vs-span tradeoff (see ADR-0012).
# ---------------------------------------------------------------------------
echo "-- V2 PREDICATE: sacrificed false-positive is now BLOCK (exit 2) --"

run_test 'ln -s "$(realpath x)" mcp-server/node_modules (sacrificed FP — DEC-386 fail-closed, exit 2)' \
  2 '{"command":"ln -s \"$(realpath x)\" mcp-server/node_modules"}'

echo ""
# ---------------------------------------------------------------------------
# V2 PREDICATE (ADR-0012): ALLOW cases — substitution in clause-FINAL position
#
# These forms have the substitution as the LAST element of their clause.
# A clause-final substitution is inert (argument-position data, cannot forward
# to push argv) → ALLOW. This is the key watch_GGGGGGGG1 false-positive fix.
# ---------------------------------------------------------------------------
echo "-- V2 PREDICATE: clause-final substitution ALLOW cases (exit 0) --"

run_test 'ls $(pwd) (final sub — V2 allows, exit 0)' \
  0 '{"command":"ls $(pwd)"}'

run_test 'echo $(date) (final sub — V2 allows, exit 0)' \
  0 '{"command":"echo $(date)"}'

run_test 'cat $(ls foo) (final sub — V2 allows, exit 0)' \
  0 '{"command":"cat $(ls foo)"}'

run_test 'FOO=bar ls $(pwd) (assignment prefix + final sub — V2 allows, exit 0)' \
  0 '{"command":"FOO=bar ls $(pwd)"}'

echo ""
# ---------------------------------------------------------------------------
# R1 — GLUED command-substitution command-word bypass (must block, exit 2)
#
# A substitution glued to a literal prefix (gi$(echo t)) concatenates at runtime
# to `git`, then `push origin main` follows → real push. The V1 span-start test
# only matched substitutions that STARTED a token; a literal prefix defeated it.
# The R1 widening (CONTAINS-test) closes this. scanner-avoids-its-own-pattern:
# the trigger command word is assembled from fragments via printf, never written
# as a literal self-matching string.
# ---------------------------------------------------------------------------
echo "-- R1: glued command-substitution command-word (must block, exit 2) --"

# Assemble the glued forms from fragments (scanner-avoids-its-own-pattern).
_sub='$(echo '   # opens a command-substitution span
_glued_a="gi${_sub}t) push origin main"          # gi + sub + t)  → git push origin main
_glued_b="g${_sub}i)t push origin main"          # g  + sub + i)t → git push origin main
_glued_pfx="env gi${_sub}t) push origin main"    # transparent-exec prefix + glued
run_test 'gi$(echo t) push origin main (R1 glued cmdsub — must block, exit 2)' \
  2 "$(printf '{"command":"%s"}' "$_glued_a")"
run_test 'g$(echo i)t push origin main (R1 glued cmdsub — must block, exit 2)' \
  2 "$(printf '{"command":"%s"}' "$_glued_b")"
run_test 'env gi$(echo t) push origin main (R1 prefix-stacked glue — must block, exit 2)' \
  2 "$(printf '{"command":"%s"}' "$_glued_pfx")"

echo ""
# ---------------------------------------------------------------------------
# R1 — clause-final glued substitution stays ALLOW (false-positive lock, exit 0)
#
# echo hi$(whoami): the substitution-bearing token is itself the clause-final
# non-punctuation token (no further command token) → inert argument-position
# data → ALLOW. The R1 contains-test must preserve this.
# ---------------------------------------------------------------------------
echo "-- R1: clause-final glued substitution stays ALLOW (exit 0) --"

_hi="hi${_sub}whoami)"
run_test 'echo hi$(whoami) (R1 clause-final glued sub — must stay exit 0)' \
  0 "$(printf '{"command":"echo %s"}' "$_hi")"

echo ""
# ---------------------------------------------------------------------------
# R2 — BACKSLASH-escaped git command-word bypass (must block, exit 2)
#
# \git resolves to the real git binary (\ only suppresses alias/function lookup).
# The guard's no-git-token branch missed it: \git != git, not a wrapper, not an
# ambiguous git-prefixed token, carries no $( → fell through to ALLOW.
# R2 detects \git at command-word position, de-escapes, and reuses the existing
# push policy. JSON-escape: a single backslash in the command is "\\" in JSON.
# ---------------------------------------------------------------------------
echo "-- R2: backslash-escaped git command-word (must block, exit 2) --"

run_test '\git push origin main (R2 backslash-git — must block, exit 2)' \
  2 '{"command":"\\git push origin main"}'
run_test 'FOO=1 \git push origin main (R2 assignment + backslash-git — must block, exit 2)' \
  2 '{"command":"FOO=1 \\git push origin main"}'
# \git -C <main-repo> push origin main — backslash-git with a -C global option.
# Self-contained throwaway main repo (the space-path repos were already cleaned up).
TMPDIR_BSLASH_C=$(mktemp -d)
setup_repo "$TMPDIR_BSLASH_C"
git -C "$TMPDIR_BSLASH_C" branch -m main
_bslash_C_input="$(printf '{"command":"\\\\git -C %s push origin main"}' "$TMPDIR_BSLASH_C")"
_exit_bslash_C=0
echo "$_bslash_C_input" | CANON_GUARD_CWD="/home/user/project" bash "$HOOK" >/dev/null 2>&1 || _exit_bslash_C=$?
if [[ "$_exit_bslash_C" -eq 2 ]]; then
  echo "  PASS: \\git -C '<main repo>' push origin main (R2 backslash-git + -C — blocks, exit 2)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: \\git -C '<main repo>' push origin main should block, got exit=$_exit_bslash_C"
  FAIL=$((FAIL + 1))
fi
rm -rf "$TMPDIR_BSLASH_C"

echo ""
# ---------------------------------------------------------------------------
# R2 — DOUBLE-backslash empirical finding (documented harmless ALLOW, exit 0)
#
# EMPIRICAL (implement-step probe): bash quote-removal turns `\\git` into the
# literal command name `\git`, which is NOT a path → "command not found" at
# runtime — it never invokes real git. Confirmed: `\\git --version` →
# "\git: command not found". So the correct behavior is a documented HARMLESS
# ALLOW (exit 0), never a silent real-git ALLOW. R2 only de-escapes when the
# post-single-strip command word equals exactly `git`; `\\git` strips to `\git`
# (≠ git) → predicate false → ALLOW. This row locks that finding.
# ---------------------------------------------------------------------------
echo "-- R2: double-backslash \\\\git is a documented harmless ALLOW (exit 0) --"

run_test '\\git push origin main (R2 double-backslash — harmless: \\git not a real cmd, exit 0)' \
  0 '{"command":"\\\\git push origin main"}'

echo ""
# ---------------------------------------------------------------------------
# R2 — backslash false-positive locks (must stay ALLOW, exit 0)
#
# - echo \git push: \git is an ARGUMENT to echo, not the command word → ALLOW.
# - \echo hello: command word \echo normalises to echo (≠ git) → ALLOW.
# - \git status: backslash-git but subcommand is status (not push) → ALLOW.
# ---------------------------------------------------------------------------
echo "-- R2: backslash false-positive locks (must stay exit 0) --"

run_test 'echo \git push origin main (R2 backslash in arg position — must stay exit 0)' \
  0 '{"command":"echo \\git push origin main"}'
run_test '\echo hello (R2 backslash non-git command word — must stay exit 0)' \
  0 '{"command":"\\echo hello"}'
run_test '\git status (R2 backslash-git non-push subcommand — must stay exit 0)' \
  0 '{"command":"\\git status"}'

echo ""
# ---------------------------------------------------------------------------
# B1 — INTERIOR backslash-escaped git (security CRITICAL fix, must block, exit 2)
#
# bash collapses EVERY `\X`→`X` at runtime (pairwise), so `\g\it`, `g\it`,
# `\gi\t`, `gi\t`, `\g\i\t` all invoke the real git binary. The original R2
# predicate stripped only ONE leading backslash and required exact `==git`, so
# these interior forms fell through to ALLOW. The pairwise-collapse de-escaper
# (_p2m_deescaped_git) closes the class. JSON: one literal backslash = "\\".
# ---------------------------------------------------------------------------
echo "-- B1: interior backslash-escaped git (must block, exit 2) --"
run_test '\g\it push origin main (B1 interior — must block, exit 2)' \
  2 '{"command":"\\g\\it push origin main"}'
run_test 'g\it push origin main (B1 interior — must block, exit 2)' \
  2 '{"command":"g\\it push origin main"}'
run_test '\gi\t push origin main (B1 interior — must block, exit 2)' \
  2 '{"command":"\\gi\\t push origin main"}'
run_test 'gi\t push origin main (B1 interior — must block, exit 2)' \
  2 '{"command":"gi\\t push origin main"}'
run_test '\g\i\t push origin main (B1 fully-escaped — must block, exit 2)' \
  2 '{"command":"\\g\\i\\t push origin main"}'

echo ""
# ---------------------------------------------------------------------------
# B2 — ARGUMENT-BEARING transparent prefix + \git (security HIGH fix, exit 2)
#
# The original walker skipped exactly ONE prefix WORD but not its ARGS, landing
# on the prefix argument (5, -oL, -n 5, -i) as the "command word". The fixed
# walker enters prefix-mode on a recognised transparent prefix and scans ALL
# remaining tokens for an escaped-git command word (argument-arity-free). The
# non-escaped `timeout 5 git push` already blocks via the main path; this locks
# the escaped variants. `nice \git push` (no prefix arg) is a regression lock.
# ---------------------------------------------------------------------------
echo "-- B2: argument-bearing transparent prefix + \git (must block, exit 2) --"
run_test 'timeout 5 \git push origin main (B2 timeout+arg — must block, exit 2)' \
  2 '{"command":"timeout 5 \\git push origin main"}'
run_test 'stdbuf -oL \git push origin main (B2 stdbuf+flag — must block, exit 2)' \
  2 '{"command":"stdbuf -oL \\git push origin main"}'
run_test 'nice -n 5 \git push origin main (B2 nice+arg — must block, exit 2)' \
  2 '{"command":"nice -n 5 \\git push origin main"}'
run_test 'env -i \git push origin main (B2 env+flag — must block, exit 2)' \
  2 '{"command":"env -i \\git push origin main"}'
run_test 'timeout 5 git push origin main (B2 non-escaped regression lock — must block, exit 2)' \
  2 '{"command":"timeout 5 git push origin main"}'
run_test 'nice \git push origin main (B2 no-prefix-arg regression lock — must block, exit 2)' \
  2 '{"command":"nice \\git push origin main"}'

echo ""
# ---------------------------------------------------------------------------
# B3 — UPPERCASE backslash-escaped git on macOS case-insensitive FS (HIGH, exit 2)
#
# On the macOS default case-insensitive filesystem, `\GIT`/`\Git` resolve and run
# the real git binary. The de-escaper lowercases the command word before the
# `== git` comparison, so the escaped uppercase forms block. NOTE: the NON-escaped
# bare `GIT push` (uppercase, no backslash) is a SEPARATE pre-existing
# uppercase-git residual and is OUT OF SCOPE — only the escaped forms are covered.
# ---------------------------------------------------------------------------
echo "-- B3: uppercase backslash-escaped git (must block, exit 2) --"
run_test '\GIT push origin main (B3 uppercase escaped — must block, exit 2)' \
  2 '{"command":"\\GIT push origin main"}'
run_test '\Git push origin main (B3 mixed-case escaped — must block, exit 2)' \
  2 '{"command":"\\Git push origin main"}'

echo ""
# ---------------------------------------------------------------------------
# B4 — command-EXECUTING wrapper + \git command word (Codex P1, must block, 2)
#
# sudo/doas/time are command-EXECUTING wrappers that pass `git push ...` straight
# through to the real git binary, exactly like the non-escaped `sudo git push`
# form already blocked by canon_git_subcommand. The original walker only
# recognised the transparent-exec prefixes (env/command/exec/nohup/nice/timeout/
# stdbuf) and treated sudo/doas/time as ordinary non-prefix command words → the
# walk STOPPED at the wrapper and the escaped `\git` behind it fell through to
# ALLOW. These MUST block.
#   - sudo consumes its own flags before COMMAND
#   - doas consumes its own flags before COMMAND
#   - time is a shell keyword that prefixes a full command
# ---------------------------------------------------------------------------
echo "-- B4: command-executing wrapper + \git command word (must block, exit 2) --"
run_test 'sudo \git push origin main (B4 sudo wrapper — must block, exit 2)' \
  2 '{"command":"sudo \\git push origin main"}'
run_test 'doas \git push origin main (B4 doas wrapper — must block, exit 2)' \
  2 '{"command":"doas \\git push origin main"}'
run_test 'time \git push origin main (B4 time keyword — must block, exit 2)' \
  2 '{"command":"time \\git push origin main"}'
run_test 'sudo -u ci \git push origin main (B4 sudo+flag+arg — must block, exit 2)' \
  2 '{"command":"sudo -u ci \\git push origin main"}'

echo ""
# ---------------------------------------------------------------------------
# B5 — wrapper whose RESOLVED command word is a NON-git executable (P2, allow, 0)
#
# Once the wrapper's own options are consumed, the FIRST non-option token is the
# COMMAND. If that command resolves to a NON-git executable (echo), its remaining
# tokens are ARGUMENTS, not command words — so a later `\git` is argument data and
# must ALLOW. The original prefix-mode scanned ALL remaining tokens for an escaped
# git and wrongly blocked these.
#   - timeout 5 echo \git push : after DURATION `5`, command word is `echo` (≠git)
#   - env echo \git push       : after env's (zero) flags, command word is `echo`
# Regression-lock the genuine BLOCK that shares the interior shape:
#   - env command $(echo git) push : substitution command word → V2 span blocks
# ---------------------------------------------------------------------------
echo "-- B5: wrapper resolving to a non-git command word (must allow, exit 0) --"
run_test 'timeout 5 echo \git push origin main (B5 echo is cmd word — must allow, exit 0)' \
  0 '{"command":"timeout 5 echo \\git push origin main"}'
run_test 'env echo \git push origin main (B5 echo is cmd word — must allow, exit 0)' \
  0 '{"command":"env echo \\git push origin main"}'
run_test 'sudo systemctl restart nginx (B5 sudo non-git cmd — must allow, exit 0)' \
  0 '{"command":"sudo systemctl restart nginx"}'
run_test 'env command $(echo git) push origin main (B5 regression: sub cmd word — must block, exit 2)' \
  2 '{"command":"env command $(echo git) push origin main"}'

echo ""
# ---------------------------------------------------------------------------
# B6 — UNRECOGNIZED command-executing wrapper + \git → FAIL CLOSED (security, 2)
#
# The walker recognises only env/command/exec/nohup/nice/timeout/stdbuf/sudo/doas/
# time. ANY other leading word is an AMBIGUOUS passthrough-wrapper candidate
# (setsid, xargs, ionice, runuser, flock, chroot, unbuffer, taskset, caffeinate,
# torify, proxychains, watch, …) that forwards `\git push …` straight to real git.
# Treating an unrecognised word as a definitively-non-git command word and ALLOWing
# is fail-OPEN. Fix: when the resolved command word is UNKNOWN (not a recognised
# wrapper and not a known-safe terminal command), scan the remaining tokens of the
# clause — if any de-escapes to `git`, BLOCK. Over-blocking an unknown wrapper that
# happens to carry a `\git` argument is an ACCEPTED fail-closed false positive.
# The non-escaped forms (`setsid git push`) already block via canon_git_subcommand.
# ---------------------------------------------------------------------------
echo "-- B6: unrecognized wrapper + \git fails closed (must block, exit 2) --"
run_test 'setsid \git push origin main (B6 unrecognized wrapper — must block, exit 2)' \
  2 '{"command":"setsid \\git push origin main"}'
run_test 'xargs \git push origin main (B6 unrecognized wrapper — must block, exit 2)' \
  2 '{"command":"xargs \\git push origin main"}'
run_test 'ionice \git push origin main (B6 unrecognized wrapper — must block, exit 2)' \
  2 '{"command":"ionice \\git push origin main"}'
run_test 'runuser -u ci \git push origin main (B6 unrecognized wrapper+flag — must block, exit 2)' \
  2 '{"command":"runuser -u ci \\git push origin main"}'
run_test 'flock /tmp/x \git push origin main (B6 unrecognized wrapper+arg — must block, exit 2)' \
  2 '{"command":"flock /tmp/x \\git push origin main"}'
run_test 'setsid g\it push origin main (B6 unrecognized wrapper + interior-escape — must block, exit 2)' \
  2 '{"command":"setsid g\\it push origin main"}'
run_test 'env setsid \git push origin main (B6 stacked recognized+unrecognized — must block, exit 2)' \
  2 '{"command":"env setsid \\git push origin main"}'

echo ""
# ---------------------------------------------------------------------------
# B7 — clustered short-flag exposes \git as the command word (CRITICAL #2, 2)
#
# Real getopt parses `sudo -knu ci \git push` as `-k -n -u=ci` then command word
# `\git`. The walker matched value-consuming flags by EXACT token only (`-u`), so a
# clustered form (`-nu`, `-knu`) was treated as self-contained → its value operand
# (`ci`) became the "command word" → ALLOW, leaving `\git` at the real command-word
# slot. Fix: for sudo/doas, if a non-`=` dash cluster's LAST char is a value-
# consuming short flag, consume the next token as its value. Separated `sudo -u ci`
# already blocks (regression lock). `sudo -u \git push` ALLOWs (sudo parses \git as
# the -u username; command word `push` runs, no git push).
# ---------------------------------------------------------------------------
echo "-- B7: clustered short-flag exposes \git (must block, exit 2) --"
run_test 'sudo -nu ci \git push origin main (B7 clustered -nu — must block, exit 2)' \
  2 '{"command":"sudo -nu ci \\git push origin main"}'
run_test 'sudo -knu ci \git push origin main (B7 clustered -knu — must block, exit 2)' \
  2 '{"command":"sudo -knu ci \\git push origin main"}'
run_test 'sudo -u ci \git push origin main (B7 separated regression lock — must block, exit 2)' \
  2 '{"command":"sudo -u ci \\git push origin main"}'
run_test 'sudo -u \git push origin main (B7 -u consumes \git as username — must allow, exit 0)' \
  0 '{"command":"sudo -u \\git push origin main"}'
run_test 'sudo -- \git push origin main (B7 end-of-options then \git cmd word — must block, exit 2)' \
  2 '{"command":"sudo -- \\git push origin main"}'

echo ""
# ---------------------------------------------------------------------------
# B8 — timeout DURATION over-block (reviewer WARNING, must allow, exit 0)
#
# `timeout -k 1 echo \git push`: `-k 1` consumes `1`, then a blind DURATION counter
# consumed `echo` as the duration operand, leaving `\git` at command-word position →
# wrongly BLOCK. Fix: only count timeout's DURATION as a duration-SHAPED positional
# (^[0-9]+(\.[0-9]+)?[smhd]?$), so a non-numeric command word (`echo`) is never
# mistaken for DURATION. `--preserve-status` (no value) must likewise not strand the
# DURATION counter onto `echo`.
# ---------------------------------------------------------------------------
echo "-- B8: timeout flag + non-numeric command word must allow (exit 0) --"
run_test 'timeout -k 1 echo \git push origin main (B8 -k consumes dur, echo cmd word — must allow, exit 0)' \
  0 '{"command":"timeout -k 1 echo \\git push origin main"}'
run_test 'timeout --preserve-status echo \git push origin main (B8 flag then echo cmd word — must allow, exit 0)' \
  0 '{"command":"timeout --preserve-status echo \\git push origin main"}'
run_test 'timeout -k 1 \git push origin main (B8 regression: \git IS cmd word — must block, exit 2)' \
  2 '{"command":"timeout -k 1 \\git push origin main"}'

echo ""
# ---------------------------------------------------------------------------
# FP1 — assignment-prefix VALUE substitution must NOT over-block (must allow, 0)
#
# `a=$(echo git) push origin main`: the substitution is in the assignment VALUE;
# the command word is the bare `push` (command-not-found at runtime, no real git
# push) → must ALLOW. The R1 contains-test originally seeded a span from the
# assignment value and over-blocked. The FP1 fix scopes span-start detection to
# the COMMAND-WORD token (after skipping leading NAME=VALUE assignment prefixes).
# Regression lock: `FOO=bar $(echo git) push` (substitution IS the command word)
# must still BLOCK.
# ---------------------------------------------------------------------------
echo "-- FP1: assignment-value substitution must allow (exit 0) --"
run_test 'a=$(echo git) push origin main (FP1 assignment value — must allow, exit 0)' \
  0 '{"command":"a=$(echo git) push origin main"}'
run_test 'b=$(echo x) push origin main (FP1 assignment value — must allow, exit 0)' \
  0 '{"command":"b=$(echo x) push origin main"}'
run_test 'FOO=bar $(echo git) push origin main (FP1 regression lock: sub IS cmd word — must block, exit 2)' \
  2 '{"command":"FOO=bar $(echo git) push origin main"}'

echo ""
# ---------------------------------------------------------------------------
# B-class — genuine background-watchdog hang-check (forward progress, no hang)
#
# The pairwise-collapse de-escaper (char-walk) and the prefix-mode token scan
# must terminate on malformed inputs. Run the guard in the BACKGROUND with a
# separate watchdog (NOT a `timeout` wrapper — that produces spurious macOS
# stdin-EOF rc artifacts). Assert the guard process exits on its own before the
# watchdog fires. Fail-closed (exit 2) is acceptable; the assertion is "did not
# hang / was not killed by the watchdog".
# ---------------------------------------------------------------------------
echo "-- B-class: background-watchdog hang-check (must complete, not be killed) --"

_hang_inputs=(
  '{"command":"\\g\\it push origin \"main"}'
  '{"command":"gi\\t push origin main"}'
  '{"command":"timeout 5 \\g\\it push origin main"}'
  '{"command":"env -i \\git push origin '"'"'unterminated"}'
)
for _hi in "${_hang_inputs[@]}"; do
  printf '%s' "$_hi" > /tmp/p2m_hang.$$.json
  CANON_GUARD_CWD="/home/user/project" bash "$HOOK" < /tmp/p2m_hang.$$.json >/dev/null 2>&1 &
  _hpid=$!
  ( sleep 12; kill -9 "$_hpid" 2>/dev/null && touch /tmp/p2m_hang_killed.$$ ) &
  _wpid=$!
  wait "$_hpid" 2>/dev/null || true
  kill "$_wpid" 2>/dev/null || true
  wait "$_wpid" 2>/dev/null || true
  if [[ -f /tmp/p2m_hang_killed.$$ ]]; then
    echo "  FAIL: guard HUNG on malformed input (watchdog killed it): $_hi"
    FAIL=$((FAIL + 1))
    rm -f /tmp/p2m_hang_killed.$$
  else
    echo "  PASS: guard completed (no hang) on malformed input"
    PASS=$((PASS + 1))
  fi
  rm -f /tmp/p2m_hang.$$.json
done

echo ""
# ---------------------------------------------------------------------------
# R5 — termination / forward-progress (malformed inputs must NOT hang)
#
# The R1 widening and R2 prefix-skip loops must guarantee forward progress.
# A timeout wrapper around malformed inputs (unterminated cmdsub, unterminated
# quote) must return (exit != 124). Fail-closed (exit 2) is acceptable;
# the assertion is purely "did not hang".
# ---------------------------------------------------------------------------
echo "-- R5: malformed inputs return within timeout (no hang, exit != 124) --"

_unterm_sub="gi${_sub}t push origin main"   # unterminated $(  (no closing paren)
_term_rc=0
printf '{"command":"%s"}' "$_unterm_sub" | CANON_GUARD_CWD="/home/user/project" timeout 5 bash "$HOOK" >/dev/null 2>&1 || _term_rc=$?
if [[ "$_term_rc" -ne 124 ]]; then
  echo "  PASS: unterminated command-substitution returns within timeout (exit=$_term_rc, no hang)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: unterminated command-substitution HUNG (exit=124)"
  FAIL=$((FAIL + 1))
fi

_term_rc2=0
printf '{"command":"echo %sunterminated quote"}' "'" | CANON_GUARD_CWD="/home/user/project" timeout 5 bash "$HOOK" >/dev/null 2>&1 || _term_rc2=$?
if [[ "$_term_rc2" -ne 124 ]]; then
  echo "  PASS: unterminated single-quote returns within timeout (exit=$_term_rc2, no hang)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: unterminated single-quote HUNG (exit=124)"
  FAIL=$((FAIL + 1))
fi

echo ""
# ---------------------------------------------------------------------------
# watch_GGGGGGGGGG3 fix: redirect / pipe shell-syntax tokens must NOT be
# treated as refspecs (AC1: false-positive fix) and main must STILL block
# when wrapped with redirects/pipes (AC2: no bypass).
#
# The bug: when a command is piped (`git push ... 2>&1 | tail`), the guard
# segments on `|`, leaving `2>&1` attached to the push segment. canon_tokenize
# emits `2>&1` as a bare word — it is not `-*`, so the parser treats it as a
# positional. After `remote_seen=true` it lands in refspecs[]. `SAFE_REFSPEC_RE`
# rejects `2>&1` → false-positive block of a legitimate non-main push.
#
# The fix: strip redirect-shaped tokens (`^[0-9]*>>?&?[0-9/dev/null]*$`,
# `^&>`, etc.) from the token stream inside push_updates_protected_branch
# BEFORE the refspec loop.  After stripping, remaining tokens are still fully
# refspec-checked (AC3: fail-closed preserved).
# ---------------------------------------------------------------------------
echo "-- watch_GGGGGGGGGG3 AC1: redirect tokens must NOT block a non-main push (should allow, exit 0) --"

# Core production incident form: git push ... 2>&1 | tail
# The guard sees the segment before `|` which still has `2>&1` in it.
# Simulate: feed only the pre-pipe segment as the command.
run_test 'git push origin HEAD:canon/some-branch 2>&1 (AC1 core form — should allow)' \
  0 "$(make_input 'git push origin HEAD:canon/some-branch 2>&1')"

# Additional output-redirect forms
run_test 'git push origin HEAD:canon/foo >file.log (stdout redirect — allow)' \
  0 "$(make_input 'git push origin HEAD:canon/foo >file.log')"
run_test 'git push origin HEAD:canon/foo 2>/dev/null (stderr to devnull — allow)' \
  0 "$(make_input 'git push origin HEAD:canon/foo 2>/dev/null')"
run_test 'git push origin HEAD:canon/foo &>/dev/null (combined redirect — allow)' \
  0 "$(make_input 'git push origin HEAD:canon/foo &>/dev/null')"
run_test 'git push origin HEAD:canon/foo >>out.log (append redirect — allow)' \
  0 "$(make_input 'git push origin HEAD:canon/foo >>out.log')"
run_test 'git push origin HEAD:canon/foo 1>&2 (stdout to stderr — allow)' \
  0 "$(make_input 'git push origin HEAD:canon/foo 1>&2')"
run_test 'git push origin HEAD:canon/foo 2>&1 1>/dev/null (chained redirects — allow)' \
  0 "$(make_input 'git push origin HEAD:canon/foo 2>&1 1>/dev/null')"
# Full pipeline: the segmentor splits on `|`, but we also want the combined form
run_test 'git push origin HEAD:canon/foo 2>&1 | tail -5 (full pipeline — post-pipe tail is inert)' \
  0 "$(make_input 'git push origin HEAD:canon/foo 2>&1 | tail -5')"

# Input-redirect forms (AC1 extension — input redirects must also be stripped)
run_test 'git push origin HEAD:canon/foo <somefile (input redirect — allow)' \
  0 "$(make_input 'git push origin HEAD:canon/foo <somefile')"
run_test 'git push origin HEAD:canon/foo 0<x (fd0 input redirect — allow)' \
  0 "$(make_input 'git push origin HEAD:canon/foo 0<x')"
run_test 'git push origin HEAD:canon/foo <<EOF (heredoc redirect token — allow)' \
  0 "$(make_input 'git push origin HEAD:canon/foo <<EOF')"
run_test 'git push origin HEAD:canon/foo <<<word (here-string redirect — allow)' \
  0 "$(make_input 'git push origin HEAD:canon/foo <<<word')"

echo ""
echo "-- watch_GGGGGGGGGG3 AC2: main push STILL BLOCKED even with redirects (should block, exit 2) --"

# AC2 (critical): stripping redirect tokens must not create a bypass for main.
# Every form below must still exit 2.
run_test 'git push origin HEAD:main 2>&1 (AC2 main with redirect — must block)' \
  2 "$(make_input 'git push origin HEAD:main 2>&1')"
run_test 'git push origin main >/dev/null (AC2 main with stdout redirect — must block)' \
  2 "$(make_input 'git push origin main >/dev/null')"
run_test 'git push origin main 2>/dev/null (AC2 main with stderr redirect — must block)' \
  2 "$(make_input 'git push origin main 2>/dev/null')"
run_test 'git push origin main &>/dev/null (AC2 combined redirect — must block)' \
  2 "$(make_input 'git push origin main &>/dev/null')"
run_test 'git push origin HEAD:main >>log.txt (AC2 main + append redirect — must block)' \
  2 "$(make_input 'git push origin HEAD:main >>log.txt')"
# Piped main push: `git push origin HEAD:main 2>&1 | tail`
# After segmentation the first segment is `git push origin HEAD:main 2>&1`.
run_test 'git push origin HEAD:main 2>&1 | tail (AC2 piped main — must block)' \
  2 "$(make_input 'git push origin HEAD:main 2>&1 | tail')"
# Bare push with redirect (no refspec — bare_push_is_safe path; CANON_GUARD_CWD is /home/user/project which is non-repo → block)
run_test 'git push 2>&1 (AC2 bare push + redirect, non-repo cwd — must block)' \
  2 "$(make_input 'git push 2>&1')"
# Input-redirect + main (AC2 extension — input redirect must NOT open a bypass)
run_test 'git push origin HEAD:main <somefile (AC2 main + input redirect — must block)' \
  2 "$(make_input 'git push origin HEAD:main <somefile')"
run_test 'git push origin main 0<x (AC2 main + fd0 input redirect — must block)' \
  2 "$(make_input 'git push origin main 0<x')"
# Reviewer-noted missing AC2 explicit cases (refs/heads/ prefix and force-push form)
run_test 'git push origin refs/heads/main 2>&1 (AC2 refs/heads/ form + redirect — must block)' \
  2 "$(make_input 'git push origin refs/heads/main 2>&1')"
run_test 'git push origin +main 2>&1 (AC2 force-push +main + redirect — must block)' \
  2 "$(make_input 'git push origin +main 2>&1')"

echo ""
echo "-- watch_GGGGGGGGGG3 AC3: genuinely non-literal refspecs still fail-closed (should block, exit 2) --"

# Confirm fail-closed is not weakened: a token that looks like a redirect but
# could also be a real non-provably-literal refspec must still be rejected.
# The redirect strip ONLY removes tokens matching the redirect regex; any
# leftover non-literal tokens still hit SAFE_REFSPEC_RE and block.
run_test 'git push origin HEAD:${BRANCH} 2>&1 (AC3 variable refspec survives redirect strip — must block)' \
  2 "$(make_input 'git push origin HEAD:${BRANCH} 2>&1')"
run_test 'git push origin HEAD:$(echo main) (AC3 cmd-sub refspec — must block)' \
  2 "$(make_input 'git push origin HEAD:$(echo main)')"

echo ""
# ---------------------------------------------------------------------------
# Separated-redirect bypass (Codex P1 on PR #409): a STANDALONE redirect
# operator token (`>`, `>>`, `<`, `2>`, `&>`, etc.) leaves its TARGET filename
# as a separate token. The prior strip skipped only the operator and let the
# target ('log') flow on as a refspec — converting a BARE push to origin
# (which must take the bare_push_is_safe path) into a safe-looking explicit
# refspec push to 'log', allowing a redirected direct push to main.
# The fix consumes the target token after a standalone operator.
# ---------------------------------------------------------------------------
echo "-- Separated-redirect AC1: target filename must NOT be misread as a refspec (feature branch → allow) --"

# On a non-protected branch a bare push with a SEPARATED redirect must stay
# allowed AND must not parse the target ('log'/'out.txt'/'err'/'in') as a refspec.
TMPDIR_SEPRD=$(mktemp -d)
setup_repo "$TMPDIR_SEPRD"
git -C "$TMPDIR_SEPRD" checkout -q -b canon/sep-redir 2>/dev/null || true

run_test 'git push origin > log (separated stdout redirect, feature branch → allow)' \
  0 "$(make_input 'git push origin > log')" "$TMPDIR_SEPRD"
run_test 'git push origin >> out.txt (separated append redirect, feature branch → allow)' \
  0 "$(make_input 'git push origin >> out.txt')" "$TMPDIR_SEPRD"
run_test 'git push origin 2> err (separated fd2 redirect, feature branch → allow)' \
  0 "$(make_input 'git push origin 2> err')" "$TMPDIR_SEPRD"
run_test 'git push origin < in (separated input redirect, feature branch → allow)' \
  0 "$(make_input 'git push origin < in')" "$TMPDIR_SEPRD"
run_test 'git push origin &> log (separated combined redirect, feature branch → allow)' \
  0 "$(make_input 'git push origin &> log')" "$TMPDIR_SEPRD"

rm -rf "$TMPDIR_SEPRD"

echo ""
echo "-- Separated-redirect AC2 (the bug): a bare push that MUST block stays blocked with a separated redirect (should block, exit 2) --"

# Bare push, non-repo cwd (default /home/user/project) → unresolvable → BLOCK.
# With the bug, 'log' was read as an explicit refspec → fail-OPEN allow.
run_test 'git push origin > log (separated redirect, non-repo cwd → must block)' \
  2 "$(make_input 'git push origin > log')"
run_test 'git push origin 2>&1 > log (glued+separated redirects, non-repo cwd → must block)' \
  2 "$(make_input 'git push origin 2>&1 > log')"
run_test 'git push origin >> out.txt (separated append, non-repo cwd → must block)' \
  2 "$(make_input 'git push origin >> out.txt')"
run_test 'git push origin 2> err (separated fd2, non-repo cwd → must block)' \
  2 "$(make_input 'git push origin 2> err')"
run_test 'git push origin < in (separated input, non-repo cwd → must block)' \
  2 "$(make_input 'git push origin < in')"
# --mirror pushes every ref incl. main; a separated redirect must not smuggle past it.
run_test 'git push --mirror origin > log (separated redirect on --mirror → must block)' \
  2 "$(make_input 'git push --mirror origin > log')"

# Bare push from a real main checkout with a separated redirect must still block.
TMPDIR_SEPRD_MAIN=$(mktemp -d)
setup_repo "$TMPDIR_SEPRD_MAIN"
run_test 'git push origin > log from main checkout (separated redirect → must block)' \
  2 "$(make_input 'git push origin > log')" "$TMPDIR_SEPRD_MAIN"
rm -rf "$TMPDIR_SEPRD_MAIN"

echo ""
echo "-- Separated-redirect AC3 (fail-closed): an explicit protected refspec with a separated redirect still blocks (should block, exit 2) --"

# 'main' is a real refspec; only 'log' is the redirect target. The consumed
# token must NEVER be a protected refspec.
run_test 'git push origin main > log (explicit main + separated redirect → must block)' \
  2 "$(make_input 'git push origin main > log')"
run_test 'git push origin HEAD:main > log (explicit HEAD:main + separated redirect → must block)' \
  2 "$(make_input 'git push origin HEAD:main > log')"
run_test 'git push origin +main >> out.txt (force +main + separated append → must block)' \
  2 "$(make_input 'git push origin +main >> out.txt')"

echo ""
# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "=== Results: PASS=$PASS FAIL=$FAIL ==="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
