#!/usr/bin/env bash
# Tests for postcompact-narrative-capture.sh.
# Exercises: empty summary (no-op), no active workspace (no-op), active workspace
# + summary → journal entry appended with correct structure, journal entry fields
# (step_id, status, outcome.narrative, timestamps).

set -euo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/postcompact-narrative-capture.sh"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

# ── Helpers ───────────────────────────────────────────────────────────────────

# Create a temp project dir with .canon/workspaces structure.
# Optionally seed an active orchestration.db (status=active).
make_project_dir() {
  local active="${1:-0}"  # 1 = create active workspace
  local dir
  dir=$(mktemp -d)
  local ws_dir="${dir}/.canon/workspaces/canon--test-flow/test-task"
  mkdir -p "$ws_dir"

  if [[ "$active" -eq 1 ]]; then
    # Seed a minimal orchestration.db with status=active
    sqlite3 "${ws_dir}/orchestration.db" <<'SQL'
CREATE TABLE execution (
  id INTEGER PRIMARY KEY,
  slug TEXT,
  branch TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);
INSERT INTO execution (id, slug, branch, status) VALUES (1, 'test-task', 'canon/test', 'active');
SQL

    # Seed a minimal journal.json
    cat > "${ws_dir}/journal.json" <<'JSON'
{
  "steps": [],
  "version": 1,
  "workspace": "/tmp/test-workspace"
}
JSON
  fi

  echo "$dir"
}

# Run the hook with the given CANON_PROJECT_DIR and CLAUDE_COMPACT_SUMMARY
run_hook() {
  local project_dir="$1"
  local summary="${2:-}"
  CANON_PROJECT_DIR="$project_dir" CLAUDE_COMPACT_SUMMARY="$summary" bash "$HOOK"
}

# ── Test 1: Empty summary → no-op (exit 0, journal untouched) ─────────────────
DIR1=$(make_project_dir 1)
JOURNAL1="${DIR1}/.canon/workspaces/canon--test-flow/test-task/journal.json"
BEFORE1=$(cat "$JOURNAL1")

EXIT_CODE=0
run_hook "$DIR1" "" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 0 ]]; then
  fail "test1: empty summary should exit 0, got $EXIT_CODE"
fi
AFTER1=$(cat "$JOURNAL1")
if [[ "$BEFORE1" != "$AFTER1" ]]; then
  fail "test1: journal should be unchanged when summary is empty"
fi
rm -rf "$DIR1"
pass "empty summary exits 0 and leaves journal unchanged"

# ── Test 2: No active workspace → no-op (exit 0) ──────────────────────────────
DIR2=$(make_project_dir 0)

EXIT_CODE=0
run_hook "$DIR2" "Some compaction summary" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 0 ]]; then
  fail "test2: no active workspace should exit 0, got $EXIT_CODE"
fi
rm -rf "$DIR2"
pass "no active workspace exits 0 silently"

# ── Test 3: Active workspace + summary → journal entry appended ───────────────
DIR3=$(make_project_dir 1)
JOURNAL3="${DIR3}/.canon/workspaces/canon--test-flow/test-task/journal.json"

EXIT_CODE=0
run_hook "$DIR3" "Agent completed implement step. Files written: foo.ts, bar.ts." || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 0 ]]; then
  fail "test3: should exit 0 when appending, got $EXIT_CODE"
fi

# Verify journal has a step entry
STEP_COUNT=$(jq '.steps | length' "$JOURNAL3" 2>/dev/null || echo "0")
if [[ "$STEP_COUNT" -lt 1 ]]; then
  fail "test3: journal should have at least 1 step entry, got $STEP_COUNT"
fi
rm -rf "$DIR3"
pass "active workspace + summary → journal entry appended (exit 0)"

# ── Test 4: Journal entry has correct structure ────────────────────────────────
DIR4=$(make_project_dir 1)
JOURNAL4="${DIR4}/.canon/workspaces/canon--test-flow/test-task/journal.json"

