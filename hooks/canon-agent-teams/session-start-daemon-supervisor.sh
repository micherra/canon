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
#   6. Survivor recovery: if the start did not reach the target version, resolve
#      who actually holds the port (lsof, not just the PID file) and, if it
#      identity-confirms as a Canon daemon, escalate SIGTERM→SIGKILL and retry
#      the start exactly once. A non-Canon port owner is never killed. Every
#      ambiguous/failed branch surfaces a loud CANON WARNING/ERROR.
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
#   CANON_SUPERVISOR_TERM_GRACE         — seconds to wait after SIGTERM before SIGKILL (default: 3)
#   CANON_SUPERVISOR_KILL_WAIT          — seconds to wait after SIGKILL for death (default: 2)
#   CANON_SUPERVISOR_PORT_OWNER_CMD     — command that echoes the port-owner PID (test seam)
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
TERM_GRACE="${CANON_SUPERVISOR_TERM_GRACE:-3}"
KILL_WAIT="${CANON_SUPERVISOR_KILL_WAIT:-2}"

# ---------------------------------------------------------------------------
# Helpers — port-owner survivor recovery (identity → escalate → resolve)
# ---------------------------------------------------------------------------

# _supervisor_is_canon_daemon_pid <pid>
# Returns 0 iff the process's cmdline matches tsx + daemon.ts (Canon daemon
# identity). Fail-open on ps failure = "not a match" (return 1) — same
# never-blind-kill posture as every caller of this helper.
_supervisor_is_canon_daemon_pid() {
  local pid="$1"
  local cmdline
  cmdline=$(ps -p "$pid" -o command= 2>/dev/null) || cmdline="" # DOCUMENTED FAIL-OPEN -- ps may fail; treat as no identity match (never-blind-kill)
  if echo "$cmdline" | grep -q "tsx" && echo "$cmdline" | grep -q "daemon\.ts"; then
    return 0
  fi
  return 1
}

# _supervisor_resolve_port_owner_pid
# Echoes the numeric PID listening on $PORT. Resolution order:
# CANON_SUPERVISOR_PORT_OWNER_CMD override (test seam, mirrors
# CANON_SUPERVISOR_BOOT_CMD) → else real lsof. Keyed on output shape, not
# exit code (lsof exits 1 on no-match).
# Returns: 0 = owner found (PID on stdout); 1 = port free (no owner);
#          2 = UNKNOWN — fail-closed (lsof absent and no override, or an
#          override command that exits non-zero).
_supervisor_resolve_port_owner_pid() {
  local out rc
  if [[ -n "${CANON_SUPERVISOR_PORT_OWNER_CMD:-}" ]]; then
    out=$(eval "$CANON_SUPERVISOR_PORT_OWNER_CMD" 2>/dev/null); rc=$?
    if (( rc != 0 )); then
      return 2
    fi
  elif command -v lsof >/dev/null 2>&1; then
    out=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -n1)
  else
    return 2 # lsof absent, no override -- fail-closed UNKNOWN (portability guard)
  fi
  out=$(echo "$out" | tr -d '[:space:]')
  if [[ "$out" =~ ^[0-9]+$ ]]; then
    echo "$out"
    return 0
  fi
  return 1
}

# _supervisor_escalate_kill <pid>
# SIGTERM → bounded grace (TERM_GRACE) → SIGKILL → bounded death-wait
# (KILL_WAIT). Returns 0 iff the pid is dead at the end, else 1.
_supervisor_escalate_kill() {
  local pid="$1"
  kill -TERM "$pid" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- kill may fail if the process already exited; the poll loop below confirms actual state
  local waited=0
  while kill -0 "$pid" 2>/dev/null && (( waited < TERM_GRACE )); do
    sleep 1
    (( waited++ )) || true
  done
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "CANON NOTE: PID $pid cleared by SIGTERM"
    return 0
  fi
  echo "CANON NOTE: PID $pid survived SIGTERM after ${TERM_GRACE}s; escalating to SIGKILL"
  kill -KILL "$pid" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- kill may fail if the process already exited; the poll loop below confirms actual state
  local kwaited=0
  while kill -0 "$pid" 2>/dev/null && (( kwaited < KILL_WAIT )); do
    sleep 1
    (( kwaited++ )) || true
  done
  if kill -0 "$pid" 2>/dev/null; then
    return 1
  fi
  echo "CANON NOTE: PID $pid cleared by SIGKILL"
  return 0
}

# _supervisor_emit_down_block
# Loud CANON ERROR recovery-options block for when the daemon could not be
# brought up at the target version and could not be auto-recovered. Reused
# by both the port-free and retry-exhausted cases.
_supervisor_emit_down_block() {
  echo "CANON ERROR: HTTP daemon is NOT reachable on 127.0.0.1:${PORT} — mcp__canon__* tools will FAIL this session."
  echo "  Recovery options:"
  echo "    1) Start it manually:   bash mcp-server/boot.sh --daemon"
  echo "    2) Kill-switch to stdio: unset CANON_HTTP_DAEMON  and revert .mcp.json 'canon' to the stdio command form"
  echo "  Details: mcp-server/src/app/mcp-http/MANUAL-VERIFICATION.md (down-daemon recovery)"
  echo "  (start log: ${LOG_FILE})"
}

