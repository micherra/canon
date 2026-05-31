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
# Deps resolution:
#   Prefer ${CLAUDE_PLUGIN_DATA}/node_modules (SessionStart hook installs here).
#   Fallback: $SERVER_DIR/node_modules (dev working tree or --plugin-dir install).
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
# Step 2: Resolve NODE_PATH / deps dir
# ---------------------------------------------------------------------------
NODE_PATH=""
if [[ -n "${CLAUDE_PLUGIN_DATA:-}" ]] && [[ -d "${CLAUDE_PLUGIN_DATA}/node_modules" ]]; then
  NODE_PATH="${CLAUDE_PLUGIN_DATA}/node_modules"
elif [[ -d "${SERVER_DIR}/node_modules" ]]; then
  NODE_PATH="${SERVER_DIR}/node_modules"
fi
export NODE_PATH

# ---------------------------------------------------------------------------
# Step 3: Resolve tsx binary
# ---------------------------------------------------------------------------
TSX_BIN=""
if [[ -n "${NODE_PATH:-}" ]] && [[ -x "${NODE_PATH}/.bin/tsx" ]]; then
  TSX_BIN="${NODE_PATH}/.bin/tsx"
elif [[ -x "${SERVER_DIR}/node_modules/.bin/tsx" ]]; then
  TSX_BIN="${SERVER_DIR}/node_modules/.bin/tsx"
fi

if [[ -z "${TSX_BIN}" ]]; then
  echo "CANON ERROR: tsx not found — SessionStart deps install may not have run" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Step 4: Print resolution info for testing / debugging
# ---------------------------------------------------------------------------
if [[ $PRINT_RESOLUTION -eq 1 ]]; then
  echo "$SERVER_DIR $NODE_PATH $TSX_BIN"
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 5: Observability log + launch
# ---------------------------------------------------------------------------
echo "CANON: booting MCP server from $SERVER_DIR (NODE_PATH=${NODE_PATH:-<not set>})" >&2

cd "$SERVER_DIR"
exec "$TSX_BIN" src/app/index.ts
