#!/usr/bin/env bash
# baseline-orientation-metrics.sh
# Captures pre-context-assembly orientation metrics for ADR-008 validation.
# Run this BEFORE shipping context assembly changes.
#
# Usage: ./scripts/baseline-orientation-metrics.sh [project_dir]
#
# Output: Prints a markdown summary table to stdout and saves to BASELINE.md
# in the workspace directory if WORKSPACE_DIR is set.
#
# Environment variables:
#   WORKSPACE_DIR  — if set, also writes BASELINE.md to this directory

set -euo pipefail

PROJECT_DIR="${1:-.}"
CANON_DIR="$PROJECT_DIR/.canon"
DATE=$(date -u +"%Y-%m-%d")

if [ ! -d "$CANON_DIR" ]; then
  echo "Error: .canon directory not found at $CANON_DIR" >&2
  echo "Usage: $0 [project_dir]" >&2
  exit 1
fi

# Check for sqlite3
if ! command -v sqlite3 &>/dev/null; then
  echo "Error: sqlite3 CLI not found. Please install sqlite3." >&2
  exit 1
fi

# Find all orchestration.db files (bash 3.2 compatible — no mapfile)
DB_COUNT=0
DB_LIST=""
while IFS= read -r db; do
  [ -z "$db" ] && continue
  DB_LIST="$DB_LIST$db"$'\n'
  DB_COUNT=$(( DB_COUNT + 1 ))
done < <(find "$CANON_DIR/workspaces" -name "orchestration.db" 2>/dev/null | sort)

if [ "$DB_COUNT" -eq 0 ]; then
  echo "No orchestration.db files found under $CANON_DIR/workspaces" >&2
fi

# Map state_id to agent type
map_agent_type() {
  local state_id="$1"
  case "$state_id" in
    *research*)  echo "researcher" ;;
    *implement*) echo "implementor" ;;
    *review*)    echo "reviewer" ;;
    *design*)    echo "architect" ;;
    *fix*)       echo "fixer" ;;
    *test*)      echo "tester" ;;
    *ship*)      echo "shipper" ;;
    *security*)  echo "security" ;;
    *)           echo "other" ;;
  esac
}

# Collect all rows into a temp file for processing (avoids subshell variable scope issues)
TMP_ROWS=$(mktemp)
trap 'rm -f "$TMP_ROWS"' EXIT

TOTAL_ROWS=0
while IFS= read -r db; do
  [ -z "$db" ] && continue
  while IFS='|' read -r state_id oc tc turns; do
    [ -z "$state_id" ] && continue
    agent_type=$(map_agent_type "$state_id")
    echo "$agent_type|$oc|$tc|$turns" >> "$TMP_ROWS"
    TOTAL_ROWS=$(( TOTAL_ROWS + 1 ))
  done < <(sqlite3 "$db" "
    SELECT
      state_id,
      COALESCE(json_extract(metrics, '$.orientation_calls'), 0),
      COALESCE(json_extract(metrics, '$.tool_calls'), 0),
      COALESCE(json_extract(metrics, '$.turns'), 0)
    FROM execution_states
    WHERE json_extract(metrics, '$.orientation_calls') IS NOT NULL;
  " 2>/dev/null)
done <<< "$DB_LIST"

# Build output
OUTPUT="# Baseline Orientation Metrics (Pre-Context Assembly)

Date: $DATE
Scope: All completed flows in .canon/workspaces/

"

if [ "$TOTAL_ROWS" -eq 0 ]; then
  OUTPUT="${OUTPUT}**No baseline data available** — orientation_calls metric (ADR-003a) not yet populated in historical runs.

Found $DB_COUNT orchestration.db file(s), but none contained orientation_calls data.

## Notes
- This baseline was captured before ADR-008 context assembly landed
- Target: 50%+ reduction in orientation_calls after context assembly is shipped
- Metric source: execution_states.metrics in orchestration.db files
- Metric introduced: ADR-003a
"
else
  # Compute per-agent-type averages using awk
  TABLE=$(awk -F'|' '
    {
      agent = $1
      oc    = $2 + 0
      tc    = $3 + 0
      turns = $4 + 0
      sum_oc[agent]    += oc
      sum_tc[agent]    += tc
      sum_turns[agent] += turns
      count[agent]++
    }
    END {
      # Print in preferred order
      n = split("researcher implementor reviewer architect fixer tester shipper security other", order, " ")
      for (i = 1; i <= n; i++) {
        a = order[i]
        if (count[a] > 0) {
          avg_oc    = sum_oc[a]    / count[a]
          avg_tc    = sum_tc[a]    / count[a]
          avg_turns = sum_turns[a] / count[a]
          printf "| %-11s | %21.1f | %14.1f | %9.1f | %11d |\n",
            a, avg_oc, avg_tc, avg_turns, count[a]
        }
      }
    }
  ' "$TMP_ROWS")

  OUTPUT="${OUTPUT}| Agent Type  | Avg Orientation Calls | Avg Tool Calls | Avg Turns | Sample Size |
|-------------|----------------------|----------------|-----------|-------------|
${TABLE}

Total sampled states: $TOTAL_ROWS (across $DB_COUNT database(s))

## Notes
- This baseline was captured before ADR-008 context assembly landed
- Target: 50%+ reduction in orientation_calls after context assembly is shipped
- Metric source: execution_states.metrics in orchestration.db files
- Metric introduced: ADR-003a
"
fi

# Print to stdout
printf "%s" "$OUTPUT"

# Save to BASELINE.md if WORKSPACE_DIR is set
if [ -n "${WORKSPACE_DIR:-}" ]; then
  BASELINE_FILE="$WORKSPACE_DIR/BASELINE.md"
  printf "%s" "$OUTPUT" > "$BASELINE_FILE"
  echo "" >&2
  echo "Saved to: $BASELINE_FILE" >&2
fi
