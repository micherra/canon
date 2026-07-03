#!/bin/bash
# Tests for scribe-scope-guard.sh
# Run with: bash hooks/scribe-scope-guard.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures
#
# All tests use isolated temp git repos. No hard-coded paths; safe for CI.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$SCRIPT_DIR/scribe-scope-guard.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

MASTER_TMP=$(mktemp -d)
trap 'rm -rf "$MASTER_TMP"' EXIT

# run_guard <description> <expected_exit> <repo_dir> <base_commit> [threshold]
# Runs the scribe-scope-guard in <repo_dir> with positional args.
# The guard takes <base_commit> [threshold] positionally, NOT stdin JSON.
run_guard() {
  local description="$1"
  local expected_exit="$2"
  local repo_dir="$3"
  local base_commit="$4"
  local threshold="${5:-5}"

  local actual_exit=0
  (cd "$repo_dir" && bash "$GUARD" "$base_commit" "$threshold" >/dev/null 2>&1) || actual_exit=$?

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

# run_guard_raw <description> <expected_exit> <repo_dir> [args...]
# Passes all args after repo_dir verbatim to the guard (e.g. for missing-arg cases).
run_guard_raw() {
  local description="$1"
  local expected_exit="$2"
  local repo_dir="$3"
  shift 3

  local actual_exit=0
  (cd "$repo_dir" && bash "$GUARD" "$@" >/dev/null 2>&1) || actual_exit=$?

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

# init_repo <dir>
# Creates a minimal git repo with a single initial commit.
init_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" config user.email "test@example.com"
  git -C "$dir" config user.name "Test User"
  git -C "$dir" config commit.gpgsign false
  echo "placeholder" > "$dir/README.md"
  git -C "$dir" add README.md
  git -C "$dir" commit -q -m "init"
}

# write_claude_md <dir> <line_count>
# Writes a CLAUDE.md with <line_count> numbered lines to <dir>/CLAUDE.md.
write_claude_md() {
  local dir="$1"
  local count="$2"
  local i
  : > "$dir/CLAUDE.md"
  for ((i = 1; i <= count; i++)); do
    echo "Line $i" >> "$dir/CLAUDE.md"
  done
}

# trim_claude_md <dir> <keep_lines>
# Truncates CLAUDE.md in <dir> to <keep_lines> lines (simulating line deletions).
trim_claude_md() {
  local dir="$1"
  local keep="$2"
  local tmpf
  tmpf=$(mktemp)
  head -"$keep" "$dir/CLAUDE.md" > "$tmpf"
  mv "$tmpf" "$dir/CLAUDE.md"
}

# commit_engineer <dir> [message]
# Stages CLAUDE.md and commits with no scribe trailer.
commit_engineer() {
  local dir="$1"
  local msg="${2:-refactor: engineer edit}"
  git -C "$dir" add CLAUDE.md
  git -C "$dir" commit -q -m "$msg"
}

# commit_scribe <dir>
# Stages CLAUDE.md and commits with the Canon-Agent: scribe trailer.
commit_scribe() {
  local dir="$1"
  git -C "$dir" add CLAUDE.md
  git -C "$dir" commit -q -m "$(printf 'docs(context-sync): sync\n\nCanon-Agent: scribe\nCanon-State: context-sync')"
}

echo ""
echo "=== scribe-scope-guard.sh tests ==="
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Argument-validation cases (fail-closed, exit 2)
# ─────────────────────────────────────────────────────────────────────────────
echo "-- Argument validation --"

ARGVAL_REPO="$MASTER_TMP/argval"
init_repo "$ARGVAL_REPO"
ARGVAL_BASE=$(git -C "$ARGVAL_REPO" rev-parse HEAD)

run_guard_raw "missing base_commit → exit 2" 2 "$ARGVAL_REPO"
run_guard_raw "bad threshold (non-integer) → exit 2" 2 "$ARGVAL_REPO" "$ARGVAL_BASE" "abc"
run_guard_raw "invalid base commit → exit 2" 2 "$ARGVAL_REPO" "deadbeef12345678deadbeef12345678deadbeef"

# ─────────────────────────────────────────────────────────────────────────────
# Case 1: paired-reword PASS
# engineer deletes 9 CLAUDE.md lines (no scribe trailer)
# scribe deletes 5 CLAUDE.md lines (Canon-Agent: scribe trailer)
# threshold 5 → guard counts only the scribe's 5 deletions → 5 ≤ 5 → exit 0
#
# TDD: this case FAILS (exit 2) against the old cumulative-range guard because
# it counts all 14 deletions (9 engineer + 5 scribe) and 14 > 5.
# After the fix, only the scribe's 5 are counted → exit 0 (GREEN).
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 1: paired-reword PASS --"

CASE1_REPO="$MASTER_TMP/case1"
init_repo "$CASE1_REPO"

write_claude_md "$CASE1_REPO" 25
commit_engineer "$CASE1_REPO" "docs: initial CLAUDE.md"
CASE1_BASE=$(git -C "$CASE1_REPO" rev-parse HEAD)

# Engineer commit: delete 9 lines (25 → 16); no scribe trailer
trim_claude_md "$CASE1_REPO" 16
commit_engineer "$CASE1_REPO"

# Scribe commit: delete 5 lines (16 → 11)
trim_claude_md "$CASE1_REPO" 11
commit_scribe "$CASE1_REPO"

run_guard "paired-reword: engineer 9 del + scribe 5 del, threshold 5 → exit 0" 0 "$CASE1_REPO" "$CASE1_BASE" "5"

# ─────────────────────────────────────────────────────────────────────────────
# Case 2: compound-inflation PASS
# engineer deletes lines, a mid-build commit also touches CLAUDE.md,
# then the scribe deletes ≤ threshold lines — guard should pass
#
# TDD: this case FAILS under the old guard (cumulative sum > threshold).
# After fix, only the scribe's 3 deletions are counted → exit 0 (GREEN).
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 2: compound-inflation PASS --"

CASE2_REPO="$MASTER_TMP/case2"
init_repo "$CASE2_REPO"

write_claude_md "$CASE2_REPO" 30
commit_engineer "$CASE2_REPO" "docs: initial CLAUDE.md"
CASE2_BASE=$(git -C "$CASE2_REPO" rev-parse HEAD)

# Engineer commit: delete 10 lines (30 → 20)
trim_claude_md "$CASE2_REPO" 20
commit_engineer "$CASE2_REPO"

# Simulate a merged-in commit (e.g. origin/main advancing): delete 5 more lines
trim_claude_md "$CASE2_REPO" 15
commit_engineer "$CASE2_REPO" "chore: merge origin/main CLAUDE.md update"

# Scribe commit: delete 3 lines (15 → 12); threshold 5 → exit 0
trim_claude_md "$CASE2_REPO" 12
commit_scribe "$CASE2_REPO"

run_guard "compound-inflation: engineer + mid-build + scribe 3 del, threshold 5 → exit 0" 0 "$CASE2_REPO" "$CASE2_BASE" "5"

# ─────────────────────────────────────────────────────────────────────────────
# Case 3: genuine over-trim FAIL
# scribe commit itself deletes 10 CLAUDE.md lines; threshold 5 → exit 2
# (real over-trim is still caught after the fix)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 3: genuine over-trim FAIL --"

CASE3_REPO="$MASTER_TMP/case3"
init_repo "$CASE3_REPO"

write_claude_md "$CASE3_REPO" 20
commit_engineer "$CASE3_REPO" "docs: initial CLAUDE.md"
CASE3_BASE=$(git -C "$CASE3_REPO" rev-parse HEAD)

# Scribe commit: delete 10 lines (20 → 10); threshold 5 → exit 2
trim_claude_md "$CASE3_REPO" 10
commit_scribe "$CASE3_REPO"

run_guard "genuine over-trim: scribe deletes 10, threshold 5 → exit 2" 2 "$CASE3_REPO" "$CASE3_BASE" "5"

# ─────────────────────────────────────────────────────────────────────────────
# Case 4: fail-closed-on-empty FAIL
# only an engineer commit since base (no Canon-Agent: scribe trailer) → exit 2
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 4: fail-closed-on-empty FAIL --"

CASE4_REPO="$MASTER_TMP/case4"
init_repo "$CASE4_REPO"

write_claude_md "$CASE4_REPO" 20
commit_engineer "$CASE4_REPO" "docs: initial CLAUDE.md"
CASE4_BASE=$(git -C "$CASE4_REPO" rev-parse HEAD)

# Only an engineer commit in the range — no scribe trailer → fail-closed
trim_claude_md "$CASE4_REPO" 15
commit_engineer "$CASE4_REPO"

run_guard "fail-closed-on-empty: no scribe trailer commit → exit 2" 2 "$CASE4_REPO" "$CASE4_BASE" "5"

# ─────────────────────────────────────────────────────────────────────────────
# Case 5a: multi-commit-union PASS
# two scribe-trailer commits each deleting 2 lines → union = 4 ≤ 5 → exit 0
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 5a: multi-commit-union PASS --"

CASE5A_REPO="$MASTER_TMP/case5a"
init_repo "$CASE5A_REPO"

write_claude_md "$CASE5A_REPO" 20
commit_engineer "$CASE5A_REPO" "docs: initial CLAUDE.md"
CASE5A_BASE=$(git -C "$CASE5A_REPO" rev-parse HEAD)

# Scribe commit 1: delete 2 lines (20 → 18)
trim_claude_md "$CASE5A_REPO" 18
commit_scribe "$CASE5A_REPO"

# Scribe commit 2: delete 2 lines (18 → 16)
trim_claude_md "$CASE5A_REPO" 16
commit_scribe "$CASE5A_REPO"

run_guard "multi-commit-union: 2+2=4 del, threshold 5 → exit 0" 0 "$CASE5A_REPO" "$CASE5A_BASE" "5"

# ─────────────────────────────────────────────────────────────────────────────
# Case 5b: multi-commit-union FAIL (nice-to-have variant)
# two scribe-trailer commits each deleting 3 lines → union = 6 > 5 → exit 2
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 5b: multi-commit-union FAIL --"

CASE5B_REPO="$MASTER_TMP/case5b"
init_repo "$CASE5B_REPO"

write_claude_md "$CASE5B_REPO" 20
commit_engineer "$CASE5B_REPO" "docs: initial CLAUDE.md"
CASE5B_BASE=$(git -C "$CASE5B_REPO" rev-parse HEAD)

# Scribe commit 1: delete 3 lines (20 → 17)
trim_claude_md "$CASE5B_REPO" 17
commit_scribe "$CASE5B_REPO"

# Scribe commit 2: delete 3 lines (17 → 14)
trim_claude_md "$CASE5B_REPO" 14
commit_scribe "$CASE5B_REPO"

run_guard "multi-commit-union: 3+3=6 del, threshold 5 → exit 2" 2 "$CASE5B_REPO" "$CASE5B_BASE" "5"

# ─────────────────────────────────────────────────────────────────────────────
# Case 6: triple-dash-undercount FAIL
# scribe commit deletes 6 lines whose content is exactly "---"
# (YAML frontmatter delimiters / markdown horizontal rules)
#
# Bug: the old grep-based guard counts deletion diff lines matching '^-' and
# then excludes lines matching '^---' to strip the "--- a/path" file-header.
# A deleted "---" line appears as "----" in the diff (one '-' deletion marker
# + three '-' content) — "----" starts with "---", so grep -v '^---' also
# strips the real deletion lines.  Six deletions → counted as 0 → wrong exit 0.
#
# TDD: this case is RED against the current grep-based guard (exits 0, should
# exit 2).  After the numstat fix it becomes GREEN (exits 2 = over threshold 5).
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 6: triple-dash-undercount FAIL --"

CASE6_REPO="$MASTER_TMP/case6"
init_repo "$CASE6_REPO"

# Write CLAUDE.md with 6 "---" lines interleaved with normal content
{
  printf '# Header\n'
  printf -- '---\n'
  printf 'Some content\n'
  printf -- '---\n'
  printf 'More content\n'
  printf -- '---\n'
  printf 'Even more\n'
  printf -- '---\n'
  printf 'Last section\n'
  printf -- '---\n'
  printf 'Final\n'
  printf -- '---\n'
} > "$CASE6_REPO/CLAUDE.md"
commit_engineer "$CASE6_REPO" "docs: initial CLAUDE.md with --- lines"
CASE6_BASE=$(git -C "$CASE6_REPO" rev-parse HEAD)

# Scribe commit: remove all 6 "---" lines; 6 deleted lines, threshold 5 → exit 2
{
  printf '# Header\n'
  printf 'Some content\n'
  printf 'More content\n'
  printf 'Even more\n'
  printf 'Last section\n'
  printf 'Final\n'
} > "$CASE6_REPO/CLAUDE.md"
commit_scribe "$CASE6_REPO"

run_guard "triple-dash-undercount: scribe deletes 6 '---' lines, threshold 5 → exit 2" 2 "$CASE6_REPO" "$CASE6_BASE" "5"

# ─────────────────────────────────────────────────────────────────────────────
# Case 7: worktree_path arg honored from wrong CWD (watch_CCCCCCCCCCCC2)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 7: worktree_path arg honored from wrong CWD --"

CASE7_MAIN="$MASTER_TMP/case7-main"
init_repo "$CASE7_MAIN"
write_claude_md "$CASE7_MAIN" 20
commit_engineer "$CASE7_MAIN" "docs: initial CLAUDE.md"
CASE7_BASE=$(git -C "$CASE7_MAIN" rev-parse HEAD)

CASE7_LINKED="$MASTER_TMP/case7-linked"
git -C "$CASE7_MAIN" worktree add -q -b case7-branch "$CASE7_LINKED" HEAD

# Scribe commit on the linked worktree: delete 10 lines (20 → 10); threshold 5 → exit 2
trim_claude_md "$CASE7_LINKED" 10
commit_scribe "$CASE7_LINKED"

actual_exit=0
(cd "$CASE7_MAIN" && bash "$GUARD" "$CASE7_BASE" "5" "$CASE7_LINKED" >/dev/null 2>&1) || actual_exit=$?
if [[ "$actual_exit" -eq 2 ]]; then
  echo "  PASS: worktree_path arg from wrong CWD detects the over-trim (exit 2)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: worktree_path arg honored — expected exit 2, got $actual_exit"
  FAIL=$((FAIL + 1))
fi

# Sanity baseline: WITHOUT worktree_path, running from the wrong CWD (main
# tree has no scribe commit at all in this range) fails closed for a
# DIFFERENT reason (no scribe-trailer commit found) — proving the arg made
# the real difference, not incidental exit-code overlap.
baseline_exit=0
baseline_output=$(cd "$CASE7_MAIN" && bash "$GUARD" "$CASE7_BASE" "5" 2>&1) || baseline_exit=$?
if [[ "$baseline_exit" -eq 2 ]] && echo "$baseline_output" | grep -qF "no scribe commit"; then
  echo "  PASS: without worktree_path, wrong-CWD run fails closed for the expected reason (no scribe commit found)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: baseline behavior unexpected"
  echo "        exit=$baseline_exit output=$baseline_output"
  FAIL=$((FAIL + 1))
fi

git -C "$CASE7_MAIN" worktree remove --force "$CASE7_LINKED" >/dev/null 2>&1 || true

# ─────────────────────────────────────────────────────────────────────────────
# Case 8: backward-compat — worktree_path absent, correct CWD → unchanged
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 8: backward-compat, worktree_path absent --"

CASE8_REPO="$MASTER_TMP/case8"
init_repo "$CASE8_REPO"
write_claude_md "$CASE8_REPO" 20
commit_engineer "$CASE8_REPO" "docs: initial CLAUDE.md"
CASE8_BASE=$(git -C "$CASE8_REPO" rev-parse HEAD)

trim_claude_md "$CASE8_REPO" 17
commit_scribe "$CASE8_REPO"

run_guard "backward-compat: no worktree_path, scribe deletes 3, threshold 5 → exit 0" 0 "$CASE8_REPO" "$CASE8_BASE" "5"

# ─────────────────────────────────────────────────────────────────────────────
# Case 9: invalid worktree_path (non-directory) → fail-closed exit 2
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 9: invalid worktree_path → fail-closed exit 2 --"

CASE9_REPO="$MASTER_TMP/case9"
init_repo "$CASE9_REPO"
CASE9_BASE=$(git -C "$CASE9_REPO" rev-parse HEAD)

actual_exit=0
output=$(cd "$CASE9_REPO" && bash "$GUARD" "$CASE9_BASE" "5" "/nonexistent/worktree/path" 2>&1) || actual_exit=$?
if [[ "$actual_exit" -eq 2 ]] && echo "$output" | grep -qF "CANON: scribe-scope-guard failed-closed — worktree_path not a directory"; then
  echo "  PASS: invalid worktree_path → fail-closed exit 2 with message"
  PASS=$((PASS + 1))
else
  echo "  FAIL: invalid worktree_path handling"
  echo "        expected exit=2 with failed-closed message, got exit=$actual_exit"
  echo "        output: $output"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi

exit 0
