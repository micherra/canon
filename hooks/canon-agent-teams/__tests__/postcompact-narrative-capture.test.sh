#!/usr/bin/env bash
# Tests for postcompact-narrative-capture.sh.
# Exercises: empty stdin (no-op), no active workspace (no-op), active workspace
# + transcript with summary → journal entry appended, journal entry fields
# (step_id, status, outcome.narrative, timestamps), malformed journal (fail-open).

set -euo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/postcompact-narrative-capture.sh"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

# ── Helpers ───────────────────────────────────────────────────────────────────

make_project_dir() {
  local active="${1:-0}"
  local dir
  dir=$(mktemp -d)
  local ws_dir="${dir}/.canon/workspaces/canon--test-flow/test-task"
  mkdir -p "$ws_dir"

  if [[ "$active" -eq 1 ]]; then
    sqlite3 "${ws_dir}/orchestration.db" <<'SQL'
CREATE TABLE execution (
  id INTEGER PRIMARY KEY,
  slug TEXT,
  branch TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);
INSERT INTO execution (id, slug, branch, status) VALUES (1, 'test-task', 'canon/test', 'active');
SQL

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

# Create a mock transcript JSONL with a summary entry
make_transcript() {
  local dir="$1"
  local summary="$2"
  local transcript="${dir}/transcript.jsonl"
  echo "{\"type\":\"summary\",\"summary\":$(jq -n --arg s "$summary" '$s')}" > "$transcript"
  echo "$transcript"
}

# Build stdin JSON for the hook (matches real Claude Code PostCompact format)
make_stdin() {
  local transcript_path="${1:-}"
  local trigger="${2:-auto}"
  local compact_summary="${3:-}"
  jq -n \
    --arg tp "$transcript_path" \
    --arg tr "$trigger" \
    --arg sid "test-session" \
    --arg cwd "/tmp" \
    --arg cs "$compact_summary" \
    '{session_id: $sid, transcript_path: $tp, cwd: $cwd, hook_event_name: "PostCompact", trigger: $tr, compact_summary: (if $cs == "" then null else $cs end)}'
}

# Run the hook with stdin JSON
run_hook() {
  local project_dir="$1"
  local stdin_json="${2:-}"
  if [[ -n "$stdin_json" ]]; then
    echo "$stdin_json" | CANON_PROJECT_DIR="$project_dir" bash "$HOOK"
  else
    echo "" | CANON_PROJECT_DIR="$project_dir" bash "$HOOK"
  fi
}

# ── Test 1: Empty stdin → no-op (exit 0, journal untouched) ─────────────────
DIR1=$(make_project_dir 1)
JOURNAL1="${DIR1}/.canon/workspaces/canon--test-flow/test-task/journal.json"
BEFORE1=$(cat "$JOURNAL1")

EXIT_CODE=0
run_hook "$DIR1" "" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 0 ]]; then
  fail "test1: empty stdin should exit 0, got $EXIT_CODE"
fi
AFTER1=$(cat "$JOURNAL1")
if [[ "$BEFORE1" != "$AFTER1" ]]; then
  fail "test1: journal should be unchanged when stdin is empty"
fi
rm -rf "$DIR1"
pass "empty stdin exits 0 and leaves journal unchanged"

# ── Test 2: No active workspace → no-op (exit 0) ──────────────────────────────
DIR2=$(make_project_dir 0)
TRANSCRIPT2=$(make_transcript "$DIR2" "Some compaction summary")
STDIN2=$(make_stdin "$TRANSCRIPT2" "auto")

EXIT_CODE=0
run_hook "$DIR2" "$STDIN2" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 0 ]]; then
  fail "test2: no active workspace should exit 0, got $EXIT_CODE"
fi
rm -rf "$DIR2"
pass "no active workspace exits 0 silently"

# ── Test 3: Active workspace + transcript → journal entry appended ───────────
DIR3=$(make_project_dir 1)
JOURNAL3="${DIR3}/.canon/workspaces/canon--test-flow/test-task/journal.json"
TRANSCRIPT3=$(make_transcript "$DIR3" "Agent completed implement step. Files written: foo.ts, bar.ts.")
STDIN3=$(make_stdin "$TRANSCRIPT3" "auto")

