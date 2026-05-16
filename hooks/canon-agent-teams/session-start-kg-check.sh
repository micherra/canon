#!/usr/bin/env bash
# session-start-kg-check.sh — SessionStart hook that verifies the knowledge
# graph is present and reasonably fresh.
#
# Canon's lead and specialist agents rely on graph_query / get_file_context for
# blast-radius and dependency reasoning. A missing or very stale KG silently
# degrades those calls. This hook emits an informational nudge when the KG
# looks missing or old; it does not block.
#
# Only active when CANON_AGENT_TEAMS_MODE=on.
# Always exits 0 — advisory only.

set -euo pipefail

KG_DB="${CANON_PROJECT_DIR:-.}/.canon/knowledge-graph.db"

if [[ ! -f "$KG_DB" ]]; then
  cat <<EOF
CANON NOTE: Knowledge graph not found at ${KG_DB}.
Dependency reasoning (graph_query, get_file_context blast radius) will be
unavailable. Run: canon init, or invoke codebase_graph to populate it.
EOF
  exit 0
fi

# Freshness: flag if the DB is older than 24h. Use stat portably across
# GNU and BSD userland.
NOW=$(date +%s)
if MTIME=$(stat -c %Y "$KG_DB" 2>/dev/null); then
  :
elif MTIME=$(stat -f %m "$KG_DB" 2>/dev/null); then
  :
else
  exit 0
fi

AGE=$((NOW - MTIME))
THRESHOLD=${CANON_KG_STALE_SECONDS:-86400}  # 24h default

if (( AGE > THRESHOLD )); then
  AGE_HOURS=$((AGE / 3600))
  cat <<EOF
CANON NOTE: Knowledge graph is ${AGE_HOURS}h old.
Consider refreshing via codebase_graph so dependency reasoning reflects
recent source changes.
EOF
fi

exit 0
