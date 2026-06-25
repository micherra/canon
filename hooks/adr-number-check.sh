#!/bin/bash
# Canon ADR Number Collision Gate
# Runs as a PreToolUse hook on Bash commands containing "git push".
# Blocks any git push that adds a docs/adr/NNNN-*.md whose NNNN already
# exists on origin/main under a different filename (network-free local check).
#
# Input:  JSON on stdin with the tool call details
# Output: CANON BLOCK message on stdout (if collision or unresolvable origin/main)
# Exit 0: pass (non-push, parse fail, no ADRs added, no collision found)
# Exit 2: block (collision detected, or origin/main unresolvable when ADRs added)
#
# Failure-mode table:
#   Non-push command gate:              exit 0 (silent)
#   Command extraction (parse fail):    exit 0 (DOCUMENTED FAIL-OPEN — not analyzable;
#                                         gate authority is the diff, not the parse)
#   No newly-added ADRs:                exit 0 (early-out before fail-closed scope)
#   Local origin/main NNNN collision:   exit 2 on collision (FAIL-CLOSED)
#   origin/main unresolvable + ADRs:    exit 2 (FAIL-CLOSED — missed collision is unsafe)
#   origin/main unresolvable + no ADRs: exit 0 (early-out; fail-closed scoped to ADR adds)
#   Open-PR check (DEFERRED):           FAIL-OPEN-WITH-WARNING when implemented

set -euo pipefail

# shellcheck source=lib/canon-hook-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/canon-hook-lib.sh"

# Read tool input
INPUT=$(cat)

# Extract the bash command via the shared helper (jq with grep/sed fallback)
COMMAND=$(canon_extract_command "$INPUT")

# Non-push or unanalyzable command → pass silently
# DOCUMENTED FAIL-OPEN: the gate's authority is the collision diff, not command parsing;
# a non-analyzable command is not a push and cannot collide, so blocking would
# over-block arbitrary Bash with no safety benefit.
if [[ -z "$COMMAND" ]]; then
  exit 0
fi

if ! echo "$COMMAND" | grep -qE '\bgit\b.*\bpush\b'; then
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Determine newly-added ADR files (branch diff vs origin/main)
# --diff-filter=A: Added files only — excludes content-only edits and renames.
# 2>/dev/null: suppresses the git error message when origin/main is unresolvable;
#   the exit code is captured separately to detect that failure case explicitly.
# The unresolvable-ref case is NOT swallowed here — it is handled below.
# ─────────────────────────────────────────────────────────────────────────────
_DIFF_RAW=""
_DIFF_EXIT=0
_DIFF_RAW=$(git diff --name-only --diff-filter=A origin/main...HEAD -- docs/adr/ 2>/dev/null) || _DIFF_EXIT=$?

NEW_ADRS=$(echo "$_DIFF_RAW" | grep -E 'docs/adr/[0-9]{4}-.*\.md$' || true)
# DOCUMENTED FAIL-OPEN: grep exits 1 on no match; || true converts to 0.
# An empty result means either no ADRs were added or the diff itself failed.

if [[ "$_DIFF_EXIT" -ne 0 ]]; then
  # git diff failed — most likely because origin/main does not exist locally.
  # We cannot compute a merge-base diff without origin/main.
  # Fallback: check whether this branch's HEAD has ANY docs/adr/ files at all.
  # If it does, we cannot rule out a collision → fall through to the origin/main
  # check below (which will also fail → exit 2, FAIL-CLOSED).
  # If it doesn't, no collision is possible → exit 0.
  _BRANCH_ADRS=$(git ls-tree -r HEAD --name-only -- docs/adr/ 2>/dev/null \
    | grep -E 'docs/adr/[0-9]{4}-.*\.md$' || true)
  # DOCUMENTED FAIL-OPEN: if ls-tree fails or docs/adr/ is absent → empty → no risk

  if [[ -z "$_BRANCH_ADRS" ]]; then
    exit 0 # No ADR files on branch HEAD → no collision possible
  fi
  # Branch has ADR files but origin/main is unresolvable.
  # Fall through to the explicit origin/main check below.
  NEW_ADRS="$_BRANCH_ADRS"
fi