NARRATIVE="Implemented auth module. Tests pass. Next: ship step."
run_hook "$DIR4" "$NARRATIVE"

# Validate step_id
STEP_ID=$(jq -r '.steps[-1].step_id' "$JOURNAL4" 2>/dev/null || echo "")
if [[ "$STEP_ID" != "compact-narrative" ]]; then
  fail "test4: step_id should be 'compact-narrative', got '$STEP_ID'"
fi

# Validate status
STATUS=$(jq -r '.steps[-1].status' "$JOURNAL4" 2>/dev/null || echo "")
if [[ "$STATUS" != "completed" ]]; then
  fail "test4: status should be 'completed', got '$STATUS'"
fi

# Validate narrative in outcome
SAVED_NARRATIVE=$(jq -r '.steps[-1].outcome.narrative' "$JOURNAL4" 2>/dev/null || echo "")
if [[ "$SAVED_NARRATIVE" != "$NARRATIVE" ]]; then
  fail "test4: outcome.narrative should match input, got '$SAVED_NARRATIVE'"
fi

# Validate timestamps are present and non-empty
STARTED_AT=$(jq -r '.steps[-1].started_at' "$JOURNAL4" 2>/dev/null || echo "")
COMPLETED_AT=$(jq -r '.steps[-1].completed_at' "$JOURNAL4" 2>/dev/null || echo "")
if [[ -z "$STARTED_AT" || "$STARTED_AT" == "null" ]]; then
  fail "test4: started_at should be set"
fi
if [[ -z "$COMPLETED_AT" || "$COMPLETED_AT" == "null" ]]; then
  fail "test4: completed_at should be set"
fi

# Validate agent_type is null
AGENT_TYPE=$(jq -r '.steps[-1].agent_type' "$JOURNAL4" 2>/dev/null || echo "missing")
if [[ "$AGENT_TYPE" != "null" ]]; then
  fail "test4: agent_type should be null, got '$AGENT_TYPE'"
fi

rm -rf "$DIR4"
pass "journal entry has correct structure (step_id, status, timestamps, outcome.narrative, agent_type=null)"

# ── Test 5: Inactive workspace (status != active) → no-op ────────────────────
DIR5=$(make_project_dir 0)
WS5="${DIR5}/.canon/workspaces/canon--test-flow/test-task"
mkdir -p "$WS5"

sqlite3 "${WS5}/orchestration.db" <<'SQL'
CREATE TABLE execution (
  id INTEGER PRIMARY KEY,
  slug TEXT,
  branch TEXT,
  status TEXT NOT NULL DEFAULT 'completed'
);
INSERT INTO execution (id, slug, branch, status) VALUES (1, 'test-task', 'canon/test', 'completed');
SQL

cat > "${WS5}/journal.json" <<'JSON'
{"steps":[],"version":1,"workspace":"/tmp/test"}
JSON

BEFORE5=$(cat "${WS5}/journal.json")
EXIT_CODE=0
run_hook "$DIR5" "Some summary" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 0 ]]; then
  fail "test5: inactive workspace should exit 0, got $EXIT_CODE"
fi
AFTER5=$(cat "${WS5}/journal.json")
if [[ "$BEFORE5" != "$AFTER5" ]]; then
  fail "test5: journal should be unchanged when workspace is not active"
fi
rm -rf "$DIR5"
pass "completed (inactive) workspace exits 0 and leaves journal unchanged"

# ── Test 6: No workspaces directory → no-op ───────────────────────────────────
DIR6=$(mktemp -d)
EXIT_CODE=0
run_hook "$DIR6" "Some summary" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 0 ]]; then
  fail "test6: missing workspaces dir should exit 0, got $EXIT_CODE"
fi
rm -rf "$DIR6"
pass "missing workspaces directory exits 0 silently"

echo "postcompact-narrative-capture.sh: all tests passed"
