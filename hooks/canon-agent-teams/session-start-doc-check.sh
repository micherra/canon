#!/usr/bin/env bash
# session-start-doc-check.sh — SessionStart hook that nudges the lead when
# documentation may be stale.
#
# Compares the current HEAD commit against the SHA recorded in
# .canon/last-scribe-commit (written by the scribe agent after it
# last synced CLAUDE.md / docs / agents). If they diverge, emit an
# informational hint on stdout for the lead to consider running the
# scribe before relying on agent-facing docs.
#
# Never blocks: this is an advisory nudge, exit 0 regardless.

set -euo pipefail

LAST_SCRIBE_FILE="${CANON_PROJECT_DIR:-.}/.canon/last-scribe-commit"

if [[ ! -f "$LAST_SCRIBE_FILE" ]]; then
  cat <<'EOF'
CANON NOTE: No scribe checkpoint recorded yet (.canon/last-scribe-commit missing).
Agent-facing docs (CLAUDE.md files, references/) may not reflect
recent source changes. Consider running the scribe at the end of the next
completed flow.
EOF
  exit 0
fi

LAST_SCRIBE_SHA=$(tr -d '[:space:]' < "$LAST_SCRIBE_FILE" 2>/dev/null || true)

if [[ -z "$LAST_SCRIBE_SHA" ]]; then
  exit 0
fi

HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || true)

if [[ -z "$HEAD_SHA" || "$HEAD_SHA" == "$LAST_SCRIBE_SHA" ]]; then
  exit 0
fi

# Report commits since the last scribe run. Cap at 20 lines to keep the
# nudge terse.
CHANGED_COUNT=$(git rev-list --count "${LAST_SCRIBE_SHA}..HEAD" 2>/dev/null || echo "?")

cat <<EOF
CANON NOTE: Docs may be stale.
  Last scribe: ${LAST_SCRIBE_SHA:0:12}
  HEAD:        ${HEAD_SHA:0:12}
  Commits since last scribe: ${CHANGED_COUNT}

Consider scheduling a scribe sync before the next flow ships.
EOF

exit 0