# Early-out: no newly-added ADRs → pass before any origin/main resolution.
# Fail-closed is scoped to pushes that actually add ADR files.
if [[ -z "$NEW_ADRS" ]]; then
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Resolve origin/main ADR number set (network-free: reads local ref).
# Capture the exit code explicitly — do NOT mask with || true.
# ─────────────────────────────────────────────────────────────────────────────
_LS_TREE_RAW=""
_LS_TREE_EXIT=0
_LS_TREE_RAW=$(git ls-tree origin/main docs/adr/ 2>/dev/null) || _LS_TREE_EXIT=$?
# 2>/dev/null: suppresses the git error message; exit code captured above

if [[ "$_LS_TREE_EXIT" -ne 0 ]]; then
  # origin/main unresolvable AND newly-added ADRs exist → FAIL-CLOSED.
  # A missed collision is unsafe; the user must fetch before proceeding.
  cat <<EOF
CANON BLOCK: [adr-number-check] cannot resolve origin/main to verify ADR numbers.
  Run 'git fetch origin' and retry.
  (fail-closed: a missed collision is unsafe)
EOF
  exit 2
fi

ORIGIN_NUMS=$(echo "$_LS_TREE_RAW" \
  | grep -oE 'docs/adr/[0-9]{4}' \
  | grep -oE '[0-9]{4}' \
  | sort -u || true)
# DOCUMENTED FAIL-OPEN: empty ORIGIN_NUMS = no ADRs on origin/main; no collision possible

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Check each newly-added ADR for number collision with origin/main.
# ─────────────────────────────────────────────────────────────────────────────
_COLLISION_FOUND=false
_COLLISION_NUM=""
_COLLISION_BRANCH_FILE=""
_COLLISION_ORIGIN_FILE=""

while IFS= read -r _branch_path; do
  [[ -z "$_branch_path" ]] && continue

  _branch_base=$(basename "$_branch_path")
  _adr_num=$(echo "$_branch_base" | grep -oE '^[0-9]{4}' || true)
  [[ -z "$_adr_num" ]] && continue

  # Check if this 4-digit number already exists on origin/main
  if echo "$ORIGIN_NUMS" | grep -q "^${_adr_num}$"; then
    # Find the origin/main filename for this number
    _origin_path=$(echo "$_LS_TREE_RAW" \
      | grep -oE "docs/adr/${_adr_num}-[^[:space:]]+" \
      | head -1 || true)

    if [[ -n "$_origin_path" ]]; then
      _origin_base=$(basename "$_origin_path")
      # Different filename = collision.
      # Same filename = the branch edits an existing ADR (already excluded by
      # --diff-filter=A, but guard the rename/copy edge by comparing basenames).
      if [[ "$_branch_base" != "$_origin_base" ]]; then
        _COLLISION_FOUND=true
        _COLLISION_NUM="$_adr_num"
        _COLLISION_BRANCH_FILE="$_branch_path"
        _COLLISION_ORIGIN_FILE="$_origin_path"
        break
      fi
    fi
  fi
done <<< "$NEW_ADRS"

if [[ "$_COLLISION_FOUND" == "true" ]]; then
  # Compute next-free = max(origin/main set ∪ branch set) + 1.
  # Using the union ensures the suggestion is above BOTH origin and branch numbers.
  _BRANCH_NUMS=$(echo "$NEW_ADRS" \
    | grep -oE 'docs/adr/[0-9]{4}' \
    | grep -oE '[0-9]{4}' \
    | sort -u || true)
  _ALL_NUMS=$(printf '%s\n%s\n' "$ORIGIN_NUMS" "$_BRANCH_NUMS" \
    | grep -E '^[0-9]{4}$' | sort -u)
  _MAX_NUM=$(echo "$_ALL_NUMS" | tail -1)
  _NEXT_FREE=$(printf '%04d' $((10#$_MAX_NUM + 1)))

  cat <<EOF
CANON BLOCK: [adr-number-check] ADR number collision with origin/main.
  number: ${_COLLISION_NUM}
  this branch: ${_COLLISION_BRANCH_FILE}
  origin/main: ${_COLLISION_ORIGIN_FILE}
  Renumber the new ADR to ${_NEXT_FREE} (next free), update its heading, frontmatter
  \`adr:\` field, the docs/adr/README.md index row, and any in-tree ADR-${_COLLISION_NUM} refs.
EOF
  exit 2
fi

# OPEN-PR CHECK (deferred, Decision adr-id-02):
# When implemented: use 'gh pr list' to inspect open PRs for the same NNNN.
# gh absent / unauthenticated / offline → print CANON WARNING: and skip (exit 0
# on this path — FAIL-OPEN-WITH-WARNING for the network-dependent check).
# Not implemented this build.

exit 0
