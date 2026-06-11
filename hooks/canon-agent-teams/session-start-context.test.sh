#!/usr/bin/env bash
# session-start-context.test.sh — Tests for session-start-context.sh
#
# Tests:
#  - no drift.db: no drift output (graceful degradation)
#  - drift.db with 1 open + 1 resolved violation: reports "Open drift violations: 1"
#  - drift.db with only resolved violations: no "Open drift violations" line
#  - pre-v10 drift.db (no status column): count degrades to 0, exits 0 (fail-open)
#  - no .canon dir: exits 0 with no output

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${SCRIPT_DIR}/session-start-context.sh"

# shellcheck source=../test-helpers.sh
source "${SCRIPT_DIR}/../test-helpers.sh"

PASS=0
FAIL=0

# ---------------------------------------------------------------------------
# Helper: create a temp .canon dir with drift.db
# ---------------------------------------------------------------------------
make_canon_dir() {
  local tmpdir
  tmpdir=$(mktemp -d)
  mkdir -p "${tmpdir}/.canon"
  echo "$tmpdir"
}

create_v10_drift_db() {
  local db_path="$1"
  sqlite3 "$db_path" <<'SQL'
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta VALUES ('schema_version', '10');
CREATE TABLE violations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL,
  principle_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  file_path TEXT,
  impact_score REAL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_at TEXT,
  resolved_by_review_id TEXT,
  resolution_reason TEXT
);
SQL
}

# ---------------------------------------------------------------------------
# Test 1: no .canon directory → exits 0 with no output
# ---------------------------------------------------------------------------
run_test_in_dir_no_pattern \
  "no .canon dir → exits 0, no output" \
  "CANON PROJECT PULSE" \
  "$HOOK" \
  "$(mktemp -d)"

# ---------------------------------------------------------------------------
# Test 2: .canon dir exists but no drift.db → exits 0, no drift violation line
# ---------------------------------------------------------------------------
TMPDIR1=$(make_canon_dir)
run_test_in_dir_no_pattern \
  "no drift.db → no drift violations line" \
  "Open drift violations" \
  "$HOOK" \
  "$TMPDIR1"
rm -rf "$TMPDIR1"

# ---------------------------------------------------------------------------
# Test 3: drift.db with 1 open + 1 resolved violation → reports "Open drift violations: 1"
# ---------------------------------------------------------------------------
TMPDIR2=$(make_canon_dir)
DB2="${TMPDIR2}/.canon/drift.db"
create_v10_drift_db "$DB2"
sqlite3 "$DB2" <<'SQL'
INSERT INTO violations (review_id, principle_id, severity, status) VALUES
  ('rev_001', 'deep-modules', 'rule', 'open'),
  ('rev_001', 'thin-handlers', 'strong-opinion', 'resolved');
SQL

export CANON_PROJECT_DIR="$TMPDIR2"
run_test_in_dir_with_output \
  "1 open + 1 resolved → reports 'Open drift violations: 1'" \
  "Open drift violations: 1" \
  "$HOOK" \
  "$TMPDIR2"
unset CANON_PROJECT_DIR
rm -rf "$TMPDIR2"

# ---------------------------------------------------------------------------
# Test 4: drift.db with only resolved violations → no drift violations line
# ---------------------------------------------------------------------------
TMPDIR3=$(make_canon_dir)
DB3="${TMPDIR3}/.canon/drift.db"
create_v10_drift_db "$DB3"
sqlite3 "$DB3" <<'SQL'
INSERT INTO violations (review_id, principle_id, severity, status) VALUES
  ('rev_001', 'deep-modules', 'rule', 'resolved'),
  ('rev_001', 'thin-handlers', 'strong-opinion', 'resolved');
SQL

export CANON_PROJECT_DIR="$TMPDIR3"
run_test_in_dir_no_pattern \
  "all resolved violations → no drift violations line" \
  "Open drift violations" \
  "$HOOK" \
  "$TMPDIR3"
unset CANON_PROJECT_DIR
rm -rf "$TMPDIR3"

# ---------------------------------------------------------------------------
# Test 5: pre-v10 drift.db (no status column) → count degrades to 0, exits 0
# ---------------------------------------------------------------------------
TMPDIR4=$(make_canon_dir)
DB4="${TMPDIR4}/.canon/drift.db"
sqlite3 "$DB4" <<'SQL'
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO meta VALUES ('schema_version', '9');
CREATE TABLE violations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id TEXT NOT NULL,
  principle_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  file_path TEXT,
  impact_score REAL,
  message TEXT
);
INSERT INTO violations (review_id, principle_id, severity) VALUES
  ('rev_001', 'deep-modules', 'rule');
SQL

export CANON_PROJECT_DIR="$TMPDIR4"
run_test_in_dir_no_pattern \
  "pre-v10 db (no status column) → degrades to 0, no violation line" \
  "Open drift violations" \
  "$HOOK" \
  "$TMPDIR4"
unset CANON_PROJECT_DIR
rm -rf "$TMPDIR4"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
