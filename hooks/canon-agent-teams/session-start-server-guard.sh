#!/usr/bin/env bash
# session-start-server-guard.sh — Canon MCP server SessionStart guard.
#
# Runs on every session start (AFTER session-start-deps-install.sh):
#   1. Reaper: validate + kill stale Canon server processes by PID file,
#      never by port alone. Validates liveness AND cmdline identity.
#   2. Zero-tool observability guard: bounded /health poll; print loud WARN
#      only if the server is still unresponsive after the poll window, so
#      the user knows to run /mcp to reconnect.
#
# NOTE: A SessionStart hook cannot enumerate the live MCP tool list; the
# health probe is the best-effort signal for connected-but-zero-tools.
# This limitation is inherent to the hook interface.
#
# Always exits 0 — advisory; never blocks session startup.
#
# Env knobs (all injectable for tests):
#   CANON_GUARD_HEALTH_TIMEOUT — bounded /health poll budget in seconds
#                                (default: 8; non-numeric values coerce to
#                                the default — see numeric guard below)
set -uo pipefail

# ---------------------------------------------------------------------------
# Resolve PID file location and probe port
# ---------------------------------------------------------------------------
DATA="${CLAUDE_PLUGIN_DATA:-}"
PROJECT_DIR="${CANON_PROJECT_DIR:-.}"
PORT="${CANON_DAEMON_PORT:-3142}"

if [[ -n "$DATA" ]]; then
  PID_FILE="$DATA/canon-server.pid"
else
  PID_FILE="$PROJECT_DIR/.canon/canon-server.pid"
fi

# ---------------------------------------------------------------------------
# Part A: Reaper — validate and optionally kill stale Canon server process
# ---------------------------------------------------------------------------
if [[ -f "$PID_FILE" ]]; then
  STORED_PID=$(head -n 1 "$PID_FILE" 2>/dev/null | tr -d '[:space:]') || true  # DOCUMENTED FAIL-OPEN -- head/tr failure or empty PID file leaves STORED_PID empty; the subsequent [[ -n "$STORED_PID" ]] && [[ "$STORED_PID" =~ ^[0-9]+$ ]] guard below handles the empty/malformed case, so a read failure must not abort the reaper

  if [[ -n "$STORED_PID" ]] && [[ "$STORED_PID" =~ ^[0-9]+$ ]]; then
    # Check if process is alive
    if kill -0 "$STORED_PID" 2>/dev/null; then
      # Process is alive — validate cmdline identity before any kill
      CMDLINE=$(ps -p "$STORED_PID" -o command= 2>/dev/null || echo "")
      if echo "$CMDLINE" | grep -q "tsx" && echo "$CMDLINE" | grep -q "index.ts\|boot.sh"; then
        # Valid Canon server — kill it (stale from prior session)
        if kill -TERM "$STORED_PID" 2>/dev/null; then
          echo "CANON NOTE: reaped stale Canon server process $STORED_PID bound to :${PORT}"
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
# Part B: Zero-tool observability guard — bounded /health poll
# ---------------------------------------------------------------------------
# DOCUMENTED FAIL-OPEN: this is a quality/observability signal, not a safety
# gate — hooks-fail-closed deliberately does NOT apply here (matches the
# documented fail-open posture of daemon-version-nudge.sh and the evaluator
# gate). Every path below still exits 0.
#
# A bounded retry/poll (mirroring the supervisor's own curl-poll idiom in
# session-start-daemon-supervisor.sh) avoids false-positive WARNs while the
# daemon is still mid-start. Effective wall-time runs roughly 2x the budget
# below (each failed iteration is a 1s sleep plus up to a 1s curl timeout),
# so the default of 8 can take ~16s in the worst case. That's acceptable —
# a longer effective wait only makes false positives rarer, and a genuine
# outage still stays owned by the supervisor's louder CANON ERROR block.
HEALTH_TIMEOUT="${CANON_GUARD_HEALTH_TIMEOUT:-8}"
[[ "$HEALTH_TIMEOUT" =~ ^[0-9]+$ ]] || HEALTH_TIMEOUT=8

_guard_probe_health() {
  curl -fsS --max-time 1 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1
}

HEALTHY=0
if _guard_probe_health; then
  HEALTHY=1
else
  ELAPSED=0
  while (( ELAPSED < HEALTH_TIMEOUT )); do
    sleep 1
    (( ELAPSED++ )) || true  # DOCUMENTED FAIL-OPEN -- (( x++ )) returns the pre-increment value's truthiness, so it "fails" when ELAPSED was 0; the counter still advances correctly and no downstream logic depends on this statement's exit code
    if _guard_probe_health; then
      HEALTHY=1
      break
    fi
  done
fi

if [[ "$HEALTHY" -eq 0 ]]; then
  # Server is still not responding after the bounded poll. Print loud,
  # actionable warning.
  echo "CANON WARN: Canon MCP server is not responding on :${PORT} after a bounded poll (budget ${HEALTH_TIMEOUT}s). If mcp__canon__* tools are unavailable, run /mcp to reconnect; if the HTTP daemon is down, start it with: bash mcp-server/boot.sh --daemon (or restart the session)."
fi

exit 0
