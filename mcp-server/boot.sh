#!/usr/bin/env bash
# boot.sh — self-resolving Canon MCP server launcher.
#
# Works in two load contexts:
#   1. Plugin context: CLAUDE_PLUGIN_ROOT is set and expanded by the platform.
#      SERVER_DIR = ${CLAUDE_PLUGIN_ROOT}/mcp-server
#   2. Project/dev context: CLAUDE_PLUGIN_ROOT is unset or contains a literal
#      token. SERVER_DIR is derived from this script's own location via
#      BASH_SOURCE (boot.sh lives inside mcp-server/, so its parent IS the
#      server dir). This is the guaranteed backstop.
#
# Deps resolution sequence (post-fix):
#   1. Parse flags (--print-resolution, --force-dir, --daemon)
#   2. Resolve SERVER_DIR
#   3. Sanity-check SERVER_DIR/src/app/index.ts (and daemon.ts when --daemon)
#   4. Compute DATA_DIR = ${CLAUDE_PLUGIN_DATA}/node_modules when set
#   5. CLEAR STALE DANGLING LINK: if $SERVER_DIR/node_modules is a symlink that
#      does NOT resolve to a real dir (left over from a prior boot + wiped cache),
#      remove it BEFORE the wait. Otherwise both the link and DATA_DIR would be
#      missing tsx and the poll would stall for the full timeout. Skipped under
#      --print-resolution. Real-dir (dev) and absent cases untouched.
#   6. DEPS-READY WAIT: if no usable tsx yet AND CLAUDE_PLUGIN_DATA set AND
#      not --print-resolution, poll DATA_DIR/.bin/tsx up to
#      CANON_BOOT_DEPS_TIMEOUT ticks (each tick sleeps CANON_BOOT_DEPS_INTERVAL
#      seconds; wall-clock timeout = TIMEOUT × INTERVAL).
#   7. ESM CO-LOCATION: if DATA deps exist AND $SERVER_DIR/node_modules is NOT
#      a real directory → recreate symlink to DATA_DIR (idempotent, survives
#      cache wipes). ln failure → loud CANON WARNING (never silent).
#   8. DANGLING-LINK GUARD: if $SERVER_DIR/node_modules is still a symlink that
#      does NOT resolve to a real dir (deps never arrived) → loud CANON ERROR +
#      exit 1. Skipped under --print-resolution.
#   9. Resolve NODE_PATH (PLUGIN_DATA first, co-located fallback)
#  10. Resolve tsx binary
#  11. --print-resolution branch (instant, skips wait + guard)
#  12. tsx-absent fail-closed (exit 1, loud)
#  13. Observability log + exec tsx
#
# New env knobs (test seams):
#   CANON_BOOT_DEPS_TIMEOUT   — max poll ticks to wait for deps (default: 60).
#                               Wall-clock timeout = TIMEOUT × INTERVAL seconds.
#   CANON_BOOT_DEPS_INTERVAL  — sleep (seconds) per tick (default: 1).
#                               Default 60 × 1s = 60s wall clock; lowering the
#                               interval shortens the real timeout proportionally.
#
# Flags (for testing only):
#   --print-resolution   Print "SERVER_DIR NODE_PATH TSX_BIN" to stdout and exit 0.
#   --force-dir <dir>    Override SERVER_DIR resolution for test isolation.
#   --daemon             Launch the HTTP daemon entry point (src/app/daemon.ts)
#                        instead of the default stdio entry point (src/app/index.ts).
#                        Every other resolution step is shared and unchanged.
#
# Never calls npx. Fails closed with a loud stderr message on any resolution failure.
set -euo pipefail

# ---------------------------------------------------------------------------
# Step 1: Parse flags
# ---------------------------------------------------------------------------
PRINT_RESOLUTION=0
FORCE_DIR=""
DAEMON_MODE=0
while [[ $# -gt 0 ]]; do
  case "${1:-}" in
    --print-resolution) PRINT_RESOLUTION=1; shift ;;
    --force-dir) FORCE_DIR="${2:-}"; shift 2 ;;
    --daemon) DAEMON_MODE=1; export CANON_HTTP_DAEMON=1; shift ;;
    *) break ;;
  esac
done

# ---------------------------------------------------------------------------
# Step 2: Resolve SERVER_DIR
# ---------------------------------------------------------------------------
SERVER_DIR=""

