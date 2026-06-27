#!/bin/bash
# scribe-scope-guard.sh — Post-scribe CLAUDE.md over-trim guard.
#
# Invoked by the orchestrator after the scribe step (not as a hooks.json hook).
# Signature: bash hooks/scribe-scope-guard.sh <base_commit> [threshold]
# Run from the worktree root.
#
# Counts CLAUDE.md deletion lines from the scribe's own commit(s) — commits
# carrying the 'Canon-Agent: scribe' trailer — in the range base_commit..HEAD.
# If the scribe-commit deletion count exceeds the threshold, blocks (exit 2)
# so the orchestrator can surface the count to the user for confirmation.
#
# Default threshold: 5 (the documented post-scribe prose threshold).
# Override via 2nd argument: bash hooks/scribe-scope-guard.sh <base> 20
#
# A scribe may only delete lines added by the build being context-synced, or
# demonstrably-stale references to artifacts the build deleted. The threshold
# is intentionally low to catch accidental over-trims before they reach review.
#
# Fails closed (exit 2) when:
#   - base_commit argument is missing
#   - threshold is not a non-negative integer
#   - base_commit cannot be resolved by git
#   - no commit carrying 'Canon-Agent: scribe' trailer is found in base..HEAD
#   - git show errors on any scribe-commit candidate
#
# Exit semantics:
#   Exit 0: scribe-commit deletion count at or below threshold — safe to proceed
#   Exit 2: scribe-commit deletion count exceeds threshold — surface to user (HITL)
#   Exit 2: internal error (fail-closed) — message starts with "CANON: scribe-scope-guard"

set -euo pipefail

BASE_COMMIT="${1:-}"
THRESHOLD="${2:-5}"

# ---------------------------------------------------------------------------
# Argument validation
# ---------------------------------------------------------------------------
if [[ -z "$BASE_COMMIT" ]]; then
  echo "CANON: scribe-scope-guard failed-closed — usage: scribe-scope-guard.sh <base_commit> [threshold]" >&2
  exit 2
fi

# Validate threshold is a non-negative integer
if ! echo "$THRESHOLD" | grep -qE '^[0-9]+$'; then
  echo "CANON: scribe-scope-guard failed-closed — threshold must be a non-negative integer, got: $THRESHOLD" >&2
  exit 2
fi

if ! git rev-parse --verify "$BASE_COMMIT" >/dev/null 2>&1; then
  echo "CANON: scribe-scope-guard failed-closed — invalid base commit: $BASE_COMMIT" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Enumerate scribe commits in base..HEAD via Canon-Agent: scribe trailer
# ---------------------------------------------------------------------------
SCRIBE_COMMITS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && SCRIBE_COMMITS+=("$line")
done < <(git log --no-merges --format='%H' -E --grep='^Canon-Agent: scribe[[:space:]]*$' "${BASE_COMMIT}..HEAD")

# Fail-closed when no scribe commit found — the scribe range is unidentifiable
# without the trailer; surfacing is safer than silently passing.
if [[ "${#SCRIBE_COMMITS[@]}" -eq 0 ]]; then
  echo "CANON: scribe-scope-guard failed-closed — no scribe commit (Canon-Agent: scribe) found in ${BASE_COMMIT}..HEAD" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Sum CLAUDE.md deletion lines across all scribe commits (per-commit diffs)
# ---------------------------------------------------------------------------
DELETION_COUNT=0

for c in "${SCRIBE_COMMITS[@]}"; do
  DIFF_OUTPUT=""
  # --format='' prints only the patch (no commit header/body), so prose '-' bullets
  # in the commit message body cannot be miscounted as deletion lines.
  if ! DIFF_OUTPUT=$(git show --format='' --no-color "${c}" -- CLAUDE.md ':(glob)**/CLAUDE.md' 2>&1); then
    echo "CANON: scribe-scope-guard failed-closed — git show failed for commit ${c}: $DIFF_OUTPUT" >&2
    exit 2
  fi

  # Count lines starting with '-' (deletions), excluding '---' diff headers.
  # grep exits 1 when no matches; use || true to avoid pipefail abort on empty diff.
  DELETION_LINES=$(echo "$DIFF_OUTPUT" | grep '^-' || true) # DOCUMENTED FAIL-OPEN -- no-match on empty diff; no deletions for this commit; count accumulates 0
  DELETION_LINES=$(echo "$DELETION_LINES" | grep -v '^---' || true) # DOCUMENTED FAIL-OPEN -- no-match when only headers remain; net deletions are 0
  if [[ -n "$DELETION_LINES" ]]; then
    COMMIT_DEL=$(echo "$DELETION_LINES" | grep -c '^.')
    COMMIT_DEL="${COMMIT_DEL// /}"
    DELETION_COUNT=$((DELETION_COUNT + COMMIT_DEL))
  fi
done

# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------
if [[ "$DELETION_COUNT" -gt "$THRESHOLD" ]]; then
  echo "SCRIBE-SCOPE: $DELETION_COUNT scribe-commit CLAUDE.md lines deleted (threshold $THRESHOLD) — review for over-trim." >&2
  exit 2
fi

echo "scribe-scope-guard: PASS — $DELETION_COUNT scribe-commit CLAUDE.md line(s) deleted (threshold $THRESHOLD)."
exit 0
