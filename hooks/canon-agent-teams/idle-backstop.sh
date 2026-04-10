#!/bin/bash
# Canon agent-teams: TeammateIdle backstop hook.
#
# Runs on Claude Code's TeammateIdle event when CANON_AGENT_TEAMS_MODE=on.
# Verifies the idle teammate produced its expected artifact. If not, emits
# feedback and exits 2 so the lead is nudged to re-prompt the teammate
# rather than letting it drop silent.
#
# Input (stdin, JSON):
#   { "teammate_name": "<name>", "team_name": "<name>", "session_id": "...", ... }
#
# Workspace state:
#   .canon/workspaces/<id>/agent-teams/teammate-artifacts.json
#   {
#     "<teammate_name>": {
#       "role": "canon-researcher",
#       "artifact": "research_synthesis",
#       "artifact_path": "research/SYNTHESIS.md"
#     }
#   }
#
# Contract: same as artifact-enforce.sh — exit 0 if OK or not Canon-tracked,
# exit 2 with feedback if a tracked teammate went idle without producing
# its artifact.

set -euo pipefail

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

TEAMMATE_NAME="$(extract_field teammate_name)"
TEAM_NAME="$(extract_field team_name)"

if [[ -z "$TEAMMATE_NAME" ]]; then
  exit 0
fi

WORKSPACE_DIR="${CANON_WORKSPACE_DIR:-}"
if [[ -z "$WORKSPACE_DIR" ]]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  CANDIDATE="$(find "$REPO_ROOT/.canon/workspaces" -maxdepth 2 -name 'teammate-artifacts.json' -path '*/agent-teams/*' 2>/dev/null | head -1 || true)"
  if [[ -n "$CANDIDATE" ]]; then
    WORKSPACE_DIR="$(dirname "$(dirname "$CANDIDATE")")"
  fi
fi

if [[ -z "$WORKSPACE_DIR" || ! -d "$WORKSPACE_DIR" ]]; then
  exit 0
fi

STATE_FILE="$WORKSPACE_DIR/agent-teams/teammate-artifacts.json"
if [[ ! -f "$STATE_FILE" ]]; then
  exit 0
fi

ARTIFACT_PATH="$(
  awk -v id="\"$TEAMMATE_NAME\"" '
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
  exit 0
fi

FULL_PATH="$WORKSPACE_DIR/$ARTIFACT_PATH"
if [[ -f "$FULL_PATH" && -s "$FULL_PATH" ]]; then
  exit 0
fi

cat <<EOF
CANON_AGENT_TEAMS: TeammateIdle backstop tripped.
Teammate ${TEAMMATE_NAME}${TEAM_NAME:+ (team ${TEAM_NAME})} went idle without producing:
  ${ARTIFACT_PATH}
Workspace: ${WORKSPACE_DIR}
Re-prompt the teammate with a pointer to the expected artifact path.
EOF

exit 2
