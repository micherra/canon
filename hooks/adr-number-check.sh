#!/bin/bash
# Canon ADR Number Collision Gate
# Runs as a PreToolUse hook on Bash commands that invoke a real "git push"
# subcommand. Blocks any git push that adds a docs/adr/NNNN-*.md whose NNNN
# already exists on origin/main under a different filename (network-free local check).
#
# Push detection: per-segment canon_git_subcommand (replaces the coarse
#   grep -qE '\bgit\b.*\bpush\b' that over-matched e.g. git commit -m "push fix").
#   Leading group-openers ( and { are stripped per segment before subcommand
#   resolution so that "(git push)" is correctly detected as a push.
# cwd-scoping: git queries are scoped to the repo being pushed via
#   canon_git_dir_directive_raw + the GDA array (fixes the cwd fail-OPEN).
#   git -C takes final precedence over shell cd (git's actual algorithm).
# unmodeled-redirect gate (allowlist posture, adr-cwd-02): only provably-safe,
#   fully-modeled forms are allowed (optional literal cd-prefix + git -C literal).
#   --git-dir/--work-tree/--namespace flags, GIT_*= env prefixes, pushd, subshell,
#   multi-cd, command substitution, and eval trigger fail-closed (exit 2) via
#   canon_cwd_redirect_is_modeled. Gate fires AFTER the no-ADR early-out so that
#   a non-ADR push with an exotic redirect is not over-blocked.
#
# Input:  JSON on stdin with the tool call details
# Output: CANON BLOCK message on stdout (if collision or unresolvable origin/main)
# Exit 0: pass (non-push, parse fail, no ADRs added, no collision found)
# Exit 2: block (collision detected, or origin/main unresolvable when ADRs added)
#
# Failure-mode table:
#   Non-push command gate:                exit 0 (silent)
#   Command extraction (parse fail):      exit 0 (DOCUMENTED FAIL-OPEN — not analyzable;
#                                           gate authority is the diff, not the parse)
#   No newly-added ADRs:                  exit 0 (early-out before fail-closed scope)
#   Unmodeled cwd-redirect + ADRs:        exit 2 (FAIL-CLOSED — allowlist rejects
#                                           --git-dir/--work-tree/--namespace flags,
#                                           GIT_*= env prefixes, pushd, subshell,
#                                           multi-cd, command substitution, eval;
#                                           gate fires AFTER the no-ADR early-out
#                                           so non-ADR pushes are not over-blocked;
#                                           decisions adr-cwd-01, adr-cwd-02)
#   cd/-C directive unresolvable + ADRs:  exit 2 (FAIL-CLOSED — cannot scope collision
#                                           check; decision adr-cwd-01)
#   Local origin/main NNNN collision:     exit 2 on collision (FAIL-CLOSED)
#   origin/main unresolvable + ADRs:      exit 2 (FAIL-CLOSED — missed collision is unsafe)
#   origin/main unresolvable + no ADRs:   exit 0 (early-out; fail-closed scoped to ADR adds)
#   Open-PR check (DEFERRED):             FAIL-OPEN-WITH-WARNING when implemented
#
# Parser-fail-open justification (security-hook-parser-allowlist-posture):
# The non-push gate and the parse-fail path (lines 37–43) are denylist-shaped:
# unrecognised or unparseable commands exit 0 silently. This is safe because a
# parse miss SKIPS the collision check entirely (exit 0 at the empty-COMMAND guard,
# before the diff at Step 1). Safety then rests on two backstops: (1) jq-presence
# is required for reliable extraction (lib/canon-hook-lib.sh fails closed without it),
# and (2) branch-protection / PR-review catches any ADR collision that slips a missed
# push. A missed collision here produces a silent duplicate ADR number (two docs/adr/NNNN-*.md
# files sharing the same NNNN under different slugs on origin/main), caught only later by
# chance — it is not an undetectable breach, but it is not self-correcting either.
# The only fail-closed scope is: "a push that adds a new docs/adr/NNNN-*.md whose NNNN
# already exists on origin/main." That surface is fail-CLOSED (exit 2). The command
# parse is a coarse pre-filter only; its fail-open posture is therefore consequence-safe.

set -euo pipefail

# shellcheck source=lib/canon-hook-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/canon-hook-lib.sh"

# Read tool input
INPUT=$(cat)

# Extract the bash command via the shared helper (jq with grep/sed fallback)
COMMAND=$(canon_extract_command "$INPUT")

