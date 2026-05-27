#!/usr/bin/env bash
# postcompact-narrative-capture.sh — PostCompact hook.
#
# When Claude Code compacts conversation context, this hook appends a narrative
# summary to the active Canon workspace journal so agents can resume without
# re-discovering completed work.
#
# Reads:
#   $CLAUDE_COMPACT_SUMMARY — compaction summary text provided by Claude Code
#   $CANON_PROJECT_DIR      — project root (defaults to current directory)
#
# Writes a step entry to ${WORKSPACE}/journal.json:
#   step_id:           "compact-narrative"
#   status:            "completed"
#   outcome.narrative: the compaction summary text
#
# Exit 0 always — this hook is advisory and must never block.

set -euo pipefail

# ── 1. Short-circuit when summary is empty ─────────────────────────────────────
SUMMARY="${CLAUDE_COMPACT_SUMMARY:-}"
if [[ -z "$SUMMARY" ]]; then
  exit 0
fi

# ── 2. Require sqlite3 (needed to query active workspace) ─────────────────────
if ! command -v sqlite3 >/dev/null 2>&1; then
  exit 0
fi

# ── 3. Resolve workspaces directory ────────────────────────────────────────────
CANON_DIR="${CANON_PROJECT_DIR:-.}/.canon"
WORKSPACES_DIR="${CANON_DIR}/workspaces"

if [[ ! -d "$WORKSPACES_DIR" ]]; then
  exit 0
fi

# ── 4. Find the active workspace by scanning orchestration.db files ────────────
WORKSPACE_DIR=""
while IFS= read -r db_path; do
  [[ -f "$db_path" ]] || continue
  db_status=$(sqlite3 "$db_path" \
    "SELECT status FROM execution WHERE id = 1 LIMIT 1;" 2>/dev/null || true)
  if [[ "$db_status" == "active" ]]; then
    WORKSPACE_DIR=$(dirname "$db_path")
    break
  fi
done < <(find "$WORKSPACES_DIR" -name "orchestration.db" -maxdepth 3 2>/dev/null)

if [[ -z "$WORKSPACE_DIR" ]]; then
  exit 0
fi

# ── 5. Append a compact-narrative entry to journal.json ───────────────────────
JOURNAL="${WORKSPACE_DIR}/journal.json"
if [[ ! -f "$JOURNAL" ]]; then
  exit 0
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

# Use jq when available (cleanest); fall back to Python (also widely available).
if command -v jq >/dev/null 2>&1; then
  jq --arg ts "$TIMESTAMP" --arg narrative "$SUMMARY" \
    '.steps += [{
      "step_id": "compact-narrative",
      "status": "completed",
      "agent_type": null,
      "artifacts_expected": [],
      "started_at": $ts,
      "completed_at": $ts,
      "outcome": { "narrative": $narrative }
    }]' "$JOURNAL" > "$TMPFILE"
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$JOURNAL" "$TIMESTAMP" "$SUMMARY" <<'PYEOF' > "$TMPFILE"
import json, sys
journal_path, ts, narrative = sys.argv[1], sys.argv[2], sys.argv[3]
with open(journal_path) as f:
    data = json.load(f)
data.setdefault("steps", []).append({
    "step_id": "compact-narrative",
    "status": "completed",
    "agent_type": None,
    "artifacts_expected": [],
    "started_at": ts,
    "completed_at": ts,
    "outcome": {"narrative": narrative},
})
print(json.dumps(data, indent=2))
PYEOF
else
  # Neither jq nor python3 available — exit silently (advisory hook)
  exit 0
fi

mv "$TMPFILE" "$JOURNAL"
exit 0