if [[ -n "${FORCE_DIR:-}" ]]; then
  # Test-isolation override
  SERVER_DIR="$FORCE_DIR"
elif [[ -n "${CLAUDE_PLUGIN_ROOT:-}" ]] && [[ -d "${CLAUDE_PLUGIN_ROOT}/mcp-server" ]]; then
  # Plugin context: CLAUDE_PLUGIN_ROOT expanded by the platform.
  SERVER_DIR="${CLAUDE_PLUGIN_ROOT}/mcp-server"
else
  # Project/dev context (or CLAUDE_PLUGIN_ROOT did not expand / has no mcp-server/).
  # Derive from this script's own absolute location — BASH_SOURCE is always set
  # when a script is sourced or executed via bash.
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  SERVER_DIR="$SCRIPT_DIR"
fi

# ---------------------------------------------------------------------------
# Step 3: Sanity-check SERVER_DIR/src/app/index.ts (and daemon.ts when --daemon)
# ---------------------------------------------------------------------------
# Sanity-check: SERVER_DIR must contain src/app/index.ts
if [[ ! -f "${SERVER_DIR}/src/app/index.ts" ]]; then
  echo "CANON ERROR: cannot resolve MCP server dir (${SERVER_DIR} does not contain src/app/index.ts)" >&2
  exit 1
fi
# Additional check: --daemon requires src/app/daemon.ts to exist
if [[ $DAEMON_MODE -eq 1 ]] && [[ ! -f "${SERVER_DIR}/src/app/daemon.ts" ]]; then
  echo "CANON ERROR: --daemon specified but ${SERVER_DIR}/src/app/daemon.ts does not exist" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 4: Compute DATA_DIR from CLAUDE_PLUGIN_DATA (if set)
# ---------------------------------------------------------------------------
DATA_DIR=""
if [[ -n "${CLAUDE_PLUGIN_DATA:-}" ]]; then
  DATA_DIR="${CLAUDE_PLUGIN_DATA}/node_modules"
fi

# ---------------------------------------------------------------------------
# Step 5: Clear a STALE DANGLING co-location symlink BEFORE the wait.
# A prior boot may have left $SERVER_DIR/node_modules as a symlink to DATA_DIR;
# if the cache was then wiped, that link now dangles (resolves to nothing).
# Removing it up front prevents the deps-ready poll below from stalling the full
# timeout when both the link AND DATA_DIR are missing tsx — the poll watches
# DATA_DIR/.bin/tsx, and the stale link would otherwise be re-evaluated by the
# fail-closed guard only after the wait. rm of a symlink removes ONLY the link.
# Untouched: real dev node_modules directories (-L is false) and absent paths.
# Skipped under --print-resolution (keep that instant and side-effect-free).
# ---------------------------------------------------------------------------
if [[ $PRINT_RESOLUTION -eq 0 ]]; then
  if [[ -L "${SERVER_DIR}/node_modules" ]] && [[ ! -d "${SERVER_DIR}/node_modules" ]]; then
    rm -f "${SERVER_DIR}/node_modules"
  fi
fi

# ---------------------------------------------------------------------------
# Step 6: Deps-ready wait
# Poll for DATA_DIR/.bin/tsx when:
#   - The working-tree tsx is NOT already present (no co-located node_modules)
#   - CLAUDE_PLUGIN_DATA is set (DATA_DIR is the candidate)
#   - Not running under --print-resolution (keep that instant and deterministic)
# On timeout, fall through to the fail-closed tsx-absent branch below.
# ---------------------------------------------------------------------------
if [[ $PRINT_RESOLUTION -eq 0 ]] && \
   [[ -n "${DATA_DIR:-}" ]] && \
   [[ ! -x "${SERVER_DIR}/node_modules/.bin/tsx" ]]; then
  if [[ ! -x "${DATA_DIR}/.bin/tsx" ]]; then
    >&2 echo "CANON: waiting for SessionStart deps install..."
    TIMEOUT="${CANON_BOOT_DEPS_TIMEOUT:-60}"
    INTERVAL="${CANON_BOOT_DEPS_INTERVAL:-1}"
    elapsed=0
    while [[ ! -x "${DATA_DIR}/.bin/tsx" ]] && (( elapsed < TIMEOUT )); do
      sleep "$INTERVAL"
      elapsed=$(( elapsed + 1 ))
    done
    # On exhaustion, fall through to the tsx-absent exit below (single loud-exit site).
  fi
