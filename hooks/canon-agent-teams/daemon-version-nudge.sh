#!/usr/bin/env bash
# daemon-version-nudge.sh — PreToolUse stale-daemon version-mismatch nudge.
#
# Surfaces a non-blocking advisory when the running Canon HTTP daemon's
# /health version differs from the latest installed plugin version. This is
# detect-and-surface only: read-only, no process signaling, no daemon spawn.
#
# Always exits 0 — advisory hook; never blocks a tool call.
#
# Env knobs (all injectable for tests):
#   CANON_DAEMON_PORT       — port to probe (default: 3142)
#   CANON_DAEMON_NUDGE_TTL  — probe cache TTL seconds (default: 60)
#   CANON_NUDGE_HEALTH_CMD  — command whose stdout replaces the real /health
#                             curl body (test seam)
#   CANON_PROJECT_DIR       — project dir holding .canon/ state (default: .)
#   CLAUDE_PLUGIN_ROOT      — plugin install root; installed version is
#                             resolved as the max-semver sibling dir of its
#                             parent (NOT this dir's own package.json —
#                             session-pinned and misses mid-session updates)
set -uo pipefail

# Consume stdin (required by Claude Code hook contract)
# shellcheck disable=SC2034  # INPUT unused: consumed to satisfy hook stdin contract
INPUT=$(cat)

PORT="${CANON_DAEMON_PORT:-3142}"
TTL="${CANON_DAEMON_NUDGE_TTL:-60}"
if [[ ! "$TTL" =~ ^[0-9]+$ ]]; then
  TTL=60 # DOCUMENTED FAIL-OPEN -- non-numeric TTL override; fall back to default rather than leak a bash arithmetic error
fi
CANON_DIR="${CANON_PROJECT_DIR:-.}/.canon"
PROBE_FILE="$CANON_DIR/.daemon-version-probe"
NUDGE_FILE="$CANON_DIR/.daemon-version-nudge-shown"

# ---------------------------------------------------------------------------
# Step 1: resolve installed version (Decision version-resolution-01) — the
# max-semver sibling cache dir of CLAUDE_PLUGIN_ROOT. This reflects a
# mid-session plugin-update (which writes a new sibling dir); reading
# CLAUDE_PLUGIN_ROOT/mcp-server/package.json would not, since
# CLAUDE_PLUGIN_ROOT is pinned at session start.
# ---------------------------------------------------------------------------
if [[ -z "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
  exit 0
fi

PARENT="$(dirname "$CLAUDE_PLUGIN_ROOT")"
INSTALLED_VERSION=""
if [[ -d "$PARENT" ]]; then
  INSTALLED_VERSION=$(
    for d in "$PARENT"/*/; do
      [[ -d "$d" ]] || continue # DOCUMENTED FAIL-OPEN -- glob with no match expands literally; skip non-dirs
      b="$(basename "$d")"
      if [[ "$b" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        echo "$b"
      fi
    done | sort -t. -k1,1n -k2,2n -k3,3n | tail -n1
  )
fi

if [[ -z "$INSTALLED_VERSION" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 2: TTL-throttled /health probe
# ---------------------------------------------------------------------------
if ! mkdir -p "$CANON_DIR" 2>/dev/null; then
  exit 0 # DOCUMENTED FAIL-OPEN -- cannot create .canon state dir; treat as no-op
fi

NOW=$(date +%s)
DAEMON_VERSION=""
USE_CACHE=0

if [[ -f "$PROBE_FILE" ]]; then
  PROBE_TS=""
  PROBE_VERSION=""
  read -r PROBE_TS PROBE_VERSION < "$PROBE_FILE" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- unreadable/malformed probe file; treated as no cache below
  if [[ "$PROBE_TS" =~ ^[0-9]+$ ]]; then
    AGE=$(( NOW - PROBE_TS ))
    if (( AGE >= 0 && AGE < TTL )); then
      DAEMON_VERSION="$PROBE_VERSION"
      USE_CACHE=1
    fi
  fi
fi

if [[ "$USE_CACHE" -eq 0 ]]; then
  BODY=""
  if [[ -n "${CANON_NUDGE_HEALTH_CMD:-}" ]]; then
    BODY=$(eval "$CANON_NUDGE_HEALTH_CMD" 2>/dev/null) # DOCUMENTED FAIL-OPEN -- test-seam command may fail; empty body handled below
  else
    BODY=$(curl -s -m 1 "http://127.0.0.1:${PORT}/health" 2>/dev/null) # DOCUMENTED FAIL-OPEN -- daemon may be unreachable; empty body handled below
  fi
  DAEMON_VERSION=$(echo "$BODY" | grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 | sed 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/')
  printf '%s %s\n' "$NOW" "$DAEMON_VERSION" > "$PROBE_FILE" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- probe-cache write failure just means next call re-probes; not fatal
fi

# ---------------------------------------------------------------------------
# Step 3: compare — fail open on empty daemon version (probe failed) or match
# ---------------------------------------------------------------------------
if [[ -z "$DAEMON_VERSION" ]]; then
  exit 0
fi

if [[ "$DAEMON_VERSION" == "$INSTALLED_VERSION" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 4: mismatch — dedup against the last-shown pair, then nudge
# ---------------------------------------------------------------------------
PAIR="$DAEMON_VERSION $INSTALLED_VERSION"

if [[ -f "$NUDGE_FILE" ]]; then
  EXISTING_PAIR=$(cat "$NUDGE_FILE" 2>/dev/null) || EXISTING_PAIR="" # DOCUMENTED FAIL-OPEN -- unreadable nudge-shown file; treat as not-yet-shown
  if [[ "$EXISTING_PAIR" == "$PAIR" ]]; then
    exit 0
  fi
fi

echo "CANON NOTE: stale Canon daemon — running v${DAEMON_VERSION}, plugin v${INSTALLED_VERSION}. Run /canon:doctor to diagnose and, on confirmation, restart it (no action taken; this is advisory)."
printf '%s\n' "$PAIR" > "$NUDGE_FILE" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- nudge-shown write failure only risks a repeat nudge next call; not fatal

exit 0