EXIT_CODE=0
run_hook "$DIR3" "$STDIN3" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 0 ]]; then
  fail "test3: should exit 0 when appending, got $EXIT_CODE"
fi

STEP_COUNT=$(jq '.steps | length' "$JOURNAL3" 2>/dev/null || echo "0")
if [[ "$STEP_COUNT" -lt 1 ]]; then
  fail "test3: journal should have at least 1 step entry, got $STEP_COUNT"
fi
rm -rf "$DIR3"
pass "active workspace + transcript → journal entry appended (exit 0)"

# ── Test 4: Journal entry has correct structure ────────────────────────────────
DIR4=$(make_project_dir 1)
JOURNAL4="${DIR4}/.canon/workspaces/canon--test-flow/test-task/journal.json"

NARRATIVE="Implemented auth module. Tests pass. Next: ship step."
TRANSCRIPT4=$(make_transcript "$DIR4" "$NARRATIVE")
STDIN4=$(make_stdin "$TRANSCRIPT4" "manual")
run_hook "$DIR4" "$STDIN4"

STEP_ID=$(jq -r '.steps[-1].step_id' "$JOURNAL4" 2>/dev/null || echo "")
if [[ "$STEP_ID" != "compact-narrative" ]]; then
  fail "test4: step_id should be 'compact-narrative', got '$STEP_ID'"
fi

STATUS=$(jq -r '.steps[-1].status' "$JOURNAL4" 2>/dev/null || echo "")
if [[ "$STATUS" != "completed" ]]; then
  fail "test4: status should be 'completed', got '$STATUS'"
fi

SAVED_NARRATIVE=$(jq -r '.steps[-1].outcome.narrative' "$JOURNAL4" 2>/dev/null || echo "")
if [[ "$SAVED_NARRATIVE" != "$NARRATIVE" ]]; then
  fail "test4: outcome.narrative should match input, got '$SAVED_NARRATIVE'"
fi

STARTED_AT=$(jq -r '.steps[-1].started_at' "$JOURNAL4" 2>/dev/null || echo "")
COMPLETED_AT=$(jq -r '.steps[-1].completed_at' "$JOURNAL4" 2>/dev/null || echo "")
if [[ -z "$STARTED_AT" || "$STARTED_AT" == "null" ]]; then
  fail "test4: started_at should be set"
fi
if [[ -z "$COMPLETED_AT" || "$COMPLETED_AT" == "null" ]]; then
  fail "test4: completed_at should be set"
fi

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

TRANSCRIPT5=$(make_transcript "$DIR5" "Some summary")
STDIN5=$(make_stdin "$TRANSCRIPT5" "auto")
BEFORE5=$(cat "${WS5}/journal.json")
EXIT_CODE=0
run_hook "$DIR5" "$STDIN5" || EXIT_CODE=$?
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
TRANSCRIPT6=$(make_transcript "$DIR6" "Some summary")
STDIN6=$(make_stdin "$TRANSCRIPT6" "auto")
EXIT_CODE=0
run_hook "$DIR6" "$STDIN6" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 0 ]]; then
  fail "test6: missing workspaces dir should exit 0, got $EXIT_CODE"
fi
rm -rf "$DIR6"
pass "missing workspaces directory exits 0 silently"

# ── Test 7: Malformed journal.json → no-op (exit 0, fail-open) ───────────────
DIR7=$(make_project_dir 1)
WS7="${DIR7}/.canon/workspaces/canon--test-flow/test-task"
TRANSCRIPT7=$(make_transcript "$DIR7" "Post-compact summary")
STDIN7=$(make_stdin "$TRANSCRIPT7" "auto")

echo "{ invalid json }" > "${WS7}/journal.json"
BEFORE7=$(cat "${WS7}/journal.json")

EXIT_CODE=0
run_hook "$DIR7" "$STDIN7" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 0 ]]; then
  fail "test7: malformed journal.json should exit 0 (fail-open), got $EXIT_CODE"
