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
  # Pin bare origin HEAD to refs/heads/main so that git clone --local (used by
  # advance_origin_main) checks out the correct branch regardless of the system's
  # init.defaultBranch setting (e.g. "master" on stock CI). Without this, Case 14
  # aborts with exit 128 when the CI agent has init.defaultBranch=master. (fix #1 / dc-01)
  git -C "$origin" symbolic-ref HEAD refs/heads/main

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

# write_gh_stub <stub_path> <body>
# Creates an executable stub script at <stub_path> whose body is <body>.
# Used to point CANON_ADR_GH_BIN at a hermetic, network-free fake gh binary.
write_gh_stub() {
  local stub_path="$1"
  local body="$2"
  {
    echo "#!/bin/bash"
    echo "$body"
  } > "$stub_path"
  chmod +x "$stub_path"
}

# run_test_in_dir_no_pattern <description> <expected_exit> <no_pattern> <repo_dir> <stdin_json>
# Validates exit code AND that stdout+stderr does NOT contain no_pattern.
run_test_in_dir_no_pattern() {
  local description="$1"
  local expected_exit="$2"
  local no_pattern="$3"
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
  if echo "$output" | grep -q "$no_pattern"; then
    ok=false
  fi

  if [[ "$ok" == "true" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    echo "        expected output NOT to contain: '$no_pattern'"
    echo "        actual output: '$output'"
    FAIL=$((FAIL + 1))
  fi
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
# Case 15: Push-precision — commit with "push" in message does NOT trigger
# (fix #2 — canon_git_subcommand per-segment replaces the over-matching grep)
# origin has 0022-existing.md; branch adds colliding 0022-other.md;
# command: git commit -m "push fix" → NOT a real push → exit 0
# NOTE: This test is RED before fix #2 — the old grep-based check sees "push"
# in the commit message and falsely triggers, exiting 2 instead of 0.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 15: commit with 'push' in message, collision present → exit 0 (no trigger) --"

CASE15_REPO="$MASTER_TMP/case15"
setup_repo_with_origin "$CASE15_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE15_REPO" "docs/adr/0022-other.md"

run_test_in_dir "commit -m 'push fix' does not trigger gate (not a push)" 0 \
  "$CASE15_REPO" '{"command":"git commit -m \"push fix\""}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 16: Push-precision — compound real push with collision IS caught
# (fix #2 — per-segment detection finds the real git push subcommand)
# origin has 0022-existing.md; branch adds colliding 0022-other.md;
# command: git add -A && git commit -m "x" && git push origin feature → exit 2
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 16: compound real push with collision → exit 2 --"

CASE16_REPO="$MASTER_TMP/case16"
setup_repo_with_origin "$CASE16_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE16_REPO" "docs/adr/0022-other.md"

run_test_in_dir "compound git push collision → exit 2" 2 \
  "$CASE16_REPO" '{"command":"git add -A && git commit -m \"x\" && git push origin feature"}'

run_test_in_dir_with_output "compound push output names 0022" 2 \
  "0022" "$CASE16_REPO" '{"command":"git add -A && git commit -m \"x\" && git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 17: Bare subshell (git push) with collision → exit 2 [fail-OPEN regression]
# Before fix: "(git push)" strips leading ( to yield "git push)"; canon_git_subcommand
# tokenizes "git push)" and finds "push)" which FAILS the shape gate
# (^[A-Za-z][A-Za-z0-9_-]*$ rejects the trailing ')') → returns empty →
# _IS_PUSH stays false → gate exits 0 while a colliding ADR is pushed (fail-OPEN).
# After fix (strip both ends): "(git push)" → "git push" → detected → exit 2.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 17: bare subshell (git push) with collision → exit 2 [fail-OPEN regression] --"

CASE17_REPO="$MASTER_TMP/case17"
setup_repo_with_origin "$CASE17_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE17_REPO" "docs/adr/0022-other.md"

run_test_in_dir "bare subshell (git push) with collision → exit 2" 2 \
  "$CASE17_REPO" '{"command":"(git push)"}'

run_test_in_dir_with_output "bare subshell (git push) collision output names 0022" 2 \
  "0022" "$CASE17_REPO" '{"command":"(git push)"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 18: Brace-group { git push; } with collision → exit 2
# The ';' segmenter splits "{ git push; }" into "{ git push" and " }". The first
# segment strips its leading '{' via the leading-opener strip → "git push" →
# detected. Verified to work both before and after the strip-both-ends fix.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 18: brace-group { git push; } with collision → exit 2 --"

CASE18_REPO="$MASTER_TMP/case18"
setup_repo_with_origin "$CASE18_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE18_REPO" "docs/adr/0022-other.md"

run_test_in_dir "brace-group { git push; } with collision → exit 2" 2 \
  "$CASE18_REPO" '{"command":"{ git push; }"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 19: Subshell with refspec (git push origin feature) with collision → exit 2
# The trailing ')' is on the refspec token ("feature)"); the subcommand "push" is
# found before reaching "feature)" so this form worked even before the fix.
# Regression test to confirm strip-both-ends does not break this path.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 19: subshell (git push origin feature) with collision → exit 2 --"

CASE19_REPO="$MASTER_TMP/case19"
setup_repo_with_origin "$CASE19_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE19_REPO" "docs/adr/0022-other.md"

run_test_in_dir "subshell (git push origin feature) with collision → exit 2" 2 \
  "$CASE19_REPO" '{"command":"(git push origin feature)"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 20: bash -c "git push …" with collision → exit 2 [string-exec wrapper]
# Before fix: "bash -c \"git push origin feature\"" tokenizes the quoted payload
# as ONE token ("git push origin feature") so canon_has_git_token finds no
# standalone "git" token → _IS_PUSH stays false → gate exits 0 (FAIL-OPEN).
# After fix (delegate to canon_command_invokes_subcommand): the wrapper is
# recognised via canon_unwrap_string_exec_arg, inner="git push origin feature"
# is recursed into → push detected → exit 2.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 20: bash -c \"git push origin feature\" with collision → exit 2 [string-exec wrapper] --"

CASE20_REPO="$MASTER_TMP/case20"
setup_repo_with_origin "$CASE20_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE20_REPO" "docs/adr/0022-other.md"

run_test_in_dir 'bash -c "git push origin feature" with collision → exit 2' 2 \
  "$CASE20_REPO" '{"command":"bash -c \"git push origin feature\""}'

run_test_in_dir_with_output 'bash -c wrapper collision output names 0022' 2 \
  "0022" "$CASE20_REPO" '{"command":"bash -c \"git push origin feature\""}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 21: sh -c "git push" with collision → exit 2 [string-exec wrapper]
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 21: sh -c \"git push\" with collision → exit 2 [string-exec wrapper] --"

CASE21_REPO="$MASTER_TMP/case21"
setup_repo_with_origin "$CASE21_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE21_REPO" "docs/adr/0022-other.md"

run_test_in_dir 'sh -c "git push" with collision → exit 2' 2 \
  "$CASE21_REPO" '{"command":"sh -c \"git push\""}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 22: eval "git push origin feature" with collision → exit 2 [eval wrapper]
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 22: eval \"git push origin feature\" with collision → exit 2 [eval wrapper] --"

CASE22_REPO="$MASTER_TMP/case22"
setup_repo_with_origin "$CASE22_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE22_REPO" "docs/adr/0022-other.md"

run_test_in_dir 'eval "git push origin feature" with collision → exit 2' 2 \
  "$CASE22_REPO" '{"command":"eval \"git push origin feature\""}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 23: Nested wrapper bash -c "bash -c 'git push'" → exit 2 [depth-1 nesting]
# Verifies that one level of wrapper recursion is followed correctly.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 23: bash -c \"bash -c 'git push'\" (nested) with collision → exit 2 --"

CASE23_REPO="$MASTER_TMP/case23"
setup_repo_with_origin "$CASE23_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE23_REPO" "docs/adr/0022-other.md"

run_test_in_dir 'bash -c "bash -c '"'"'git push'"'"'" nested → exit 2' 2 \
  "$CASE23_REPO" '{"command":"bash -c \"bash -c '"'"'git push'"'"'\""}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 24: \git push with collision → exit 2 [backslash-escaped git detection]
# Divergence form DEC-p2m-bypass-02: `\git push` resolves to real git at
# runtime (backslash only suppresses alias lookup). The shared detector must
# apply canon_backslash_git_command_word parity — previously
# _canon_seg_invokes_subcmd missed it, returning exit 0 (false-negative).
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 24: \\git push with collision → exit 2 [backslash-escaped git] --"

CASE24_REPO="$MASTER_TMP/case24"
setup_repo_with_origin "$CASE24_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE24_REPO" "docs/adr/0022-other.md"

run_test_in_dir '\git push with collision → exit 2' 2 \
  "$CASE24_REPO" '{"command":"\\git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 25: FOO=1 \git push with collision → exit 2 [env-prefix + backslash-git]
# Divergence form: NAME=VALUE assignment prefix before \git push; the command-
# word walker must skip the prefix and detect the escaped git at its resolved
# command-word slot.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 25: FOO=1 \\git push with collision → exit 2 [env-prefix + backslash-git] --"

CASE25_REPO="$MASTER_TMP/case25"
setup_repo_with_origin "$CASE25_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE25_REPO" "docs/adr/0022-other.md"

run_test_in_dir 'FOO=1 \git push with collision → exit 2' 2 \
  "$CASE25_REPO" '{"command":"FOO=1 \\git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 26: $(echo git) push with collision → exit 2 [cmdsub as command word]
# Divergence form DEC-p2m-bypass-01 R1: a command substitution occupying the
# command-word slot followed by further tokens — canon_cmdsub_not_final must
# detect the non-final substitution and fail-closed.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 26: \$(echo git) push with collision → exit 2 [cmdsub command word] --"

CASE26_REPO="$MASTER_TMP/case26"
setup_repo_with_origin "$CASE26_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE26_REPO" "docs/adr/0022-other.md"

run_test_in_dir '$(echo git) push with collision → exit 2' 2 \
  "$CASE26_REPO" '{"command":"$(echo git) push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 27: g$(echo i)t push with collision → exit 2 [cmdsub glued into git word]
# Divergence form DEC-p2m-bypass-01 R1 contains-test: a command substitution
# glued into the middle of the git command word — the contains-test in
# canon_cmdsub_not_final catches it even when `$(` is not at the token start.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 27: g\$(echo i)t push with collision → exit 2 [glued cmdsub] --"

CASE27_REPO="$MASTER_TMP/case27"
setup_repo_with_origin "$CASE27_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE27_REPO" "docs/adr/0022-other.md"

run_test_in_dir 'g$(echo i)t push with collision → exit 2' 2 \
  "$CASE27_REPO" '{"command":"g$(echo i)t push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 28: git$IFS push with collision → exit 2 [ambiguous-glued token]
# Divergence form: a git-prefixed token followed by a shell metacharacter ($)
# creates an ambiguous token that could word-split to `git push` at runtime.
# canon_has_ambiguous_git_token must be checked.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 28: git\$IFS push with collision → exit 2 [ambiguous-glued token] --"

CASE28_REPO="$MASTER_TMP/case28"
setup_repo_with_origin "$CASE28_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE28_REPO" "docs/adr/0022-other.md"

run_test_in_dir 'git$IFS push with collision → exit 2' 2 \
  "$CASE28_REPO" '{"command":"git$IFS push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 29 (dc-01): Concurrent open-PR collision found → CANON WARNING, exit 0
# origin has 0022-existing.md; branch adds 0030-new-unique.md (no committed-main
# collision). A DIFFERENT open PR (#501, other-branch) also ADDs docs/adr/0030-*.md.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 29 (dc-01): concurrent open-PR collision found → CANON WARNING, exit 0 --"

CASE29_REPO="$MASTER_TMP/case29"
setup_repo_with_origin "$CASE29_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE29_REPO" "docs/adr/0030-new-unique.md"

CASE29_GH="$MASTER_TMP/case29-gh-stub.sh"
write_gh_stub "$CASE29_GH" 'cat <<JSON
[
  {"number": 501, "headRefName": "other-branch", "files": [
    {"path": "docs/adr/0030-other-slug.md", "changeType": "ADDED"}
  ]}
]
JSON'

CANON_ADR_GH_BIN="$CASE29_GH" run_test_in_dir_with_output \
  "dc-01: concurrent open-PR collision → CANON WARNING, exit 0" 0 \
  "CANON WARNING" "$CASE29_REPO" '{"command":"git push origin feature"}'

CANON_ADR_GH_BIN="$CASE29_GH" run_test_in_dir_with_output \
  "dc-01: WARNING names the colliding number 0030" 0 \
  "0030" "$CASE29_REPO" '{"command":"git push origin feature"}'

CANON_ADR_GH_BIN="$CASE29_GH" run_test_in_dir_with_output \
  "dc-01: WARNING names the other PR (#501)" 0 \
  "#501" "$CASE29_REPO" '{"command":"git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 30 (dc-02a): gh binary absent → skip silently, exit 0
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 30 (dc-02a): gh absent → skip, exit 0 --"

CASE30_REPO="$MASTER_TMP/case30"
setup_repo_with_origin "$CASE30_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE30_REPO" "docs/adr/0023-new-unique.md"

CANON_ADR_GH_BIN="/nonexistent/gh-not-installed-$$" run_test_in_dir_no_pattern \
  "dc-02a: gh absent → exit 0, no concurrent-claim warning" 0 \
  "CANON WARNING" "$CASE30_REPO" '{"command":"git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 31 (dc-02b): gh errors (unauthed/offline/any non-zero) → skip, exit 0
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 31 (dc-02b): gh error stub (exit 1) → skip, exit 0 --"

CASE31_REPO="$MASTER_TMP/case31"
setup_repo_with_origin "$CASE31_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE31_REPO" "docs/adr/0023-new-unique.md"

CASE31_GH="$MASTER_TMP/case31-gh-stub.sh"
write_gh_stub "$CASE31_GH" 'echo "HTTP 401: Bad credentials" >&2
exit 1'

CANON_ADR_GH_BIN="$CASE31_GH" run_test_in_dir_no_pattern \
  "dc-02b: gh error stub → exit 0, no concurrent-claim warning" 0 \
  "CANON WARNING" "$CASE31_REPO" '{"command":"git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 32 (dc-02c): gh returns malformed/non-JSON output → skip, exit 0
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 32 (dc-02c): gh malformed JSON → skip, exit 0 --"

CASE32_REPO="$MASTER_TMP/case32"
setup_repo_with_origin "$CASE32_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE32_REPO" "docs/adr/0023-new-unique.md"

CASE32_GH="$MASTER_TMP/case32-gh-stub.sh"
write_gh_stub "$CASE32_GH" 'echo "not json"'

CANON_ADR_GH_BIN="$CASE32_GH" run_test_in_dir_no_pattern \
  "dc-02c: gh malformed JSON → exit 0, no concurrent-claim warning" 0 \
  "CANON WARNING" "$CASE32_REPO" '{"command":"git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 33 (dc-04): gh hangs → timeboxed skip, hook returns promptly, exit 0
# CANON_ADR_OPENPR_TIMEOUT=1 keeps this test fast; the stub sleeps far longer.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 33 (dc-04): gh hang + timeout=1 → timeboxed skip, exit 0 --"

CASE33_REPO="$MASTER_TMP/case33"
setup_repo_with_origin "$CASE33_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE33_REPO" "docs/adr/0023-new-unique.md"

CASE33_GH="$MASTER_TMP/case33-gh-stub.sh"
write_gh_stub "$CASE33_GH" 'sleep 30'

CANON_ADR_GH_BIN="$CASE33_GH" CANON_ADR_OPENPR_TIMEOUT=1 run_test_in_dir_no_pattern \
  "dc-04: gh hang + timeout=1 → exit 0, no concurrent-claim warning" 0 \
  "CANON WARNING" "$CASE33_REPO" '{"command":"git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 34: no-false-positive — another open PR adds a DIFFERENT ADR number →
# no warning, exit 0
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 34: other open PR adds a different number → no warning, exit 0 --"

CASE34_REPO="$MASTER_TMP/case34"
setup_repo_with_origin "$CASE34_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE34_REPO" "docs/adr/0023-new-unique.md"

CASE34_GH="$MASTER_TMP/case34-gh-stub.sh"
write_gh_stub "$CASE34_GH" 'cat <<JSON
[
  {"number": 502, "headRefName": "other-branch", "files": [
    {"path": "docs/adr/0099-unrelated.md", "changeType": "ADDED"}
  ]}
]
JSON'

CANON_ADR_GH_BIN="$CASE34_GH" run_test_in_dir_no_pattern \
  "no-false-positive: different number on other PR → exit 0, no warning" 0 \
  "CANON WARNING" "$CASE34_REPO" '{"command":"git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 35: self-branch exclusion — the "other" PR in the gh listing is actually
# OUR OWN branch (headRefName == "feature", SAME repo — isCrossRepository:false)
# claiming the same number → excluded from comparison, no warning, exit 0
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 35: self-branch (same repo) excluded from comparison → no warning, exit 0 --"

CASE35_REPO="$MASTER_TMP/case35"
setup_repo_with_origin "$CASE35_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE35_REPO" "docs/adr/0030-new-unique.md"

CASE35_GH="$MASTER_TMP/case35-gh-stub.sh"
write_gh_stub "$CASE35_GH" 'cat <<JSON
[
  {"number": 503, "headRefName": "feature", "isCrossRepository": false, "files": [
    {"path": "docs/adr/0030-new-unique.md", "changeType": "ADDED"}
  ]}
]
JSON'

CANON_ADR_GH_BIN="$CASE35_GH" run_test_in_dir_no_pattern \
  "self-branch exclusion: own same-repo PR listed → exit 0, no warning" 0 \
  "CANON WARNING" "$CASE35_REPO" '{"command":"git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 37 (Codex P2 fix, PR #497): a FORK PR with the SAME branch name as ours
# (headRefName == "feature") but a DIFFERENT head repository
# (isCrossRepository: true) claims the SAME colliding ADR number. Branch-name-
# only self-exclusion would wrongly treat this as "our own PR" and skip it —
# a false negative on a genuine cross-fork collision. It must be COMPARED and
# WARN.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 37: fork PR with matching branch name + colliding number → WARN, exit 0 --"

CASE37_REPO="$MASTER_TMP/case37"
setup_repo_with_origin "$CASE37_REPO" "docs/adr/0022-existing.md"
add_adr "$CASE37_REPO" "docs/adr/0030-new-unique.md"

CASE37_GH="$MASTER_TMP/case37-gh-stub.sh"
write_gh_stub "$CASE37_GH" 'cat <<JSON
[
  {"number": 504, "headRefName": "feature", "isCrossRepository": true, "files": [
    {"path": "docs/adr/0030-fork-slug.md", "changeType": "ADDED"}
  ]}
]
JSON'

CANON_ADR_GH_BIN="$CASE37_GH" run_test_in_dir_with_output \
  "fork same-branch-name collision → CANON WARNING, exit 0" 0 \
  "CANON WARNING" "$CASE37_REPO" '{"command":"git push origin feature"}'

CANON_ADR_GH_BIN="$CASE37_GH" run_test_in_dir_with_output \
  "fork same-branch-name collision: WARNING names number 0030" 0 \
  "0030" "$CASE37_REPO" '{"command":"git push origin feature"}'

CANON_ADR_GH_BIN="$CASE37_GH" run_test_in_dir_with_output \
  "fork same-branch-name collision: WARNING names the fork PR (#504)" 0 \
  "#504" "$CASE37_REPO" '{"command":"git push origin feature"}'

# ─────────────────────────────────────────────────────────────────────────────
# Case 36: committed-main regression — a real committed-main collision still
# BLOCKS (exit 2) even with CANON_ADR_GH_BIN pointed at an error stub. Proves
# the open-PR scan never downgrades or is even reached on the fail-closed path.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case 36: committed-main collision still BLOCKS with gh error stub present --"

CASE36_REPO="$MASTER_TMP/case36"
setup_repo_with_origin "$CASE36_REPO" "docs/adr/0022-candidate-injection.md"
add_adr "$CASE36_REPO" "docs/adr/0022-other-slug.md"

CASE36_GH="$MASTER_TMP/case36-gh-stub.sh"
write_gh_stub "$CASE36_GH" 'exit 1'

CANON_ADR_GH_BIN="$CASE36_GH" run_test_in_dir_with_output \
  "committed-main regression: collision still exit 2 with gh error stub" 2 \
  "CANON BLOCK" "$CASE36_REPO" '{"command":"git push origin feature"}'

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
