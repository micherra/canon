#!/usr/bin/env bash
# session-start-server-guard.sh — Canon MCP server SessionStart guard.
#
# Runs on every session start (AFTER session-start-deps-install.sh):
#   1. Reaper: validate + kill stale Canon server processes by PID file,
#      never by port alone. Validates liveness AND cmdline identity.
#   2. Zero-tool observability guard: probe /health; print loud WARN if
#      server is unresponsive so the user knows to run /mcp to reconnect.
#
# NOTE: A SessionStart hook cannot enumerate the live MCP tool list; the
# health probe is the best-effort signal for connected-but-zero-tools.
# This limitation is inherent to the hook interface.
#
# Always exits 0 — advisory; never blocks session startup.
set -uo pipefail

# ---------------------------------------------------------------------------
# Resolve PID file location
# ---------------------------------------------------------------------------
DATA="${CLAUDE_PLUGIN_DATA:-}"
PROJECT_DIR="${CANON_PROJECT_DIR:-.}"

if [[ -n "$DATA" ]]; then
  PID_FILE="$DATA/canon-server.pid"
else
  PID_FILE="$PROJECT_DIR/.canon/canon-server.pid"
fi

# ---------------------------------------------------------------------------
# Part A: Reaper — validate and optionally kill stale Canon server process
# ---------------------------------------------------------------------------
if [[ -f "$PID_FILE" ]]; then
  STORED_PID=$(head -n 1 "$PID_FILE" 2>/dev/null | tr -d '[:space:]') || true

  if [[ -n "$STORED_PID" ]] && [[ "$STORED_PID" =~ ^[0-9]+$ ]]; then
    # Check if process is alive
    if kill -0 "$STORED_PID" 2>/dev/null; then
      # Process is alive — validate cmdline identity before any kill
      CMDLINE=$(ps -p "$STORED_PID" -o command= 2>/dev/null || echo "")
      if echo "$CMDLINE" | grep -q "tsx" && echo "$CMDLINE" | grep -q "index.ts\|boot.sh"; then
        # Valid Canon server — kill it (stale from prior session)
        if kill -TERM "$STORED_PID" 2>/dev/null; then
          echo "CANON NOTE: reaped stale Canon server process $STORED_PID bound to :3141"
          rm -f "$PID_FILE"
        fi
      else
        # PID is alive but is NOT a Canon server — do NOT kill; just note it
        echo "CANON NOTE: PID $STORED_PID in PID file is alive but cmdline does not match Canon server; skipping reap"
        # Leave PID file in place; the running Canon server (if any) will overwrite it
      fi
    else
      # Process is dead — remove stale PID file
      rm -f "$PID_FILE"
      echo "CANON NOTE: removed stale PID file for dead process $STORED_PID"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Part B: Zero-tool observability guard — health probe
# ---------------------------------------------------------------------------
if curl -fsS --max-time 2 http://127.0.0.1:3141/health >/dev/null 2>&1; then
  # Server is responding — session is healthy
  :
else
  # Server is not responding. Print loud, actionable warning.
  echo "CANON WARN: Canon MCP server is not responding on :3141. If mcp__canon__* tools are unavailable, run /mcp to reconnect (stdio servers do not auto-reconnect)."
fi

exit 0
