#!/usr/bin/env bash
# session-start-context.sh — SessionStart hook that synthesizes project state
# as invisible context for the orchestrator.
#
# Outputs a brief project pulse: recent builds, drift status, convention count.
# Advisory only — always exits 0.

set -euo pipefail

CANON_DIR="${CANON_PROJECT_DIR:-.}/.canon"
DRIFT_DB="${CANON_DIR}/drift.db"
CONVENTIONS_FILE="${CANON_DIR}/CONVENTIONS.md"
WORKSPACES_DIR="${CANON_DIR}/workspaces"

# Graceful degradation: if no Canon data exists, output nothing
if [[ ! -d "$CANON_DIR" ]]; then
  exit 0
fi

echo "CANON PROJECT PULSE:"

# 1. Recent builds (last 5 workspace sessions)
if [[ -d "$WORKSPACES_DIR" ]] && command -v sqlite3 &>/dev/null; then
  RECENT_BUILDS=""
  BUILD_COUNT=0
  while IFS= read -r db_path; do
    if (( BUILD_COUNT >= 5 )); then break; fi
    ROW=$(sqlite3 "$db_path" "SELECT slug, flow_name, status FROM execution LIMIT 1;" 2>/dev/null) || continue
    [[ -z "$ROW" ]] && continue
    IFS='|' read -r slug flow status <<< "$ROW"
    RECENT_BUILDS+="  - ${slug} (${flow:-unknown}, ${status:-unknown})"$'\n'
    BUILD_COUNT=$((BUILD_COUNT + 1))
  done < <(find "$WORKSPACES_DIR" -name "orchestration.db" -maxdepth 3 2>/dev/null)
  if [[ -n "$RECENT_BUILDS" ]]; then
    echo "  Recent builds:"
    echo "$RECENT_BUILDS"
  fi
fi

# 2. Drift status (if drift.db exists)
if [[ -f "$DRIFT_DB" ]] && command -v sqlite3 &>/dev/null; then
  VIOLATION_COUNT=$(sqlite3 "$DRIFT_DB" "SELECT COUNT(*) FROM violations;" 2>/dev/null || echo "0")
  if [[ "$VIOLATION_COUNT" != "0" ]]; then
    echo "  Open drift violations: ${VIOLATION_COUNT}"
    TOP_PRINCIPLES=$(sqlite3 "$DRIFT_DB" "SELECT principle_id, COUNT(*) as c FROM violations GROUP BY principle_id ORDER BY c DESC LIMIT 3;" 2>/dev/null || true)
    if [[ -n "$TOP_PRINCIPLES" ]]; then
      echo "  Top violated principles:"
      echo "$TOP_PRINCIPLES" | while IFS='|' read -r pid count; do
        echo "    - ${pid} (${count} open)"
      done
    fi
  fi
fi

# 3. Convention count
if [[ -f "$CONVENTIONS_FILE" ]]; then
  CONV_COUNT=$(grep -c "^- \*\*" "$CONVENTIONS_FILE" 2>/dev/null || echo "0")
  echo "  Active conventions: ${CONV_COUNT}"
fi

# 4. Learning suggestions (open count)
LEARNING_FILE="${CANON_DIR}/LEARNING-REPORT.md"
if [[ -f "$LEARNING_FILE" ]]; then
  SUGGESTION_COUNT=$(grep -c "^##\? \*\*" "$LEARNING_FILE" 2>/dev/null || echo "0")
  if [[ "$SUGGESTION_COUNT" != "0" ]]; then
    echo "  Open learning suggestions: ${SUGGESTION_COUNT}"
  fi
fi

exit 0
