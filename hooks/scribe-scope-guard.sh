#!/bin/bash
# scribe-scope-guard.sh — Post-scribe CLAUDE.md over-trim guard.
#
# Invoked by the orchestrator after the scribe step (not as a hooks.json hook).
# Signature: bash hooks/scribe-scope-guard.sh <base_commit> [threshold]
# Run from the worktree root.
#
# Counts CLAUDE.md line deletions across all tracked CLAUDE.md files in the diff.
# If the deletion count exceeds the threshold, blocks (exit 2) so the orchestrator
# can surface the count to the user for confirmation.
#
# Default threshold: 5 (the documented post-scribe prose threshold).
# Override via 2nd argument: bash hooks/scribe-scope-guard.sh <base> 20
#
# A scribe may only delete lines added by the build being context-synced, or
# demonstrably-stale references to artifacts the build deleted. The threshold
# is intentionally low to catch accidental over-trims before they reach review.
#
# Exit semantics:
#   Exit 0: deletion count at or below threshold — safe to proceed
#   Exit 2: deletion count exceeds threshold — surface to user (HITL)
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

# Validate threshold is a positive integer
if ! echo "$THRESHOLD" | grep -qE '^[0-9]+$'; then
  echo "CANON: scribe-scope-guard failed-closed — threshold must be a non-negative integer, got: $THRESHOLD" >&2
  exit 2
fi

if ! git rev-parse --verify "$BASE_COMMIT" >/dev/null 2>&1; then
  echo "CANON: scribe-scope-guard failed-closed — invalid base commit: $BASE_COMMIT" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Count CLAUDE.md deletions across all tracked CLAUDE.md files
# ---------------------------------------------------------------------------
DELETION_COUNT=0
DIFF_OUTPUT=""

if ! DIFF_OUTPUT=$(git diff "${BASE_COMMIT}..HEAD" -- CLAUDE.md ':(glob)**/CLAUDE.md' 2>&1); then
  echo "CANON: scribe-scope-guard failed-closed — git diff failed: $DIFF_OUTPUT" >&2
  exit 2
fi

# Count lines starting with '-' (deletions), excluding '---' diff headers.
# grep exits 1 when no matches; use a two-step approach to avoid pipefail abort.
DELETION_LINES=$(echo "$DIFF_OUTPUT" | grep '^-' || true)
DELETION_LINES=$(echo "$DELETION_LINES" | grep -v '^---' || true)
DELETION_COUNT=$(echo "$DELETION_LINES" | grep -c '^.' || echo "0")
# Trim whitespace from wc output
DELETION_COUNT="${DELETION_COUNT// /}"

# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------
if [[ "$DELETION_COUNT" -gt "$THRESHOLD" ]]; then
  echo "SCRIBE-SCOPE: $DELETION_COUNT CLAUDE.md lines deleted (threshold $THRESHOLD) — review for over-trim." >&2
  exit 2
fi

echo "scribe-scope-guard: PASS — $DELETION_COUNT CLAUDE.md line(s) deleted (threshold $THRESHOLD)."
exit 0
