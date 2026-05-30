#!/usr/bin/env bash
# Tests for dag-dispatch-guard.sh
# Run with: bash hooks/dag-dispatch-guard.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$SCRIPT_DIR/dag-dispatch-guard.sh"
HOOK="$GUARD"  # required by test-helpers.sh shared helpers

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

# Create a temp directory for test fixtures
TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

run_test() {
  local description="$1"
  local expected_exit="$2"
  local input_json="${3:-{}}"
  local env_overrides="${4:-}"

  local actual_exit=0
  local output
  output=$(echo "$input_json" | env ${env_overrides} TOOL_NAME="Agent" bash "$GUARD" 2>&1) || actual_exit=$?

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    echo "        output: $output"
    FAIL=$((FAIL + 1))
  fi
}

run_test_with_output() {
  local description="$1"
  local expected_output_contains="$2"
  local input_json="${3:-{}}"
  local env_overrides="${4:-}"

  local actual_exit=0
  local output
  output=$(echo "$input_json" | env ${env_overrides} TOOL_NAME="Agent" bash "$GUARD" 2>&1) || actual_exit=$?

  if echo "$output" | grep -q "$expected_output_contains"; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected output to contain: $expected_output_contains"
    echo "        actual output: $output"
    FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------------------
# Setup: create a fake workspace with orchestration.db
# ---------------------------------------------------------------------------

setup_workspace() {
  local ws_name="$1"
  local current_state="${2:-implement}"
  local status="${3:-active}"
  local has_dag="${4:-true}"

  local ws_dir="${TMPDIR_BASE}/.canon/workspaces/${ws_name}"
  mkdir -p "${ws_dir}/plans/${ws_name}"

  # Create a minimal orchestration.db
  sqlite3 "${ws_dir}/orchestration.db" "
    CREATE TABLE execution (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      slug TEXT NOT NULL,
      current_state TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      flow TEXT NOT NULL DEFAULT 'build',
      task TEXT NOT NULL DEFAULT 'test task',
      entry TEXT NOT NULL DEFAULT 'start',
      base_commit TEXT NOT NULL DEFAULT 'abc123',
      started TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z',
      last_updated TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z',
      concerns TEXT NOT NULL DEFAULT '[]',
      skipped TEXT NOT NULL DEFAULT '[]',
      branch TEXT NOT NULL DEFAULT 'canon/test',
      sanitized TEXT NOT NULL DEFAULT 'test',
      created TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z',
      tier TEXT NOT NULL DEFAULT 'trivial',
      flow_name TEXT NOT NULL DEFAULT 'build',
      version INTEGER NOT NULL DEFAULT 1
    );
    INSERT INTO execution (id, slug, current_state, status)
    VALUES (1, '${ws_name}', '${current_state}', '${status}');
  " 2>/dev/null

  # Optionally create task-dag.yaml
  if [[ "$has_dag" == "true" ]]; then
    cat > "${ws_dir}/plans/${ws_name}/task-dag.yaml" <<'YAML'
tasks:
  - task_id: task-01
    depends_on: []
    files: [src/foo.ts]
YAML
  fi

  echo "$ws_dir"
}

echo ""
echo "=== dag-dispatch-guard.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# TOOL_NAME filter: only fires on Agent tool
# ---------------------------------------------------------------------------
echo "-- Tool name filter --"

# When TOOL_NAME is not Agent, should pass silently (exit 0)
INPUT='{}'
actual_exit=0
echo "$INPUT" | TOOL_NAME="Bash" bash "$GUARD" >/dev/null 2>&1 || actual_exit=$?
if [[ "$actual_exit" -eq 0 ]]; then
  echo "  PASS: non-Agent tool passes silently"
  PASS=$((PASS + 1))
else
  echo "  FAIL: non-Agent tool should exit 0, got $actual_exit"
  FAIL=$((FAIL + 1))
fi

actual_exit=0
echo "$INPUT" | TOOL_NAME="Write" bash "$GUARD" >/dev/null 2>&1 || actual_exit=$?
if [[ "$actual_exit" -eq 0 ]]; then
  echo "  PASS: Write tool passes silently"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Write tool should exit 0, got $actual_exit"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# Bypass gate
# ---------------------------------------------------------------------------
echo ""
echo "-- Bypass gate --"

setup_workspace "bypass-test" "implement" "active" "true" >/dev/null
run_test "bypass gate suppresses warning" 0 "{}" \
  "CANON_PROJECT_DIR=${TMPDIR_BASE} CANON_BYPASS_DAG_DISPATCH_GUARD=1"

# ---------------------------------------------------------------------------
# No active workspaces — pass silently
# ---------------------------------------------------------------------------
echo ""
echo "-- No active workspace --"

EMPTY_DIR="${TMPDIR_BASE}/empty"
mkdir -p "${EMPTY_DIR}/.canon"
run_test "no workspaces dir passes silently" 0 "{}" \
  "CANON_PROJECT_DIR=${EMPTY_DIR}"

# Workspace exists but state is not implement
REVIEW_WS=$(setup_workspace "review-ws" "review" "active" "true")
run_test "active workspace in review state passes silently" 0 "{}" \
  "CANON_PROJECT_DIR=${TMPDIR_BASE}"

# Workspace exists but status is not active
DONE_WS=$(setup_workspace "done-ws" "implement" "completed" "true")
run_test "completed workspace passes silently" 0 "{}" \
  "CANON_PROJECT_DIR=${TMPDIR_BASE}"

# ---------------------------------------------------------------------------
# No DAG — pass silently even when in implement state
# ---------------------------------------------------------------------------
echo ""
echo "-- No task-dag.yaml --"

NO_DAG_WS=$(setup_workspace "no-dag-ws" "implement" "active" "false")
run_test "active implement workspace without DAG passes silently" 0 "{}" \
  "CANON_PROJECT_DIR=${TMPDIR_BASE}"

# ---------------------------------------------------------------------------
# Warning scenario: active workspace + implement state + DAG exists
# ---------------------------------------------------------------------------
echo ""
echo "-- Warning scenario: implement state + DAG present --"

WARN_WS=$(setup_workspace "warn-ws" "implement" "active" "true")
run_test "warns when implement state + DAG present (exit 0 — advisory)" 0 "{}" \
  "CANON_PROJECT_DIR=${TMPDIR_BASE}"

run_test_with_output "warning message mentions TeamCreate/TaskCreate" \
  "TeamCreate" "{}" \
  "CANON_PROJECT_DIR=${TMPDIR_BASE}"

run_test_with_output "warning message mentions DAG execution" \
  "DAG" "{}" \
  "CANON_PROJECT_DIR=${TMPDIR_BASE}"

run_test_with_output "warning message mentions bypass of dependency tracking" \
  "dependency tracking" "{}" \
  "CANON_PROJECT_DIR=${TMPDIR_BASE}"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi

exit 0
