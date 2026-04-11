#!/bin/bash
# Canon agent-teams: TaskCompleted artifact enforcement hook.
#
# Runs on Claude Code's TaskCompleted event when CANON_AGENT_TEAMS_MODE=on.
# Reads the task payload from stdin (JSON). Looks up the expected artifact
# path from the workspace-local runbook state file and blocks completion if
# the artifact is not present on disk.
#
# Contract:
#   - exit 0: artifact present, allow completion.
#   - exit 2: artifact missing, block completion, emit feedback to stdout.
#   - exit 0 with no output: no-op path (flag off, no workspace, task not
#     tracked by Canon) — never block if Canon wasn't driving this task.
#
# Workspace state:
#   .canon/workspaces/<id>/agent-teams/task-artifacts.json
#   {
#     "<task_id>": { "artifact": "research_synthesis",
#                    "artifact_path": "research/SYNTHESIS.md",
#                    "role": "canon-researcher" },
#     ...
#   }
#
# The lead-mode orchestrator writes this file at spawn time.

set -euo pipefail

# Feature flag gate — never block when the mode is off.
if [[ "${CANON_AGENT_TEAMS_MODE:-off}" != "on" ]]; then
  exit 0
fi

INPUT="$(cat || true)"
if [[ -z "$INPUT" ]]; then
  exit 0
fi

extract_field() {
  local field="$1"
  printf '%s' "$INPUT" | grep -o "\"${field}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 \
    | sed "s/.*\"${field}\"[[:space:]]*:[[:space:]]*\"//;s/\"$//" || true
}

TASK_ID="$(extract_field task_id)"
SESSION_ID="$(extract_field session_id)"

if [[ -z "$TASK_ID" ]]; then
  # Not a task-bearing event — nothing to enforce.
  exit 0
fi

# Locate the workspace. Prefer CANON_WORKSPACE_DIR (set by lead-mode
# bootstrap). Fall back to searching .canon/workspaces/ in the current repo.
#
# maxdepth covers both the flat layout (.canon/workspaces/<id>/agent-teams/
# task-artifacts.json — depth 3) and the branch/slug layout produced by
# init_workspace (.canon/workspaces/<branch>/<slug>/agent-teams/
# task-artifacts.json — depth 4), plus headroom for worktree nesting.
WORKSPACE_DIR="${CANON_WORKSPACE_DIR:-}"
if [[ -z "$WORKSPACE_DIR" ]]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  CANDIDATE="$(find "$REPO_ROOT/.canon/workspaces" -maxdepth 6 -name 'task-artifacts.json' -path '*/agent-teams/*' 2>/dev/null | head -1 || true)"
  if [[ -n "$CANDIDATE" ]]; then
    WORKSPACE_DIR="$(dirname "$(dirname "$CANDIDATE")")"
  fi
fi

if [[ -z "$WORKSPACE_DIR" || ! -d "$WORKSPACE_DIR" ]]; then
  # INTENTIONAL FAIL-OPEN (scoped, per principle fail-closed-by-default):
  # This hook fires on every Claude Code TaskCompleted event — including
  # sessions that have nothing to do with Canon. When we cannot resolve a
  # Canon workspace we treat the task as out-of-scope and allow it through.
  # The Canon-tracked path below still fails closed (exit 2) when a
  # tracked artifact is missing; that is the security-relevant case.
  exit 0
fi

STATE_FILE="$WORKSPACE_DIR/agent-teams/task-artifacts.json"
if [[ ! -f "$STATE_FILE" ]]; then
  # INTENTIONAL FAIL-OPEN (scoped): workspace exists but Canon hasn't
  # registered any tracked tasks for it yet (state file absent). Nothing
  # for us to enforce; let the task proceed.
  exit 0
fi

# Extract artifact_path for this task id. Pure bash + grep, no jq dependency.
# Find the JSON object keyed by the task id and pull its artifact_path.
ARTIFACT_PATH="$(
  awk -v id="\"$TASK_ID\"" '
    index($0, id) { inblock = 1 }
    inblock && /artifact_path/ {
      match($0, /"artifact_path"[[:space:]]*:[[:space:]]*"[^"]*"/)
      if (RSTART > 0) {
        field = substr($0, RSTART, RLENGTH)
        sub(/.*"artifact_path"[[:space:]]*:[[:space:]]*"/, "", field)
        sub(/".*/, "", field)
        print field
        exit
      }
    }
    inblock && /\}/ { inblock = 0 }
  ' "$STATE_FILE"
)"

if [[ -z "$ARTIFACT_PATH" ]]; then
  # INTENTIONAL FAIL-OPEN (scoped): the task id was not in Canon's state
  # file, so this TaskCompleted event belongs to work outside the active
  # runbook. Not our responsibility to block it.
  exit 0
fi

FULL_PATH="$WORKSPACE_DIR/$ARTIFACT_PATH"
if [[ -f "$FULL_PATH" && -s "$FULL_PATH" ]]; then
  exit 0
fi

cat <<EOF
CANON_AGENT_TEAMS: TaskCompleted blocked.
Expected artifact is missing or empty:
  ${ARTIFACT_PATH}
Workspace: ${WORKSPACE_DIR}
Task: ${TASK_ID}${SESSION_ID:+ (session ${SESSION_ID})}
Produce the artifact before marking the task complete.
EOF

exit 2