# Non-push or unanalyzable command → pass silently
# DOCUMENTED FAIL-OPEN: the gate's authority is the collision diff, not command parsing;
# an unanalyzable command is indistinguishable from a non-push and cannot cause an ADR
# collision regardless, so blocking would over-block arbitrary Bash with no safety benefit.
#
# INTENTIONAL DIVERGENCE from destructive-guard/pre-commit-check: those hooks must
# analyze ALL Bash commands for destructive patterns, so they fail CLOSED (exit 2) on
# an empty COMMAND. This hook is a collision gate for git push only — it sees ALL Bash
# but only acts on push-shaped commands. A parse miss here is consequence-safe (silent
# duplicate ADR number at worst; backstopped by jq-presence requirement + branch-protection).
if [[ -z "$COMMAND" ]]; then
  exit 0
fi

# Strip shell comments, then detect a REAL 'git push' subcommand per clause.
# Delegates to canon_git_subcommand (the authoritative global-option-aware parser)
# instead of a coarse 'git ... push' regex that over-matches e.g. git commit -m "push fix".
# Per-segment detection is required because canon_git_subcommand resolves only the FIRST
# git token in a compound command — a compound "... && git push" would be missed by a
# single whole-command call (Probe D / DESIGN.md).
# Leading group-openers ( and { are stripped per segment so that "(git push)" is
# correctly detected; the trailing ) in " git push)" after && splitting is not a
# problem because canon_git_subcommand resolves the subcommand before trailing tokens.
COMMAND=$(printf '%s' "$COMMAND" | canon_strip_comments)
_IS_PUSH=false
while IFS= read -r _seg; do
  _seg=$(printf '%s' "$_seg" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
  [[ -z "$_seg" ]] && continue
  # Strip leading group-openers before subcommand resolution (handles "(git push)").
  _seg_for_sub=$(printf '%s' "$_seg" | sed -E 's/^[({]+//')
  if [[ "$(canon_git_subcommand "$_seg_for_sub" || true)" == "push" ]]; then  # DOCUMENTED FAIL-OPEN -- non-push segment returns empty/non-push; loop continues
    _IS_PUSH=true
    break
  fi
done <<< "$(printf '%s' "$COMMAND" | sed -E 's/(&&|\|\||;|\|)/\n/g')"

if [[ "$_IS_PUSH" != "true" ]]; then
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# Resolve the git repo being pushed and build the GDA (-C <dir>) scoping array.
#
# Step B: Resolve directive with -C-wins precedence (git's actual algorithm).
#   git -C <dir> takes final precedence over a shell cd-prefix.
#   Existence-agnostic: distinguishes "no directive" (use hook cwd) from
#   "directive present but unresolvable" (fail-closed: cannot scope the check).
#
# Step 1: Determine newly-added ADR files (branch diff vs origin/main).
#   Early-out if no ADRs → exit 0. Fail-closed is scoped to ADR-adding pushes.
#
# Step A: Allowlist gate (fires AFTER no-ADR early-out).
#   Only fires when the push actually adds ADRs, so non-ADR pushes with exotic
#   redirects are not over-blocked. Allowlist posture: only provably-safe,
#   fully-modeled forms are allowed (optional literal cd + git -C literal).
#   --git-dir/--work-tree/--namespace flags, GIT_*= env prefixes, pushd, subshell,
#   multi-cd, command substitution, and eval all trigger exit 2. (adr-cwd-01/02)
# ─────────────────────────────────────────────────────────────────────────────

# Step B: Directive resolution.
# canon_git_dir_directive_raw applies -C-wins precedence (git's actual algorithm).
# empty result = no cd/-C directive → use hook cwd
_GIT_DIR_RAW=$(canon_git_dir_directive_raw "$COMMAND" || true)  # DOCUMENTED FAIL-OPEN -- empty = no modeled directive; hook cwd is used; Step A (below) validates the form when ADRs are present
declare -a GDA=()
if [[ -n "$_GIT_DIR_RAW" ]]; then
  if [[ -d "$_GIT_DIR_RAW" ]]; then
    GDA=(-C "$_GIT_DIR_RAW")
  else
    # Directive present but target directory unresolvable + this is a push →
    # cannot scope the collision check to the target repo → FAIL-CLOSED.
    # Silently using cwd would be a fail-OPEN: cwd may not be the pushed repo.
    cat <<EOF
CANON BLOCK: [adr-number-check] cannot resolve the push target directory '${_GIT_DIR_RAW}'.
  The cd/-C target does not exist, so the ADR-number collision check cannot be
  scoped to the repo being pushed. Use an absolute existing path, or run the
  push from the repo directory.
  (fail-closed: a missed collision is unsafe)
EOF
    exit 2
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Determine newly-added ADR files (branch diff vs origin/main)
# --diff-filter=A: Added files only — excludes content-only edits and renames.
# 2>/dev/null: suppresses the git error message when origin/main is unresolvable;
#   the exit code is captured separately to detect that failure case explicitly.
# The unresolvable-ref case is NOT swallowed here — it is handled below.
# All git queries use ${GDA[@]+"${GDA[@]}"} to scope to the pushed repo when
# a -C or cd directive was resolved above (bash 3.2 / set -u safe idiom).
# ─────────────────────────────────────────────────────────────────────────────
_DIFF_RAW=""
_DIFF_EXIT=0
_DIFF_RAW=$(git ${GDA[@]+"${GDA[@]}"} diff --name-only --diff-filter=A --no-renames origin/main..HEAD -- docs/adr/ 2>/dev/null) || _DIFF_EXIT=$?

NEW_ADRS=$(echo "$_DIFF_RAW" | grep -E 'docs/adr/[0-9]{4}-.*\.md$' || true)  # DOCUMENTED FAIL-OPEN -- grep exits 1 on no-match; empty = no ADRs added or diff failed

if [[ "$_DIFF_EXIT" -ne 0 ]]; then
  # git diff failed — most likely because origin/main does not exist locally.
  # We cannot compute a merge-base diff without origin/main.
  # Fallback: check whether this branch's HEAD has ANY docs/adr/ files at all.
  # If it does, we cannot rule out a collision → fall through to the origin/main
  # check below (which will also fail → exit 2, FAIL-CLOSED).
  # If it doesn't, no collision is possible → exit 0.
  _BRANCH_ADRS=$(git ${GDA[@]+"${GDA[@]}"} ls-tree -r HEAD --name-only -- docs/adr/ 2>/dev/null \
    | grep -E 'docs/adr/[0-9]{4}-.*\.md$' || true)  # DOCUMENTED FAIL-OPEN -- empty = ls-tree failed or docs/adr/ absent; no ADRs = no collision risk

  if [[ -z "$_BRANCH_ADRS" ]]; then
    exit 0 # No ADR files on branch HEAD → no collision possible
  fi
  # Branch has ADR files but origin/main is unresolvable.
  # Fall through to the explicit origin/main check below.
  NEW_ADRS="$_BRANCH_ADRS"
fi

# Early-out: no newly-added ADRs → exit 0 before the allowlist gate and origin/main check.
# Fail-closed is scoped to pushes that actually add ADR files (adr-cwd-01).
if [[ -z "$NEW_ADRS" ]]; then
  exit 0
fi

# Step A: Allowlist gate — only reached when ADRs are being added.
# Allowlist posture (security-hook-parser-allowlist-posture): the command must
# consist ONLY of provably-safe, fully-modeled forms. Anything else fails closed.
# Firing after the no-ADR early-out means non-ADR pushes with exotic redirects
# (pushd, subshell, etc.) are not over-blocked. (adr-cwd-02)
if ! canon_cwd_redirect_is_modeled "$COMMAND"; then
  cat <<EOF
CANON BLOCK: [adr-number-check] unrecognized cwd-redirect in push command (allowlist).
  The command contains a cwd-redirecting construct (--git-dir/--work-tree/--namespace
  flag, GIT_* env prefix, pushd, subshell, multiple cd, command substitution, or eval)
  that the ADR-number resolver does not fully model. The collision check cannot be
  reliably scoped to the pushed repo.
  Use 'git -C <path> push' or 'cd <path> && git push' to specify the target repo
  explicitly with a form the resolver can verify.
  (fail-closed: only provably-safe modeled forms are allowed when ADRs are being added)
EOF
  exit 2
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Resolve origin/main ADR number set (network-free: reads local ref).
# Capture the exit code explicitly — do NOT mask with || true.
# ─────────────────────────────────────────────────────────────────────────────
_LS_TREE_RAW=""
_LS_TREE_EXIT=0
_LS_TREE_RAW=$(git ${GDA[@]+"${GDA[@]}"} ls-tree origin/main docs/adr/ 2>/dev/null) || _LS_TREE_EXIT=$?
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
  | sort -u || true)  # DOCUMENTED FAIL-OPEN -- empty ORIGIN_NUMS = no ADRs on origin/main; no collision possible

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
  _adr_num=$(echo "$_branch_base" | grep -oE '^[0-9]{4}' || true)  # DOCUMENTED FAIL-OPEN -- grep exits 1 on no-match; non-ADR basename dropped by [[ -z "$_adr_num" ]] guard below
  [[ -z "$_adr_num" ]] && continue

  # Check if this 4-digit number already exists on origin/main
  if echo "$ORIGIN_NUMS" | grep -q "^${_adr_num}$"; then
    # Find the origin/main filename for this number
    _origin_path=$(echo "$_LS_TREE_RAW" \
      | grep -oE "docs/adr/${_adr_num}-[^[:space:]]+" \
      | head -1 || true)  # DOCUMENTED FAIL-OPEN -- empty _origin_path skips collision block; [[ -n "$_origin_path" ]] guard below

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
    | sort -u || true)  # DOCUMENTED FAIL-OPEN -- empty _BRANCH_NUMS is union-safe; printf '%s\n%s\n' with empty arg produces only ORIGIN_NUMS lines
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
