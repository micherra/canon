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
#   1. Parse flags (--print-resolution, --force-dir)
#   2. Resolve SERVER_DIR
#   3. Sanity-check SERVER_DIR/src/app/index.ts
#   4. Compute DATA_DIR = ${CLAUDE_PLUGIN_DATA}/node_modules when set
#   5. DEPS-READY WAIT: if no usable tsx yet AND CLAUDE_PLUGIN_DATA set AND
#      not --print-resolution, poll DATA_DIR/.bin/tsx up to
#      CANON_BOOT_DEPS_TIMEOUT (default 60s, interval CANON_BOOT_DEPS_INTERVAL).
#   6. ESM CO-LOCATION: if DATA deps exist AND $SERVER_DIR/node_modules is NOT
#      a real directory → ln -sfn DATA_DIR SERVER_DIR/node_modules (idempotent,
#      survives cache wipes).  ln failure → loud CANON WARNING (never silent).
#   6b. DANGLING-LINK GUARD: if $SERVER_DIR/node_modules is a symlink but does
#      NOT resolve to a real dir → loud CANON ERROR + exit 1. Skipped under
#      --print-resolution. Real-dir (dev) and absent cases untouched.
#   7. Resolve NODE_PATH (PLUGIN_DATA first, co-located fallback)
#   8. Resolve tsx binary
#   9. --print-resolution branch (instant, skips wait + guard)
#  10. tsx-absent fail-closed (exit 1, loud)
#  11. Observability log + exec tsx
#
# New env knobs (test seams):
#   CANON_BOOT_DEPS_TIMEOUT   — max ticks to wait for deps (default: 60)
#   CANON_BOOT_DEPS_INTERVAL  — sleep duration between ticks (default: 1)
#
# Flags (for testing only):
#   --print-resolution   Print "SERVER_DIR NODE_PATH TSX_BIN" to stdout and exit 0.
#   --force-dir <dir>    Override SERVER_DIR resolution for test isolation.
#
# Never calls npx. Fails closed with a loud stderr message on any resolution failure.
set -euo pipefail

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------
PRINT_RESOLUTION=0
FORCE_DIR=""
while [[ $# -gt 0 ]]; do
  case "${1:-}" in
    --print-resolution) PRINT_RESOLUTION=1; shift ;;
    --force-dir) FORCE_DIR="${2:-}"; shift 2 ;;
    *) break ;;
  esac
done

# ---------------------------------------------------------------------------
# Step 1: Resolve SERVER_DIR
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

# Sanity-check: SERVER_DIR must contain src/app/index.ts
if [[ ! -f "${SERVER_DIR}/src/app/index.ts" ]]; then
  echo "CANON ERROR: cannot resolve MCP server dir (${SERVER_DIR} does not contain src/app/index.ts)" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 2: Compute DATA_DIR from CLAUDE_PLUGIN_DATA (if set)
# ---------------------------------------------------------------------------
DATA_DIR=""
if [[ -n "${CLAUDE_PLUGIN_DATA:-}" ]]; then
  DATA_DIR="${CLAUDE_PLUGIN_DATA}/node_modules"
fi

# ---------------------------------------------------------------------------
# Step 3 (new): Deps-ready wait
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
# Step 4 (new): ESM co-location symlink
# Create $SERVER_DIR/node_modules → DATA_DIR when DATA deps are present AND
# $SERVER_DIR/node_modules is NOT a real directory (never clobber dev working tree).
# ln -sfn is idempotent: recreates the symlink on every launch, surviving cache wipes.
# ---------------------------------------------------------------------------
if [[ -n "${DATA_DIR:-}" ]] && [[ -x "${DATA_DIR}/.bin/tsx" ]]; then
  if [[ ! -e "${SERVER_DIR}/node_modules" ]] || [[ -L "${SERVER_DIR}/node_modules" ]]; then
    if ! ln -sfn "$DATA_DIR" "${SERVER_DIR}/node_modules"; then
      # FALLBACK: SERVER_DIR read-only — see decision mcp-boot-esm-deps-01; loader hook
      # is the documented degrade path.
      >&2 echo "CANON WARNING: could not create ESM node_modules symlink in $SERVER_DIR (read-only?); ESM imports may fail"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Step 4b (new): Dangling-symlink fail-closed guard
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
# Step 5: Resolve NODE_PATH / deps dir
# ---------------------------------------------------------------------------
NODE_PATH=""
if [[ -n "${CLAUDE_PLUGIN_DATA:-}" ]] && [[ -d "${CLAUDE_PLUGIN_DATA}/node_modules" ]]; then
  NODE_PATH="${CLAUDE_PLUGIN_DATA}/node_modules"
elif [[ -d "${SERVER_DIR}/node_modules" ]]; then
  NODE_PATH="${SERVER_DIR}/node_modules"
fi
export NODE_PATH

# ---------------------------------------------------------------------------
# Step 6: Resolve tsx binary
# ---------------------------------------------------------------------------
TSX_BIN=""
if [[ -n "${NODE_PATH:-}" ]] && [[ -x "${NODE_PATH}/.bin/tsx" ]]; then
  TSX_BIN="${NODE_PATH}/.bin/tsx"
elif [[ -x "${SERVER_DIR}/node_modules/.bin/tsx" ]]; then
  TSX_BIN="${SERVER_DIR}/node_modules/.bin/tsx"
fi

# ---------------------------------------------------------------------------
# Step 7: Print resolution info for testing / debugging
# (runs before the tsx-absent error so --print-resolution always produces
# output even in environments without node_modules installed)
# ---------------------------------------------------------------------------
if [[ $PRINT_RESOLUTION -eq 1 ]]; then
  echo "$SERVER_DIR $NODE_PATH $TSX_BIN"
  exit 0
fi

if [[ -z "${TSX_BIN}" ]]; then
  echo "CANON ERROR: tsx not found — SessionStart deps install may not have run" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 8: Observability log + launch
# ---------------------------------------------------------------------------
echo "CANON: booting MCP server from $SERVER_DIR (NODE_PATH=${NODE_PATH:-<not set>})" >&2

cd "$SERVER_DIR"
exec "$TSX_BIN" src/app/index.ts
