#!/usr/bin/env bash
# session-start-daemon-supervisor.sh — Canon HTTP daemon supervisor (SessionStart hook).
#
# Ensures the Canon HTTP daemon is running and up-to-date.
# Ships DARK: no-ops unless CANON_HTTP_DAEMON=1.
#
# Responsibilities:
#   1. Gate: skip entirely when CANON_HTTP_DAEMON != 1.
#   2. Resolve plugin version from mcp-server/package.json.
#   3. Health probe the daemon (CANON_DAEMON_PORT, default 3142).
#      - Healthy + same version → exit 0 (nothing to do).
#      - Healthy + version mismatch → identity-validated kill + restart.
#      - No response → stale-PID cleanup if needed + start.
#   4. Start race: mkdir lock (atomic on macOS, no flock needed).
#      - Fresh lock held by another session → exit 0 (they will start it).
#      - Stale lock (>60s) → reclaim + retry.
#   5. Start: run CANON_SUPERVISOR_BOOT_CMD (default: real boot.sh --daemon) via
#      nohup ... & disown, then poll health for CANON_SUPERVISOR_START_TIMEOUT seconds.
#
# Always exits 0 — advisory hook; never blocks session startup.
# Every branch prints a CANON NOTE/WARNING/ERROR prefix for observability.
#
# Env knobs (all injectable for tests):
#   CANON_HTTP_DAEMON                   — must be "1" to activate (default: 0)
#   CANON_DAEMON_PORT                   — port to probe/start on (default: 3142)
#   CLAUDE_PLUGIN_DATA                  — data directory for PID file, lock, log
#   CLAUDE_PLUGIN_ROOT                  — root to find mcp-server/package.json
#   CANON_SUPERVISOR_START_TIMEOUT      — seconds to poll for daemon start (default: 10)
#   CANON_SUPERVISOR_BOOT_CMD           — command to launch daemon (default: real boot.sh --daemon)
set -uo pipefail

