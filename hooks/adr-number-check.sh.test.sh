#!/bin/bash
# Tests for adr-number-check.sh
# Run with: bash hooks/adr-number-check.sh.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures
#
# All tests use isolated temp git repos. No hard-coded paths; safe for CI.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/adr-number-check.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

MASTER_TMP=$(mktemp -d)
trap 'rm -rf "$MASTER_TMP"' EXIT

# run_test_in_dir — run hook in dir, validate exit code
run_test_in_dir() {
  local description="$1"
  local expected_exit="$2"
  local repo_dir="$3"
  local stdin_json="$4"

  local tmpout
  tmpout=$(mktemp)

  local actual_exit=0
  (cd "$repo_dir" && echo "$stdin_json" | bash "$HOOK" > "$tmpout" 2>&1) || actual_exit=$?

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    echo "        output: $(cat "$tmpout")"
    FAIL=$((FAIL + 1))
  fi
  rm -f "$tmpout"
}

# run_test_in_dir_with_output — validate exit code AND stdout pattern
run_test_in_dir_with_output() {
  local description="$1"
  local expected_exit="$2"
  local expected_pattern="$3"
  local repo_dir="$4"
  local stdin_json="$5"

  local tmpout
  tmpout=$(mktemp)

  local actual_exit=0
  (cd "$repo_dir" && echo "$stdin_json" | bash "$HOOK" > "$tmpout" 2>&1) || actual_exit=$?
  local output
  output=$(cat "$tmpout")
  rm -f "$tmpout"

  local ok=true
  [[ "$actual_exit" -eq "$expected_exit" ]] || ok=false
  if [[ -n "$expected_pattern" ]] && ! echo "$output" | grep -q "$expected_pattern"; then
    ok=false
  fi

  if [[ "$ok" == "true" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    echo "        expected pattern: '$expected_pattern'"
    echo "        actual output: '$output'"
    FAIL=$((FAIL + 1))
  fi
}

# setup_repo_with_origin <workdir> [<adr_path> ...]
# Creates a bare origin repo at ${workdir}-origin.git and a working repo at ${workdir}
# with the given docs/adr/ files committed and pushed to origin/main.
# HEAD is left on a 'feature' branch ready for the test to add new ADRs.
setup_repo_with_origin() {
  local workdir="$1"
  shift
  local adr_files=("$@")

  local origin="${workdir}-origin.git"
  mkdir -p "$origin"
  git -C "$origin" init --bare -q

  mkdir -p "$workdir"
  git -C "$workdir" init -q
  git -C "$workdir" config user.email "test@test"
  git -C "$workdir" config user.name "Test"
  git -C "$workdir" config commit.gpgsign false

  # Initial commit
  echo "placeholder" > "$workdir/README.md"
  git -C "$workdir" add README.md
  git -C "$workdir" commit -q -m "init"

  # Add origin ADR files (each with minimal valid content)
  # Use the "${arr[@]+"${arr[@]}"}" idiom so set -u doesn't fail on an empty array
  for adr in "${adr_files[@]+"${adr_files[@]}"}"; do
    mkdir -p "$workdir/$(dirname "$adr")"
    printf '# ADR\nStatus: Accepted\n' > "$workdir/$adr"
    git -C "$workdir" add "$adr"
  done
  if [[ ${#adr_files[@]} -gt 0 ]]; then
    git -C "$workdir" commit -q -m "add origin ADRs"
  fi

  # Push to origin/main and check out feature branch
  git -C "$workdir" remote add origin "$origin"
  local current_branch
  current_branch=$(git -C "$workdir" rev-parse --abbrev-ref HEAD)
  git -C "$workdir" push -q origin "$current_branch:main"
  git -C "$workdir" checkout -b feature -q
}

# setup_repo_no_origin <workdir>
# Creates a working repo with NO origin remote, HEAD on a 'feature' branch.
setup_repo_no_origin() {
  local workdir="$1"

  mkdir -p "$workdir"
  git -C "$workdir" init -q
  git -C "$workdir" config user.email "test@test"
  git -C "$workdir" config user.name "Test"
  git -C "$workdir" config commit.gpgsign false

  echo "placeholder" > "$workdir/README.md"
  git -C "$workdir" add README.md
  git -C "$workdir" commit -q -m "init"

  git -C "$workdir" checkout -b feature -q
}

# add_adr <workdir> <adr_path>
# Adds and commits a new ADR file on the current branch.
add_adr() {
  local workdir="$1"
  local adr_path="$2"
  mkdir -p "$workdir/$(dirname "$adr_path")"
  printf '# ADR\nStatus: Accepted\n' > "$workdir/$adr_path"
  git -C "$workdir" add "$adr_path"
  git -C "$workdir" commit -q -m "add $adr_path"
}

# add_non_adr <workdir> <file_path>
# Adds and commits a non-ADR source file on the current branch.
add_non_adr() {
  local workdir="$1"
  local file_path="$2"
  mkdir -p "$workdir/$(dirname "$file_path")"
  echo "source" > "$workdir/$file_path"
  git -C "$workdir" add "$file_path"
  git -C "$workdir" commit -q -m "add $file_path"
}

# edit_adr <workdir> <adr_path>
# Appends content to an existing ADR (same number+filename; not an add).
edit_adr() {
  local workdir="$1"
  local adr_path="$2"
  printf '\n## Updated section\nNew content.\n' >> "$workdir/$adr_path"
  git -C "$workdir" add "$adr_path"
  git -C "$workdir" commit -q -m "edit $adr_path"
}

# rename_adr <workdir> <from_path> <to_path>
# Renames an ADR file using git mv on the current branch.
rename_adr() {
  local workdir="$1"
  local from_path="$2"
  local to_path="$3"
  mkdir -p "$workdir/$(dirname "$to_path")"
  git -C "$workdir" mv "$from_path" "$to_path"
  git -C "$workdir" commit -q -m "rename $from_path to $to_path"
}

# advance_origin_main <workdir> <old_adr_path> <new_adr_path>
# Simulates origin/main advancing after the feature branch diverged:
# deletes old_adr_path and adds new_adr_path on origin/main. Does NOT
# fetch the result into workdir — the caller must run 'git fetch origin'.
advance_origin_main() {
  local workdir="$1"
  local old_path="$2"
  local new_path="$3"

  local origin="${workdir}-origin.git"
  local temp_clone
  temp_clone=$(mktemp -d)

  git clone --local "$origin" "$temp_clone" -q
  git -C "$temp_clone" config user.email "test@test"
  git -C "$temp_clone" config user.name "Test"
  git -C "$temp_clone" config commit.gpgsign false

  git -C "$temp_clone" rm -q "$old_path"
  mkdir -p "$temp_clone/$(dirname "$new_path")"
  printf '# ADR\nStatus: Accepted\n' > "$temp_clone/$new_path"
  git -C "$temp_clone" add "$new_path"
  git -C "$temp_clone" commit -q -m "renumber: remove $(basename "$old_path"), add $(basename "$new_path")"
  git -C "$temp_clone" push -q origin HEAD:main

  rm -rf "$temp_clone"
}

echo ""
echo "=== adr-number-check.sh tests ==="
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Case 1: Non-push command → hook ignores it, exit 0
# ─────────────────────────────────────────────────────────────────────────────
echo "-- Case 1: Non-push command ignored --"

CASE1_REPO="$MASTER_TMP/case1"
setup_repo_with_origin "$CASE1_REPO"

run_test_in_dir "git status does not trigger adr-number-check" 0 \
  "$CASE1_REPO" '{"command":"git status"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 2: Clean — unique ADR number → exit 0
# origin/main has 0022; branch adds 0023-new-unique.md
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 2: Clean — unique ADR number → exit 0 --"

CASE2_REPO="$MASTER_TMP/case2"
setup_repo_with_origin "$CASE2_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE2_REPO" "docs/adr/0023-new-unique.md"

run_test_in_dir "unique ADR number → exit 0" 0 \
  "$CASE2_REPO" '{"command":"git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 3: Collision with origin/main → exit 2, names number + both filenames + next-free
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 3: Collision with origin/main → exit 2 --"

CASE3_REPO="$MASTER_TMP/case3"
setup_repo_with_origin "$CASE3_REPO" "docs/adr/0022-candidate-injection.md"
add_adr "$CASE3_REPO" "docs/adr/0022-other-slug.md"

run_test_in_dir "collision → exit 2" 2 \
  "$CASE3_REPO" '{"command":"git push origin feature"}'

run_test_in_dir_with_output "collision output names the number 0022" 2 \
  "0022" "$CASE3_REPO" '{"command":"git push origin feature"}'

run_test_in_dir_with_output "collision output names the branch filename" 2 \
  "0022-other-slug.md" "$CASE3_REPO" '{"command":"git push origin feature"}'

run_test_in_dir_with_output "collision output names the origin/main filename" 2 \
  "0022-candidate-injection.md" "$CASE3_REPO" '{"command":"git push origin feature"}'

run_test_in_dir_with_output "collision output suggests next-free 0023" 2 \
  "0023" "$CASE3_REPO" '{"command":"git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 4: Instance #16 exact fixture (PR #415 0022 collision)
# origin/main has 0022-candidate-injection-temp-dir-not-worktree.md
# branch adds  0022-dead-wire-internal-use-compiler-api-resolution.md
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 4: Instance #16 exact fixture → exit 2 naming both real filenames --"

CASE4_REPO="$MASTER_TMP/case4"
setup_repo_with_origin "$CASE4_REPO" \
  "docs/adr/0022-candidate-injection-temp-dir-not-worktree.md"
add_adr "$CASE4_REPO" \
  "docs/adr/0022-dead-wire-internal-use-compiler-api-resolution.md"

run_test_in_dir "instance #16 → exit 2" 2 \
  "$CASE4_REPO" '{"command":"git push origin feature"}'

run_test_in_dir_with_output "output names origin/main file (candidate-injection)" 2 \
  "0022-candidate-injection-temp-dir-not-worktree.md" \
  "$CASE4_REPO" '{"command":"git push origin feature"}'

run_test_in_dir_with_output "output names branch file (dead-wire)" 2 \
  "0022-dead-wire-internal-use-compiler-api-resolution.md" \
  "$CASE4_REPO" '{"command":"git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 5: Multiple new ADRs, one colliding → exit 2, names the collision number
# origin/main has 0022; branch adds 0023-unique.md AND 0022-colliding.md
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 5: Multiple ADRs, one colliding → exit 2 --"

CASE5_REPO="$MASTER_TMP/case5"
setup_repo_with_origin "$CASE5_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE5_REPO" "docs/adr/0023-unique.md"
add_adr "$CASE5_REPO" "docs/adr/0022-colliding.md"

run_test_in_dir "multiple ADRs, one collides → exit 2" 2 \
  "$CASE5_REPO" '{"command":"git push origin feature"}'

run_test_in_dir_with_output "output names the colliding number 0022" 2 \
  "0022" "$CASE5_REPO" '{"command":"git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 6: Multiple new ADRs, all unique → exit 0
# origin/main has 0022; branch adds 0023-a.md AND 0024-b.md
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 6: Multiple ADRs, all unique → exit 0 --"

CASE6_REPO="$MASTER_TMP/case6"
setup_repo_with_origin "$CASE6_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE6_REPO" "docs/adr/0023-unique-a.md"
add_adr "$CASE6_REPO" "docs/adr/0024-unique-b.md"

run_test_in_dir "all unique ADRs → exit 0" 0 \
  "$CASE6_REPO" '{"command":"git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 7: No ADRs at all → exit 0 (must NOT reach origin/main resolution)
# origin/main has ADRs; branch only adds src/foo.ts
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 7: No new ADRs (only src/foo.ts) → exit 0 --"

CASE7_REPO="$MASTER_TMP/case7"
setup_repo_with_origin "$CASE7_REPO" "docs/adr/0022-existing.md"
add_non_adr "$CASE7_REPO" "src/foo.ts"

run_test_in_dir "no ADR changes → exit 0" 0 \
  "$CASE7_REPO" '{"command":"git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 8: Content-only edit of existing ADR (same number+filename) → exit 0
# --diff-filter=A excludes modified files; only Added files trigger the check
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 8: Editing existing ADR (same number+filename) → exit 0 --"

CASE8_REPO="$MASTER_TMP/case8"
setup_repo_with_origin "$CASE8_REPO" "docs/adr/0022-candidate-injection.md"
edit_adr "$CASE8_REPO" "docs/adr/0022-candidate-injection.md"

run_test_in_dir "content-only edit → exit 0" 0 \
  "$CASE8_REPO" '{"command":"git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 9: origin/main unresolvable + ADRs added → exit 2 (FAIL-CLOSED)
# repo has NO origin remote; branch adds a new ADR file
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 9: No origin remote + ADRs added → exit 2 (fail-closed) --"

CASE9_REPO="$MASTER_TMP/case9"
setup_repo_no_origin "$CASE9_REPO"
add_adr "$CASE9_REPO" "docs/adr/0022-new.md"

run_test_in_dir "no origin + ADR added → exit 2" 2 \
  "$CASE9_REPO" '{"command":"git push origin feature"}'

run_test_in_dir_with_output "output mentions resolution failure" 2 \
  "cannot resolve origin/main" \
  "$CASE9_REPO" '{"command":"git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 10: origin/main unresolvable + NO ADRs → exit 0
# (fail-closed scoped to ADR-adding pushes only; no ADR files = no collision risk)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 10: No origin remote + no ADRs → exit 0 --"

CASE10_REPO="$MASTER_TMP/case10"
setup_repo_no_origin "$CASE10_REPO"
add_non_adr "$CASE10_REPO" "src/foo.ts"

run_test_in_dir "no origin + no ADRs → exit 0" 0 \
  "$CASE10_REPO" '{"command":"git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 11: Suggested next-free = max(origin ∪ branch) + 1
# origin/main has 0022; branch adds colliding 0022-x.md AND also 0023-y.md
# next-free = max(0022, 0022, 0023) + 1 = 0024
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 11: next-free = max(origin ∪ branch)+1 → 0024 --"

CASE11_REPO="$MASTER_TMP/case11"
setup_repo_with_origin "$CASE11_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE11_REPO" "docs/adr/0022-collision.md"
add_adr "$CASE11_REPO" "docs/adr/0023-also-new.md"

run_test_in_dir "collision with 0023 also on branch → exit 2" 2 \
  "$CASE11_REPO" '{"command":"git push origin feature"}'

run_test_in_dir_with_output "suggested next-free is 0024" 2 \
  "0024" "$CASE11_REPO" '{"command":"git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 12: Rename-into-collision via git mv → exit 2 (BLOCKING regression test)
# origin/main has 0022-candidate-injection.md + 0099-old-slug.md (feature branch
# inherits both). Branch: git mv 0099-old-slug.md 0022-other-slug.md — this renames
# into 0022, which already exists on origin/main.
# Without --no-renames: git classifies the mv as R (rename); --diff-filter=A
# EXCLUDES R entries → hook exits 0 (WRONG — the collision slips past).
# With --no-renames: classified as A (0022-other-slug.md) + D (0099-old-slug.md);
# 0022-other-slug.md enters NEW_ADRS and the collision is caught → exit 2.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 12: Rename-into-collision (git mv 0099→0022) → exit 2 [BLOCKING regression] --"

CASE12_REPO="$MASTER_TMP/case12"
setup_repo_with_origin "$CASE12_REPO" \
  "docs/adr/0022-candidate-injection.md" \
  "docs/adr/0099-old-slug.md"
rename_adr "$CASE12_REPO" \
  "docs/adr/0099-old-slug.md" \
  "docs/adr/0022-other-slug.md"

run_test_in_dir "rename-into-collision → exit 2" 2 \
  "$CASE12_REPO" '{"command":"git push origin feature"}'

run_test_in_dir_with_output "rename-collision output names 0022" 2 \
  "0022" "$CASE12_REPO" '{"command":"git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 13: Benign rename (target number not on origin/main) → exit 0
# origin/main has 0022-existing.md only; branch adds 0099-old-slug.md then renames
# it to 0099-new-slug.md — 0099 is not on origin/main so no collision → exit 0.
# Verifies that --no-renames does not over-block non-colliding renames.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 13: Benign rename (0099 not on origin/main) → exit 0 --"

CASE13_REPO="$MASTER_TMP/case13"
setup_repo_with_origin "$CASE13_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE13_REPO" "docs/adr/0099-old-slug.md"
rename_adr "$CASE13_REPO" \
  "docs/adr/0099-old-slug.md" \
  "docs/adr/0099-new-slug.md"

run_test_in_dir "benign rename (non-colliding number) → exit 0" 0 \
  "$CASE13_REPO" '{"command":"git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 14: Three-dot merge-base miss (BLOCKING regression — two-dot fix)
# Scenario:
#   merge-base:   origin/main has 0022-foo.md; feature branch branches from here.
#   feature:      KEEPS 0022-foo.md (inherited, not re-added), adds 0050-unrelated.md.
#   origin/main ADVANCES: deletes 0022-foo.md, adds 0022-bar.md (number 0022 reused).
#   push feature: re-introduces 0022-foo.md to a main that already holds 0022-bar.md
#                 → TRUE collision (number 0022, two different slugs).
#
# Bug (THREE-DOT origin/main...HEAD):
#   0022-foo.md is present at the merge-base → git classifies it as NOT Added → never
#   enters NEW_ADRS → hook exits 0 (FAIL-OPEN).
# Fix (TWO-DOT origin/main..HEAD):
#   Compares HEAD to origin/main TIP (not merge-base). 0022-foo.md is in HEAD but NOT
#   in origin/main → classified as Added → collision with 0022-bar.md caught → exit 2.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 14: Three-dot merge-base miss: origin reused 0022 after branch diverged → exit 2 [BLOCKING regression] --"

CASE14_REPO="$MASTER_TMP/case14"
# Step 1: origin starts with 0022-foo.md; feature branch inherits it (merge-base)
setup_repo_with_origin "$CASE14_REPO" "docs/adr/0022-foo.md"

# Step 2: feature branch adds 0050-unrelated.md (0022-foo.md already present, not re-added)
add_adr "$CASE14_REPO" "docs/adr/0050-unrelated.md"

# Step 3: origin/main advances — deletes 0022-foo.md, adds 0022-bar.md (number reused)
advance_origin_main "$CASE14_REPO" "docs/adr/0022-foo.md" "docs/adr/0022-bar.md"

# Step 4: update local origin/main ref so the hook sees the advanced state
git -C "$CASE14_REPO" fetch origin -q

run_test_in_dir "three-dot miss: origin reused 0022 after branch diverged → exit 2" 2 \
  "$CASE14_REPO" '{"command":"git push origin feature"}'

run_test_in_dir_with_output "three-dot regression: output names 0022" 2 \
  "0022" "$CASE14_REPO" '{"command":"git push origin feature"}'

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
