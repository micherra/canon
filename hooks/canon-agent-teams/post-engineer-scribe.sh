#!/usr/bin/env bash
# post-engineer-scribe.sh — SubagentStop hook that queues a scribe run after
# engineer completes.
#
# Writes ${WORKSPACE}/pending-scribe.json recording that engineer made
# source changes. The lead is instructed (via CLAUDE.md completion checklist)
# to spawn scribe before completing the flow when this file exists.
#
#
# Input: JSON on stdin (Claude Code SubagentStop hook format). We inspect the
#        subagent's type and, when engineer is the one stopping, record
#        the queue entry. Other subagents are no-ops.
# Exit 0: always — this hook is advisory/bookkeeping, never blocks.

set -euo pipefail

INPUT=$(cat 2>/dev/null || true)

if [[ -z "$INPUT" ]]; then
  exit 0
fi

# Look for engineer in the subagent descriptor. Tolerant of field name
# variation across Claude Code versions: `subagent_type`, `agent`, `agent_type`.
AGENT_TYPE=$(echo "$INPUT" | jq -r '(.tool_input.subagent_type // .subagent_type // .tool_input.agent // .agent // .tool_input.agent_type // .agent_type // empty)' 2>/dev/null || true)
if [[ "$AGENT_TYPE" != *engineer* ]]; then
  exit 0
fi

# Workspace discovery: prefer CANON_WORKSPACE, then a `workspace` field in the
# hook payload. Without one, we have nowhere to queue — exit quietly.
WORKSPACE="${CANON_WORKSPACE:-}"
if [[ -z "$WORKSPACE" ]]; then
  WORKSPACE=$(echo "$INPUT" | jq -r '.tool_input.workspace // .workspace // empty' 2>/dev/null || true)
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
  "reason": "engineer completed; source changes may need doc sync",
  "queued_by": "post-engineer-scribe.sh"
}
EOF

exit 0
