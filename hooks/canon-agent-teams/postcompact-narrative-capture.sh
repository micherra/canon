#!/usr/bin/env bash
# postcompact-narrative-capture.sh — PostCompact hook.
#
# When Claude Code compacts conversation context, this hook appends a narrative
# summary to the active Canon workspace journal so agents can resume without
# re-discovering completed work.
#
# Input: JSON on stdin (Claude Code PostCompact hook format).
#   Fields used: compact_summary (primary), transcript_path (fallback), session_id, trigger.
#   compact_summary is the direct compaction text provided by Claude Code.
#
# Reads:
#   $CANON_PROJECT_DIR — project root (defaults to current directory)
#
# Writes a step entry to ${WORKSPACE}/journal.json:
#   step_id:           "compact-narrative"
#   status:            "completed"
#   outcome.narrative: the compaction summary text
#
# Exit 0 always — this hook is advisory and must never block.

set -euo pipefail

# ── 1. Read hook input from stdin ─────────────────────────────────────────────
INPUT=$(cat 2>/dev/null || true)
if [[ -z "$INPUT" ]]; then
  exit 0
fi

# ── 2. Extract compaction summary ─────────────────────────────────────────────
# Priority order:
#   1. compact_summary field directly from stdin JSON (primary — Claude Code provides this)
#   2. transcript JSONL file (fallback — legacy extraction path)
#   3. trigger-based generic message (last resort)

# Primary: read compact_summary directly from stdin JSON
SUMMARY=""
if command -v jq >/dev/null 2>&1; then
  SUMMARY=$(echo "$INPUT" | jq -r '.compact_summary // empty' 2>/dev/null || true)
elif command -v python3 >/dev/null 2>&1; then
  SUMMARY=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('compact_summary',''))" 2>/dev/null || true)
fi

# Fallback 1: extract from transcript JSONL if compact_summary was absent
if [[ -z "$SUMMARY" ]]; then
  TRANSCRIPT_PATH=""
  if command -v jq >/dev/null 2>&1; then
    TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null || true)
  elif command -v python3 >/dev/null 2>&1; then
    TRANSCRIPT_PATH=$(echo "$INPUT" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('transcript_path',''))" 2>/dev/null || true)
  fi

  if [[ -n "$TRANSCRIPT_PATH" && -f "$TRANSCRIPT_PATH" ]]; then
    if command -v jq >/dev/null 2>&1; then
      SUMMARY=$(tail -20 "$TRANSCRIPT_PATH" | jq -r 'select(.type == "summary" or .type == "compact") | .summary // .content // empty' 2>/dev/null | tail -1 || true)
    fi
  fi
fi

# Fallback 2: build a minimal narrative from the hook input metadata
if [[ -z "$SUMMARY" ]]; then
  TRIGGER=$(echo "$INPUT" | jq -r '.trigger // "unknown"' 2>/dev/null || echo "unknown")
  SUMMARY="Context compacted (trigger: ${TRIGGER}). Prior conversation was summarized. Check transcript for details."
fi

# ── 3. Require sqlite3 (needed to query active workspace) ─────────────────────
if ! command -v sqlite3 >/dev/null 2>&1; then
  exit 0
fi

# ── 4. Resolve workspaces directory ────────────────────────────────────────────
CANON_DIR="${CANON_PROJECT_DIR:-.}/.canon"
WORKSPACES_DIR="${CANON_DIR}/workspaces"

if [[ ! -d "$WORKSPACES_DIR" ]]; then
  exit 0
fi

# ── 5. Find the active workspace by scanning orchestration.db files ────────────
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

# ── 6. Append a compact-narrative entry to journal.json ───────────────────────
JOURNAL="${WORKSPACE_DIR}/journal.json"
if [[ ! -f "$JOURNAL" ]]; then
  exit 0
fi

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
TMPFILE=$(mktemp)
trap 'rm -f "$TMPFILE"' EXIT

# Use jq when available (cleanest); fall back to Python (also widely available).
# Capture exit codes explicitly — set -e is suppressed inside || expressions
# so we must check manually to keep the advisory (fail-open) contract intact.
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
    }]' "$JOURNAL" > "$TMPFILE" || exit 0
elif command -v python3 >/dev/null 2>&1; then
  python3 - "$JOURNAL" "$TIMESTAMP" "$SUMMARY" <<'PYEOF' > "$TMPFILE" || exit 0
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
