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
# Sum CLAUDE.md deletion lines across all scribe commits via git --numstat
# ---------------------------------------------------------------------------
# --numstat outputs exact "<added>\t<deleted>\t<path>" counts per file.  This
# avoids the grep-'^---' content/header ambiguity: deleted lines whose content
# is "---" (YAML frontmatter delimiters, markdown HRs) appear as "----" in the
# unified diff, match '^---', and were undercounted by the old text-parse
# approach.  Numstat is immune to content; it counts exact git deletion counts.
DELETION_COUNT=0

for c in "${SCRIBE_COMMITS[@]}"; do
  NUMSTAT_OUTPUT=""
  # --format='' suppresses the commit header/body; only numstat lines remain.
  if ! NUMSTAT_OUTPUT=$(git show --numstat --format='' --no-color "${c}" -- CLAUDE.md ':(glob)**/CLAUDE.md' 2>&1); then
    echo "CANON: scribe-scope-guard failed-closed — git show failed for commit ${c}: $NUMSTAT_OUTPUT" >&2
    exit 2
  fi

  # Sum the deleted column (field 2) across all matching files.
  # Binary files show "-\t-\t<path>"; a non-numeric deleted field is treated as
  # a fail-closed error — CLAUDE.md is always text, but be defensive.
  # An empty NUMSTAT_OUTPUT (scribe did not touch CLAUDE.md) contributes 0.
  COMMIT_DEL=0
  while IFS=$'\t' read -r _added deleted _path; do
    [[ -z "$deleted" ]] && continue # DOCUMENTED FAIL-OPEN -- empty line from trailing newline; no deletions for this row
    if ! echo "$deleted" | grep -qE '^[0-9]+$'; then
      echo "CANON: scribe-scope-guard failed-closed — non-numeric deleted field '${deleted}' in git show --numstat for commit ${c}" >&2
      exit 2
    fi
    COMMIT_DEL=$((COMMIT_DEL + deleted))
  done <<< "$NUMSTAT_OUTPUT"

  DELETION_COUNT=$((DELETION_COUNT + COMMIT_DEL))
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
