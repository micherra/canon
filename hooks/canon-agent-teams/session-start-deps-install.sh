#!/usr/bin/env bash
# session-start-deps-install.sh — Canon MCP server SessionStart deps install hook.
#
# Installs Canon MCP server dependencies into ${CLAUDE_PLUGIN_DATA} using the
# compare-manifest pattern (from the official plugins reference). This ensures
# a fresh cache copy of the plugin can boot without a manual `npm ci`, and
# deps are re-installed whenever the plugin version changes (different package.json).
#
# Always exits 0 — this is an advisory hook; never blocks session startup.
# Uses `set -uo pipefail` (NOT -e) so the script runs to completion.
set -uo pipefail

# ---------------------------------------------------------------------------
# Step 1: Resolve ROOT and MCP_DIR
# ---------------------------------------------------------------------------
ROOT="${CLAUDE_PLUGIN_ROOT:-}"
if [[ -z "$ROOT" ]]; then
  # Dev / repo-as-project context: derive from this script's location.
  # This script lives in hooks/canon-agent-teams/; two levels up is the repo root.
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi

MCP_DIR="$ROOT/mcp-server"

if [[ ! -f "$MCP_DIR/package.json" ]]; then
  echo "CANON NOTE: mcp-server package.json not found at $MCP_DIR/package.json; skipping deps install"
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 2: Resolve DATA dir
# ---------------------------------------------------------------------------
DATA="${CLAUDE_PLUGIN_DATA:-}"
if [[ -z "$DATA" ]]; then
  # Dev context: no plugin data dir available. boot.sh's working-tree node_modules
  # fallback handles dev execution. Skip install with a note.
  echo "CANON NOTE: CLAUDE_PLUGIN_DATA is not set (dev/no-plugin context); skipping deps install. Run 'npm install' in mcp-server/ for dev."
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 3: Compare-manifest install
# ---------------------------------------------------------------------------
if ! diff -q "$MCP_DIR/package.json" "$DATA/package.json" >/dev/null 2>&1; then
  echo "CANON NOTE: installing Canon MCP server dependencies into plugin data dir ($DATA)..."
  ( cd "$DATA" \
    && cp "$MCP_DIR/package.json" . \
    && cp "$MCP_DIR/package-lock.json" . 2>/dev/null || true \
    && npm install --no-audit --no-fund ) \
    || { echo "CANON WARN: npm install failed; removing stored manifest so next session retries" >&2; rm -f "$DATA/package.json"; }
fi

exit 0
