#!/usr/bin/env bash
# dag-dispatch-guard.sh — PreToolUse hook on the Agent tool.
#
# Warns when the orchestrator spawns raw parallel Agent subagents during DAG
# execution instead of using the TeamCreate/TaskCreate team dispatch protocol.
#
# Decision logic:
#   1. Only fires on the "Agent" tool.
#   2. Finds the active workspace by scanning orchestration.db files.
#   3. If the active workspace has task-dag.yaml AND current_state = "implement",
#      emit an advisory warning (exit 0 — never blocks).
#   4. All other cases: pass through silently.
#
# Advisory only — exit 0 always. DAG enforcement is L1 (behavioral).
# This hook provides observability and a nudge, not a hard block.

set -euo pipefail

# ── 1. Only fire on Agent tool ─────────────────────────────────────────────────
if [[ "${TOOL_NAME:-}" != "Agent" ]]; then
  exit 0
fi

# ── 2. Bypass gate ─────────────────────────────────────────────────────────────
if [[ "${CANON_BYPASS_DAG_DISPATCH_GUARD:-0}" == "1" ]]; then
  exit 0
fi

# ── 3. Require sqlite3 ─────────────────────────────────────────────────────────
if ! command -v sqlite3 >/dev/null 2>&1; then
  exit 0
fi

# ── 4. Resolve workspaces directory ────────────────────────────────────────────
CANON_DIR="${CANON_PROJECT_DIR:-.}/.canon"
WORKSPACES_DIR="${CANON_DIR}/workspaces"

if [[ ! -d "$WORKSPACES_DIR" ]]; then
  exit 0
fi

# ── 5. Find active workspace with task-dag.yaml at implement step ──────────────
while IFS= read -r db_path; do
  if [[ ! -f "$db_path" ]]; then
    continue
  fi

  # Read execution state from DB
  row=$(sqlite3 "$db_path" "SELECT slug, current_state, status FROM execution WHERE id = 1 LIMIT 1;" 2>/dev/null || true)
  if [[ -z "$row" ]]; then
    continue
  fi

  IFS='|' read -r slug current_state db_status <<< "$row"

  # Only care about active workspaces in the implement state
  if [[ "$db_status" != "active" ]] || [[ "$current_state" != "implement" ]]; then
    continue
  fi

  # Resolve the workspace directory (parent of orchestration.db's directory)
  ws_dir=$(dirname "$db_path")

  # Check for task-dag.yaml in the plans directory
  dag_file="${ws_dir}/plans/${slug}/task-dag.yaml"
  if [[ ! -f "$dag_file" ]]; then
    continue
  fi

  # Condition met: active workspace, implement state, DAG exists
  cat <<'EOF'
CANON WARNING [dag-dispatch-guard]: Raw Agent spawn detected during DAG execution.

When task-dag.yaml exists and the current step is "implement", use TeamCreate/TaskCreate
for worker dispatch instead of spawning parallel Agent subagents directly.

Raw Agent spawns bypass dependency tracking and task queue visibility.
See CLAUDE.md > DAG Execution Protocol > Worker Dispatch for the correct pattern.
EOF

  # Advisory only — always exit 0
  exit 0

done < <(find "$WORKSPACES_DIR" -name "orchestration.db" -maxdepth 3 2>/dev/null)

exit 0