fi

# ---------------------------------------------------------------------------
# Step 7: ESM co-location symlink
# Create $SERVER_DIR/node_modules → DATA_DIR when DATA deps are present AND
# $SERVER_DIR/node_modules is NOT a real directory (never clobber dev working tree).
# Portable + safe replace: `rm -f "$link"` then `ln -s "$target" "$link"`.
# A bare `ln -sf` would FOLLOW an existing symlink-to-directory and create the new
# link INSIDE the pointed-to dir instead of replacing the link — `ln -sfn` papers
# over that but is non-portable (GNU/BSD `-n` differ). `rm -f` on a symlink removes
# only the link (never the target), and is a no-op on an absent path — so it stays
# safe whether step 5 already cleared a stale link or the path was never present.
# Idempotent: recreates the symlink on every launch, surviving cache wipes.
# ---------------------------------------------------------------------------
if [[ -n "${DATA_DIR:-}" ]] && [[ -x "${DATA_DIR}/.bin/tsx" ]]; then
  if [[ ! -e "${SERVER_DIR}/node_modules" ]] || [[ -L "${SERVER_DIR}/node_modules" ]]; then
    rm -f "${SERVER_DIR}/node_modules"
    if ! ln -s "$DATA_DIR" "${SERVER_DIR}/node_modules"; then
      # FALLBACK: SERVER_DIR read-only — see decision mcp-boot-esm-deps-01; loader hook
      # is the documented degrade path.
      >&2 echo "CANON WARNING: could not create ESM node_modules symlink in $SERVER_DIR (read-only?); ESM imports may fail"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Step 8: Dangling-symlink fail-closed guard
# A [[ -d ]] test follows the symlink; it is FALSE for a dangling link.
# Refuse to boot a server that would crash with ERR_MODULE_NOT_FOUND.
# Skipped under --print-resolution (keep that instant).
# ---------------------------------------------------------------------------
if [[ $PRINT_RESOLUTION -eq 0 ]]; then
  if [[ -L "${SERVER_DIR}/node_modules" ]] && [[ ! -d "${SERVER_DIR}/node_modules" ]]; then
    >&2 echo "CANON ERROR: ${SERVER_DIR}/node_modules symlink does not resolve to a real dir (PLUGIN_DATA wiped/empty?); refusing to boot a server that would crash with ERR_MODULE_NOT_FOUND"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Step 9: Resolve NODE_PATH / deps dir
# ---------------------------------------------------------------------------
NODE_PATH=""
if [[ -n "${CLAUDE_PLUGIN_DATA:-}" ]] && [[ -d "${CLAUDE_PLUGIN_DATA}/node_modules" ]]; then
  NODE_PATH="${CLAUDE_PLUGIN_DATA}/node_modules"
elif [[ -d "${SERVER_DIR}/node_modules" ]]; then
  NODE_PATH="${SERVER_DIR}/node_modules"
fi
export NODE_PATH

# ---------------------------------------------------------------------------
# Step 10: Resolve tsx binary
# ---------------------------------------------------------------------------
TSX_BIN=""
if [[ -n "${NODE_PATH:-}" ]] && [[ -x "${NODE_PATH}/.bin/tsx" ]]; then
  TSX_BIN="${NODE_PATH}/.bin/tsx"
elif [[ -x "${SERVER_DIR}/node_modules/.bin/tsx" ]]; then
  TSX_BIN="${SERVER_DIR}/node_modules/.bin/tsx"
fi

# ---------------------------------------------------------------------------
# Step 11: Print resolution info for testing / debugging
# (runs before the tsx-absent error so --print-resolution always produces
# output even in environments without node_modules installed)
#
# Output format (stable; do NOT reorder existing lines):
#   Line 1: SERVER_DIR NODE_PATH TSX_BIN  (legacy positional line — unchanged)
#   Line 2: NODE_VERSION=<v-prefixed version string, or empty>
#   Line 3: RESOLUTION_STATUS=<ok|tsx-missing|node-missing|node-too-old>
#
# RESOLUTION_STATUS derivation:
#   tsx-missing  — TSX_BIN is empty
#   node-missing — tsx is present but node -v produced no output
#   node-too-old — node major < 24
#   ok           — all checks pass
#
# NODE_VERSION and RESOLUTION_STATUS use the same major-extraction logic as
# the Step 12.5 preflight so the threshold cannot drift between diagnostic
# and enforcement paths (single source of truth via canon_node_major()).
# --print-resolution always exits 0 — it is diagnostic only; Step 12.5 is
# the enforcer on the real launch path.
# ---------------------------------------------------------------------------