fi
AFTER7=$(cat "${WS7}/journal.json")
if [[ "$BEFORE7" != "$AFTER7" ]]; then
  fail "test7: malformed journal.json should be left unchanged when jq fails"
fi
rm -rf "$DIR7"
pass "malformed journal.json exits 0 (fail-open) and leaves journal unchanged"

# ── Test 8: No transcript file → fallback narrative with trigger metadata ────
DIR8=$(make_project_dir 1)
JOURNAL8="${DIR8}/.canon/workspaces/canon--test-flow/test-task/journal.json"
STDIN8=$(make_stdin "/nonexistent/transcript.jsonl" "auto")

EXIT_CODE=0
run_hook "$DIR8" "$STDIN8" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 0 ]]; then
  fail "test8: missing transcript should exit 0, got $EXIT_CODE"
fi

STEP_COUNT=$(jq '.steps | length' "$JOURNAL8" 2>/dev/null || echo "0")
if [[ "$STEP_COUNT" -lt 1 ]]; then
  fail "test8: journal should have a fallback entry, got $STEP_COUNT"
fi

SAVED_NARRATIVE=$(jq -r '.steps[-1].outcome.narrative' "$JOURNAL8" 2>/dev/null || echo "")
if [[ "$SAVED_NARRATIVE" != *"trigger: auto"* ]]; then
  fail "test8: fallback narrative should include trigger, got '$SAVED_NARRATIVE'"
fi
rm -rf "$DIR8"
pass "missing transcript → fallback narrative with trigger metadata"

# ── Test 9: compact_summary in stdin → used as narrative (primary path) ───────
DIR9=$(make_project_dir 1)
JOURNAL9="${DIR9}/.canon/workspaces/canon--test-flow/test-task/journal.json"
COMPACT_SUMMARY9="Session compacted: completed implement step, wrote auth.ts, tests green."
# Pass compact_summary directly — no transcript needed
STDIN9=$(make_stdin "" "auto" "$COMPACT_SUMMARY9")

EXIT_CODE=0
run_hook "$DIR9" "$STDIN9" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 0 ]]; then
  fail "test9: compact_summary path should exit 0, got $EXIT_CODE"
fi

STEP_COUNT=$(jq '.steps | length' "$JOURNAL9" 2>/dev/null || echo "0")
if [[ "$STEP_COUNT" -lt 1 ]]; then
  fail "test9: journal should have at least 1 step entry, got $STEP_COUNT"
fi

SAVED_NARRATIVE=$(jq -r '.steps[-1].outcome.narrative' "$JOURNAL9" 2>/dev/null || echo "")
if [[ "$SAVED_NARRATIVE" != "$COMPACT_SUMMARY9" ]]; then
  fail "test9: compact_summary should be used as narrative, got '$SAVED_NARRATIVE'"
fi
rm -rf "$DIR9"
pass "compact_summary in stdin is used as narrative (primary path)"

# ── Test 10: compact_summary absent → transcript fallback still works ──────────
DIR10=$(make_project_dir 1)
JOURNAL10="${DIR10}/.canon/workspaces/canon--test-flow/test-task/journal.json"
TRANSCRIPT_SUMMARY="Transcript fallback summary: step completed."
TRANSCRIPT10=$(make_transcript "$DIR10" "$TRANSCRIPT_SUMMARY")
# make_stdin with empty compact_summary → falls back to transcript
STDIN10=$(make_stdin "$TRANSCRIPT10" "auto" "")

EXIT_CODE=0
run_hook "$DIR10" "$STDIN10" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 0 ]]; then
  fail "test10: transcript fallback should exit 0, got $EXIT_CODE"
fi

SAVED_NARRATIVE=$(jq -r '.steps[-1].outcome.narrative' "$JOURNAL10" 2>/dev/null || echo "")
if [[ "$SAVED_NARRATIVE" != "$TRANSCRIPT_SUMMARY" ]]; then
  fail "test10: transcript summary should be used when compact_summary absent, got '$SAVED_NARRATIVE'"
fi
rm -rf "$DIR10"
pass "compact_summary absent → transcript fallback used"

echo "postcompact-narrative-capture.sh: all tests passed"
