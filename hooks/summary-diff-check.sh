#!/bin/bash
# summary-diff-check.sh — Deterministic summary-vs-diff phantom-claim checker.
#
# Invoked by the orchestrator post-engineer (not as a hooks.json hook).
# Signature: bash hooks/summary-diff-check.sh <summary_path> <base_commit>
# Run from the worktree root.
#
# CLAIMED FILES: parsed from the SUMMARY's "### Files" table — rows of the form:
#   | `path` | action | purpose |
#
# CLAIMED SYMBOLS: parsed from backtick-quoted identifiers in "### What Changed".
#   Conservative extraction: only identifiers that match /^[A-Za-z_$][A-Za-z0-9_$]*$/
#   (function/type/constant names). Symbol prose that describes old names without
#   being in backticks will NOT false-block. Limitation: a renamed symbol where both
#   old and new names appear in backticks in the prose but only the new name is in
#   the diff may produce a phantom hit; this is a known acceptable false-positive
#   rate — see risk-mitigation note in dvh-02-PLAN.md. Test: renamed symbol described
#   by new name accurately → no false block (see .test.sh).
#
# Exit semantics:
#   Exit 0: clean (no phantom claims, possibly advisory unreported changes)
#   Exit 2: PHANTOM claim found (file or symbol) — BLOCKS review
#   Exit 2: internal error (fail-closed) — message starts with "CANON: summary-diff-check"

set -euo pipefail

SUMMARY_PATH="${1:-}"
BASE_COMMIT="${2:-}"

# ---------------------------------------------------------------------------
# Argument validation
# ---------------------------------------------------------------------------
if [[ -z "$SUMMARY_PATH" ]] || [[ -z "$BASE_COMMIT" ]]; then
  echo "CANON: summary-diff-check failed-closed — usage: summary-diff-check.sh <summary_path> <base_commit>" >&2
  exit 2
fi

if [[ ! -f "$SUMMARY_PATH" ]]; then
  echo "CANON: summary-diff-check failed-closed — summary file not found: $SUMMARY_PATH" >&2
  exit 2
fi

if ! git rev-parse --verify "$BASE_COMMIT" >/dev/null 2>&1; then
  echo "CANON: summary-diff-check failed-closed — invalid base commit: $BASE_COMMIT" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Collect the actual changed file set
# ---------------------------------------------------------------------------
CHANGED_FILES=""
if ! CHANGED_FILES=$(git diff --name-only "${BASE_COMMIT}..HEAD" 2>&1); then
  echo "CANON: summary-diff-check failed-closed — git diff failed: $CHANGED_FILES" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Collect the diff body for symbol search
# ---------------------------------------------------------------------------
DIFF_BODY=""
if ! DIFF_BODY=$(git diff "${BASE_COMMIT}..HEAD" 2>&1); then
  echo "CANON: summary-diff-check failed-closed — git diff (body) failed: $DIFF_BODY" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Parse CLAIMED files from the "### Files" table in the summary.
# Rows: | `path` | ... | ...  or  | path | ... | ...
# Extract the first column cell, strip backticks and whitespace.
# ---------------------------------------------------------------------------
parse_claimed_files() {
  local summary="$1"
  # Look for lines that are inside the ### Files section (table rows starting with |)
  # Extract the path from the first column (between first and second |)
  # Handle both `path` and plain path forms.
  awk '
    /^### Files/ { in_section=1; next }
    /^###/ && in_section { in_section=0 }
    in_section && /^\|/ {
      # Extract first column content between first and second |
      # Remove leading | and take up to the next |
      line=$0
      sub(/^\|/, "", line)
      n=split(line, parts, "|")
      if (n >= 1) {
        cell=parts[1]
        # Strip backticks
        gsub(/`/, "", cell)
        # Strip leading/trailing whitespace
        gsub(/^[[:space:]]+/, "", cell)
        gsub(/[[:space:]]+$/, "", cell)
        # Skip header separator rows (all dashes) and empty cells
        if (cell ~ /^[-:[:space:]]+$/ || cell == "") next
        # Skip column header rows
        if (cell == "File" || cell == "Files" || cell == "Path" || cell == "path") next
        print cell
      }
    }
  ' <<< "$summary"
}

# ---------------------------------------------------------------------------
# Parse CLAIMED symbols from backtick-quoted identifiers in "### What Changed".
# Conservative: only simple identifiers (function/type/variable names).
# Excludes: paths, shell commands, markdown formatting artifacts.
# ---------------------------------------------------------------------------
parse_claimed_symbols() {
  local summary="$1"
  # Extract the "### What Changed" section
  awk '
    /^### What Changed/ { in_section=1; next }
    /^###/ && in_section { in_section=0 }
    in_section { print }
  ' <<< "$summary" | \
  # Extract all backtick-quoted tokens
  grep -oE '`[^`]+`' | \
  # Strip backticks
  sed 's/`//g' | \
  # Keep only valid identifier-shaped tokens (not paths, not expressions)
  grep -E '^[A-Za-z_$][A-Za-z0-9_$]*$' | \
  sort -u
}

# ---------------------------------------------------------------------------
# Main logic
# ---------------------------------------------------------------------------
SUMMARY_CONTENT=""
SUMMARY_CONTENT=$(cat "$SUMMARY_PATH")

PHANTOM_COUNT=0
ADVISORY_COUNT=0

# -- Check claimed files --
while IFS= read -r claimed_file; do
  [[ -z "$claimed_file" ]] && continue

  if ! echo "$CHANGED_FILES" | grep -qxF "$claimed_file"; then
    echo "PHANTOM-CLAIM (file): $claimed_file claimed in SUMMARY but absent from diff."
    PHANTOM_COUNT=$((PHANTOM_COUNT + 1))
  fi
done < <(parse_claimed_files "$SUMMARY_CONTENT")

# -- Check unreported changes (advisory only) --
while IFS= read -r changed_file; do
  [[ -z "$changed_file" ]] && continue

  # Build the full set of claimed files for this check
  if ! parse_claimed_files "$SUMMARY_CONTENT" | grep -qxF "$changed_file"; then
    echo "ADVISORY (unreported change): $changed_file in diff but not in SUMMARY."
    ADVISORY_COUNT=$((ADVISORY_COUNT + 1))
  fi
done <<< "$CHANGED_FILES"

# -- Check claimed symbols --
while IFS= read -r symbol; do
  [[ -z "$symbol" ]] && continue

  if ! echo "$DIFF_BODY" | grep -qF "$symbol"; then
    echo "PHANTOM-CLAIM (symbol): $symbol claimed in ### What Changed but absent from diff."
    PHANTOM_COUNT=$((PHANTOM_COUNT + 1))
  fi
done < <(parse_claimed_symbols "$SUMMARY_CONTENT")

# ---------------------------------------------------------------------------
# Final verdict
# ---------------------------------------------------------------------------
if [[ "$PHANTOM_COUNT" -gt 0 ]]; then
  echo "summary-diff-check: BLOCKED — $PHANTOM_COUNT phantom claim(s) found. Resolve before review." >&2
  exit 2
fi

echo "summary-diff-check: PASS — 0 phantoms, $ADVISORY_COUNT advisory unreported change(s)."
exit 0