# Helper: extract node major version number from a version string like "v24.1.0".
# Usage: canon_node_major "v24.1.0"  → prints "24"
# Returns empty string on malformed input.
canon_node_major() {
  local raw="${1:-}"
  local stripped="${raw#v}"       # strip leading 'v'
  local major="${stripped%%.*}"   # keep only the major component
  if [[ "$major" =~ ^[0-9]+$ ]]; then
    echo "$major"
  fi
}

if [[ $PRINT_RESOLUTION -eq 1 ]]; then
  # Line 1: legacy positional line — MUST remain first and unchanged.
  echo "$SERVER_DIR $NODE_PATH $TSX_BIN"

  # Resolve node version in SERVER_DIR context (matches real-launch resolution).
  DIAG_NODE_VERSION=""
  DIAG_NODE_VERSION=$( ( cd "$SERVER_DIR" && node -v 2>/dev/null ) ) || true

  # Line 2: NODE_VERSION (may be empty if node not found)
  echo "NODE_VERSION=${DIAG_NODE_VERSION}"

  # Line 3: RESOLUTION_STATUS
  DIAG_STATUS="ok"
  if [[ -z "${TSX_BIN}" ]]; then
    DIAG_STATUS="tsx-missing"
  elif [[ -z "$DIAG_NODE_VERSION" ]]; then
    DIAG_STATUS="node-missing"
  else
    DIAG_NODE_MAJOR=$(canon_node_major "$DIAG_NODE_VERSION")
    if [[ -n "$DIAG_NODE_MAJOR" ]] && (( DIAG_NODE_MAJOR < 24 )); then
      DIAG_STATUS="node-too-old"
    fi
  fi
  echo "RESOLUTION_STATUS=${DIAG_STATUS}"

  exit 0
fi

# ---------------------------------------------------------------------------
# Step 12: tsx-absent fail-closed (single loud-exit site for deps-never-arrived)
# ---------------------------------------------------------------------------
if [[ -z "${TSX_BIN}" ]]; then
  echo "CANON ERROR: tsx not found — SessionStart deps install may not have run" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 12.5: Node-version preflight
# Resolve node from SERVER_DIR context so asdf resolution matches the real
# launch. Require Node >=24; exit with a clear, actionable error if not met.
# Skipped under --print-resolution (already exited above).
# Uses canon_node_major() defined in Step 11 — single source of truth for
# major-version extraction so the threshold cannot drift between diagnostic
# (--print-resolution) and enforcement (real launch) paths.
# ---------------------------------------------------------------------------
NODE_VERSION_RAW=""
NODE_VERSION_RAW=$( ( cd "$SERVER_DIR" && node -v 2>/dev/null ) ) || true
if [[ -z "$NODE_VERSION_RAW" ]]; then
  echo "CANON ERROR: 'node' not found on PATH. Canon's MCP server requires Node >=24." >&2
  exit 1
fi
NODE_MAJOR=$(canon_node_major "$NODE_VERSION_RAW")
if [[ -n "$NODE_MAJOR" ]] && (( NODE_MAJOR < 24 )); then
  echo "CANON ERROR: Canon's MCP server requires Node >=24, but found ${NODE_VERSION_RAW}. Install or select Node 24+ (via your Node version manager — nvm, fnm, asdf, volta — or from https://nodejs.org) and retry." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 13: Observability log + launch
# ---------------------------------------------------------------------------
# Determine entry point: --daemon uses daemon.ts; default uses index.ts (stdio).
ENTRY="src/app/index.ts"
if [[ $DAEMON_MODE -eq 1 ]]; then
  ENTRY="src/app/daemon.ts"
fi

echo "CANON: booting MCP server from $SERVER_DIR (NODE_PATH=${NODE_PATH:-<not set>}) entry=$ENTRY" >&2

cd "$SERVER_DIR"
exec "$TSX_BIN" "$ENTRY"
