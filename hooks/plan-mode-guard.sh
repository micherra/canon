#!/bin/bash
# Canon Plan Mode Guard
# Runs as a PreToolUse hook on EnterPlanMode.
# Blocks native planning mode and redirects to Canon's architect agent,
# which persists plans to the workspace and checks them against principles.
#
# Input: JSON on stdin with the tool call details
# Output: Redirect message on stdout (when blocking)
# Exit 0: allow the tool call
# Exit 2: block the tool call (user will be prompted)

set -euo pipefail

cat <<'EOF'
CANON: Planning mode intercepted. Native planning bypasses Canon's orchestration — plans won't be persisted or checked against principles.

Route this through Canon instead: classify as a **plan** intent and spawn the architect in interactive mode. The architect will propose approaches, ask for your input, and persist the plan to the workspace where downstream agents can use it.

To proceed: treat the user's request as a plan intent (build with --plan-only). Drive the architect via the normal state machine with HITL loops for user feedback.
EOF

exit 2