# ---------------------------------------------------------------------------
# Gate: Phase 2 ships dark — no-op unless CANON_HTTP_DAEMON=1
# Zero latency when flag is off.
# ---------------------------------------------------------------------------
if [[ "${CANON_HTTP_DAEMON:-0}" != "1" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
PORT="${CANON_DAEMON_PORT:-3142}"
DATA="${CLAUDE_PLUGIN_DATA:-$HOME/.claude/canon}"
PID_FILE="$DATA/canon-daemon.pid"
LOCK_DIR="$DATA/canon-daemon.lock"
LOG_FILE="$DATA/daemon.log"
TIMEOUT="${CANON_SUPERVISOR_START_TIMEOUT:-10}"

# ---------------------------------------------------------------------------
# Step 1: Resolve plugin root and plugin version from mcp-server/package.json
# ---------------------------------------------------------------------------
ROOT=""

# Try CLAUDE_PLUGIN_ROOT first (set by platform in plugin context)
if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" ]] && [[ -f "${CLAUDE_PLUGIN_ROOT}/mcp-server/package.json" ]]; then
  ROOT="$CLAUDE_PLUGIN_ROOT"
fi

# Fallback: walk up from BASH_SOURCE to find mcp-server/package.json
if [[ -z "$ROOT" ]]; then
  _SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  _WALK="$_SCRIPT_DIR"
  while [[ "$_WALK" != "/" ]]; do
    if [[ -f "$_WALK/mcp-server/package.json" ]]; then
      ROOT="$_WALK"
      break
    fi
    _WALK="$(dirname "$_WALK")"
  done
fi

PLUGIN_VERSION=""
if [[ -n "$ROOT" ]] && [[ -f "$ROOT/mcp-server/package.json" ]]; then
  PLUGIN_VERSION=$(grep '"version"' "$ROOT/mcp-server/package.json" | head -n 1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
fi

if [[ -z "$PLUGIN_VERSION" ]]; then
  echo "CANON WARNING: daemon supervisor could not resolve plugin version; treating as mismatch"
fi

# ---------------------------------------------------------------------------
# Step 2: Health probe
# ---------------------------------------------------------------------------
HEALTH_RESPONSE=""
if command -v curl >/dev/null 2>&1; then
  HEALTH_RESPONSE=$(curl -s -m 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null) || true # DOCUMENTED FAIL-OPEN -- curl failure means daemon unreachable; handled below
else
  echo "CANON NOTE: curl not available; cannot probe daemon health; skipping supervisor"
  exit 0
fi

DAEMON_VERSION=""
DAEMON_HEALTHY=0

if [[ -n "$HEALTH_RESPONSE" ]]; then
  # Extract version field using grep/sed (no jq dependency)
  DAEMON_VERSION=$(echo "$HEALTH_RESPONSE" | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
  if [[ -n "$DAEMON_VERSION" ]]; then
    DAEMON_HEALTHY=1
  fi
fi

# ---------------------------------------------------------------------------
# Step 3: Evaluate health probe result
# ---------------------------------------------------------------------------
if [[ $DAEMON_HEALTHY -eq 1 ]]; then
  if [[ -n "$PLUGIN_VERSION" ]] && [[ "$DAEMON_VERSION" == "$PLUGIN_VERSION" ]]; then
    # Same version — healthy, nothing to do
    echo "CANON NOTE: daemon healthy (v${DAEMON_VERSION})"
    exit 0
  fi

  # Version mismatch (or plugin version unknown) — kill old daemon and restart
  echo "CANON NOTE: daemon version mismatch (running=${DAEMON_VERSION} plugin=${PLUGIN_VERSION:-unknown}); performing version handoff"

  # Identity-validated kill: read PID file, verify cmdline matches tsx+daemon.ts
  if [[ -f "$PID_FILE" ]]; then
    STORED_PID=$(head -n 1 "$PID_FILE" 2>/dev/null | tr -d '[:space:]') || true # DOCUMENTED FAIL-OPEN -- PID file may be unreadable; fall through to start
    if [[ -n "$STORED_PID" ]] && [[ "$STORED_PID" =~ ^[0-9]+$ ]]; then
      if kill -0 "$STORED_PID" 2>/dev/null; then
        CMDLINE=$(ps -p "$STORED_PID" -o command= 2>/dev/null) || CMDLINE="" # DOCUMENTED FAIL-OPEN -- ps may fail on some systems; treat as no-match
        if echo "$CMDLINE" | grep -q "tsx" && echo "$CMDLINE" | grep -q "daemon\.ts"; then
          # Identity confirmed — safe to TERM
          if kill -TERM "$STORED_PID" 2>/dev/null; then
            echo "CANON NOTE: sent SIGTERM to stale daemon PID $STORED_PID (version handoff)"
            # Wait up to 5s for daemon to exit
            _waited=0
            while kill -0 "$STORED_PID" 2>/dev/null && (( _waited < 5 )); do
              sleep 1
              (( _waited++ )) || true
            done
          fi
          rm -f "$PID_FILE"
        else
          echo "CANON NOTE: PID $STORED_PID cmdline does not match Canon daemon; skipping kill (identity guard)"
        fi
      else
        # Dead process — clean up stale PID file
        rm -f "$PID_FILE"
      fi
    fi
  fi
  # Fall through to start path
else
  # No health response
  if [[ -f "$PID_FILE" ]]; then
    STORED_PID=$(head -n 1 "$PID_FILE" 2>/dev/null | tr -d '[:space:]') || true # DOCUMENTED FAIL-OPEN -- PID file may be unreadable; fall through
    if [[ -n "$STORED_PID" ]] && [[ "$STORED_PID" =~ ^[0-9]+$ ]]; then
      if kill -0 "$STORED_PID" 2>/dev/null; then
        # Process alive but unresponsive — check identity before killing
        CMDLINE=$(ps -p "$STORED_PID" -o command= 2>/dev/null) || CMDLINE="" # DOCUMENTED FAIL-OPEN -- ps may fail; treat as no-match
        if echo "$CMDLINE" | grep -q "tsx" && echo "$CMDLINE" | grep -q "daemon\.ts"; then
          echo "CANON NOTE: daemon PID $STORED_PID is alive but unresponsive; sending SIGTERM"
          kill -TERM "$STORED_PID" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- kill may fail if process exits first; fall through to start
          rm -f "$PID_FILE"
        else
          echo "CANON NOTE: PID $STORED_PID is alive but cmdline does not match Canon daemon; skipping kill"
        fi
      else
        # Process dead — remove stale PID file
        rm -f "$PID_FILE"
        echo "CANON NOTE: removed stale daemon PID file for dead process $STORED_PID"
      fi
    fi
  fi
  # Fall through to start path
fi

# ---------------------------------------------------------------------------
# Step 4: Start race lock (mkdir is atomic on macOS; no flock needed)
# ---------------------------------------------------------------------------
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  # Lock already held — check if stale (>60s)
  LOCK_AGE=0
  # Use stat to get mtime; format differs between macOS and GNU
  if stat -f "%m" "$LOCK_DIR" >/dev/null 2>&1; then
    # macOS stat
    LOCK_MTIME=$(stat -f "%m" "$LOCK_DIR" 2>/dev/null) || LOCK_MTIME=0
    NOW=$(date +%s)
    LOCK_AGE=$(( NOW - LOCK_MTIME )) || LOCK_AGE=0
  else
    # GNU stat
    LOCK_MTIME=$(stat -c "%Y" "$LOCK_DIR" 2>/dev/null) || LOCK_MTIME=0
    NOW=$(date +%s)
    LOCK_AGE=$(( NOW - LOCK_MTIME )) || LOCK_AGE=0
  fi

  if (( LOCK_AGE > 60 )); then
    echo "CANON NOTE: stale daemon start lock (${LOCK_AGE}s old); reclaiming"
    rm -rf "$LOCK_DIR"
    if ! mkdir "$LOCK_DIR" 2>/dev/null; then
      echo "CANON NOTE: another session reclaimed the lock first; exiting gracefully"
      exit 0
    fi
  else
    echo "CANON NOTE: another session is starting the daemon (lock age ${LOCK_AGE}s); exiting gracefully"
    exit 0
  fi
fi

# We hold the lock — ensure it is released on exit (all paths)
# shellcheck disable=SC2064
trap "rmdir '$LOCK_DIR' 2>/dev/null" EXIT

# ---------------------------------------------------------------------------
# Step 5: Start the daemon
# ---------------------------------------------------------------------------
# Resolve boot command: default to real boot.sh --daemon in nohup/disown mode
if [[ -n "${CANON_SUPERVISOR_BOOT_CMD:-}" ]]; then
  # Test override: run directly (tests may not want nohup/disown)
  eval "${CANON_SUPERVISOR_BOOT_CMD}" &
  disown 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- disown may not be available in all shell variants; process still launched
else
  # Production path: nohup boot.sh --daemon → daemon.log, background + disown
  if [[ -z "$ROOT" ]]; then
    echo "CANON WARNING: cannot resolve plugin root; daemon not started"
    exit 0
  fi
  BOOT_SH="$ROOT/mcp-server/boot.sh"
  if [[ ! -f "$BOOT_SH" ]]; then
    echo "CANON WARNING: boot.sh not found at $BOOT_SH; daemon not started"
    exit 0
  fi
  mkdir -p "$DATA"
  # shellcheck disable=SC2094
  nohup bash "$BOOT_SH" --daemon >> "$LOG_FILE" 2>&1 &
  disown 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- disown may not be available in all shell variants; process still launched
fi

echo "CANON NOTE: daemon start command issued; polling for health..."

# ---------------------------------------------------------------------------
# Step 6: Poll health for up to TIMEOUT seconds
# ---------------------------------------------------------------------------
_elapsed=0
while (( _elapsed < TIMEOUT )); do
  sleep 1
  (( _elapsed++ )) || true
  _probe=$(curl -s -m 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null) || true # DOCUMENTED FAIL-OPEN -- daemon may still be starting; retry on next tick
  if [[ -n "$_probe" ]]; then
    _started_version=$(echo "$_probe" | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
    if [[ -n "$_started_version" ]]; then
      # When the expected plugin version is known, require the polled version to
      # match exactly. A mismatch means the old daemon survived the kill attempt
      # and is reporting as healthy — this is NOT a successful start.
      if [[ -n "$PLUGIN_VERSION" ]] && [[ "$_started_version" != "$PLUGIN_VERSION" ]]; then
        echo "CANON WARNING: polled daemon reports v${_started_version} but expected v${PLUGIN_VERSION}; old daemon may have survived — start did not succeed"
        exit 0
      fi
      echo "CANON NOTE: daemon started successfully (v${_started_version})"
      exit 0
    fi
  fi
done

echo "CANON WARNING: daemon failed to start within ${TIMEOUT}s; see ${LOG_FILE}"
exit 0
