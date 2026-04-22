#!/usr/bin/env bash
# post-engineer-scribe.sh — SubagentStop hook that queues a scribe run after
# canon-engineer completes.
#
# Writes ${WORKSPACE}/pending-scribe.json recording that canon-engineer made
# source changes. The lead is instructed (via CLAUDE.md completion checklist)
# to spawn canon-scribe before completing the flow when this file exists.
#
# Only active when CANON_AGENT_TEAMS_MODE=on.
#
# Input: JSON on stdin (Claude Code SubagentStop hook format). We inspect the
#        subagent's type and, when canon-engineer is the one stopping, record
#        the queue entry. Other subagents are no-ops.
# Exit 0: always — this hook is advisory/bookkeeping, never blocks.

set -euo pipefail

if [[ "${CANON_AGENT_TEAMS_MODE:-off}" != "on" ]]; then
  exit 0
fi

INPUT=$(cat 2>/dev/null || true)

if [[ -z "$INPUT" ]]; then
  exit 0
fi

# Look for canon-engineer in the subagent descriptor. Tolerant of field name
# variation across Claude Code versions: `subagent_type`, `agent`, `agent_type`.
if ! echo "$INPUT" | grep -qE '"(subagent_type|agent|agent_type)"[[:space:]]*:[[:space:]]*"[^"]*canon-engineer'; then
  exit 0
fi

# Workspace discovery: prefer CANON_WORKSPACE, then a `workspace` field in the
# hook payload. Without one, we have nowhere to queue — exit quietly.
WORKSPACE="${CANON_WORKSPACE:-}"
if [[ -z "$WORKSPACE" ]]; then
  WORKSPACE=$(echo "$INPUT" \
    | grep -oE '"workspace"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -1 \
    | sed 's/"workspace"[[:space:]]*:[[:space:]]*"//;s/"$//')
fi

if [[ -z "$WORKSPACE" || ! -d "$WORKSPACE" ]]; then
  exit 0
fi

STAMP=$(date -u +'%Y-%m-%dT%H:%M:%SZ')

# Overwrite-semantics: most recent engineer completion wins. The scribe clears
# the file when it runs.
cat > "$WORKSPACE/pending-scribe.json" <<EOF
{
  "queued_at": "$STAMP",
  "reason": "canon-engineer completed; source changes may need doc sync",
  "queued_by": "post-engineer-scribe.sh"
}
EOF

exit 0