# _supervisor_boot_and_poll
# Runs the boot command, then polls /health for up to TIMEOUT seconds.
# Callable more than once (recovery retries exactly once). Does NOT print the
# loud CANON ERROR block or the "old daemon may have survived" WARNING itself
# — the caller decides what a non-target-version or unreachable result means.
# Returns: 0 = polled version == plugin version (or plugin version unknown);
#          prints "daemon started successfully (vX)".
#          1 = polled a version that does not match the plugin version.
#          2 = timed out with no /health response.
_supervisor_boot_and_poll() {
  # Resolve boot command: default to real boot.sh --daemon in nohup/disown mode
  if [[ -n "${CANON_SUPERVISOR_BOOT_CMD:-}" ]]; then
    # Test override: run directly (tests may not want nohup/disown)
    eval "${CANON_SUPERVISOR_BOOT_CMD}" &
    disown 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- disown may not be available in all shell variants; process still launched
  else
    # Production path: nohup boot.sh --daemon → daemon.log, background + disown
    if [[ -z "$ROOT" ]]; then
      echo "CANON WARNING: cannot resolve plugin root; daemon not started"
      return 2
    fi
    local boot_sh="$ROOT/mcp-server/boot.sh"
    if [[ ! -f "$boot_sh" ]]; then
      echo "CANON WARNING: boot.sh not found at $boot_sh; daemon not started"
      return 2
    fi
    mkdir -p "$DATA"
    # shellcheck disable=SC2094
    nohup bash "$boot_sh" --daemon >> "$LOG_FILE" 2>&1 &
    disown 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- disown may not be available in all shell variants; process still launched
  fi

  echo "CANON NOTE: daemon start command issued; polling for health..."

  local elapsed=0
  while (( elapsed < TIMEOUT )); do
    sleep 1
    (( elapsed++ )) || true
    local probe
    probe=$(curl -s -m 2 "http://127.0.0.1:${PORT}/health" 2>/dev/null) || true # DOCUMENTED FAIL-OPEN -- daemon may still be starting; retry on next tick
    if [[ -n "$probe" ]]; then
      local started_version
      started_version=$(echo "$probe" | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
      if [[ -n "$started_version" ]]; then
        # When the expected plugin version is known, require the polled version to
        # match exactly. A mismatch means a surviving daemon is answering — this
        # is NOT a successful start of the target version.
        if [[ -n "$PLUGIN_VERSION" ]] && [[ "$started_version" != "$PLUGIN_VERSION" ]]; then
          return 1
        fi
        echo "CANON NOTE: daemon started successfully (v${started_version})"
        return 0
      fi
    fi
  done

  return 2
}

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
    # Same version — healthy. Reconcile recorded port in PID file if it diverges
    # from the live PORT so that future probes and session-start-server-guard.sh
    # both target the correct port (F2c).
    if [[ -f "$PID_FILE" ]]; then
      _recorded_port=$(sed -n '2p' "$PID_FILE" 2>/dev/null | tr -d '[:space:]') || _recorded_port="" # DOCUMENTED FAIL-OPEN -- unreadable PID file; skip reconcile
      if [[ -n "$_recorded_port" ]] && [[ "$_recorded_port" != "$PORT" ]]; then
        _pid_line=$(sed -n '1p' "$PID_FILE" 2>/dev/null | tr -d '[:space:]') || _pid_line="" # DOCUMENTED FAIL-OPEN -- unreadable PID line; skip reconcile
        if [[ -n "$_pid_line" ]]; then
          printf '%s\n%s\n' "$_pid_line" "$PORT" > "$PID_FILE" || true # DOCUMENTED FAIL-OPEN -- write failure is non-fatal; recorded port stays stale but daemon is healthy
          echo "CANON NOTE: reconciled recorded port in canon-daemon.pid (was :${_recorded_port}, now :${PORT})"
        fi
      fi
    fi
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
        if _supervisor_is_canon_daemon_pid "$STORED_PID"; then
          echo "CANON NOTE: clearing stale daemon PID $STORED_PID (version handoff)"
          _supervisor_escalate_kill "$STORED_PID" || true # DOCUMENTED FAIL-OPEN -- pre-start kill failure falls through to start attempt; post-start recovery catches a surviving owner
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
        if _supervisor_is_canon_daemon_pid "$STORED_PID"; then
          echo "CANON NOTE: daemon PID $STORED_PID is alive but unresponsive; clearing"
          _supervisor_escalate_kill "$STORED_PID" || true # DOCUMENTED FAIL-OPEN -- pre-start kill failure falls through to start attempt; post-start recovery catches a surviving owner
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
# Step 5+6: Start the daemon, poll for health, and — if the start did not
# reach the target version — recover from a surviving port-owner keyed on
# who actually holds the port (not just the PID file).
# ---------------------------------------------------------------------------
_supervisor_boot_and_poll
rc=$?
if (( rc == 0 )); then
  exit 0
fi

owner=$(_supervisor_resolve_port_owner_pid)
orc=$?
case $orc in
  2)
    echo "CANON WARNING: daemon start did not reach target version and the port owner could not be identified (lsof unavailable) — cannot auto-recover; run bash mcp-server/boot.sh --daemon manually."
    exit 0
    ;;
  1)
    # Port genuinely free — boot failed to start, nothing to kill.
    _supervisor_emit_down_block
    exit 0
    ;;
  0)
    if _supervisor_is_canon_daemon_pid "$owner"; then
      echo "CANON NOTE: surviving Canon daemon (PID $owner) still holds :${PORT} after start; clearing and retrying once"
      if ! _supervisor_escalate_kill "$owner"; then
        echo "CANON WARNING: could not clear surviving Canon daemon PID $owner (kill failed); daemon NOT started at target version — run bash mcp-server/boot.sh --daemon manually."
        exit 0
      fi
      _supervisor_boot_and_poll
      rc2=$?
      if (( rc2 == 0 )); then
        exit 0
      fi
      _supervisor_emit_down_block
      exit 0
    else
      echo "CANON WARNING: :${PORT} is held by non-Canon PID $owner (cmdline did not match tsx+daemon.ts); old daemon may have survived — refusing to kill (identity guard). Daemon NOT started at target version."
      exit 0
    fi
    ;;
esac
