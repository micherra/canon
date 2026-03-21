#!/usr/bin/env bash
set -euo pipefail

# Resolve repo root based on this script's location.
# This script is invoked from within `canon-cursor-cli/` during `npm pack`,
# so we cannot rely on the current working directory.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

OUT_DIR="${REPO_ROOT}/dist"
OUT_TGZ="${OUT_DIR}/canon-cursor-everything.tgz"

mkdir -p "$OUT_DIR"

# The sandbox can restrict directory creation in randomly-named mktemp dirs.
# Use a deterministic workspace-local temp directory instead.
TMP_DIR="${REPO_ROOT}/.tmp/canon-cursor-bundle-tmp"
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

STAGE_DIR="$TMP_DIR/canon-cursor-bundle"
mkdir -p "$STAGE_DIR"

copy_into_stage() {
  local src="$1"
  local dst="$2"
  mkdir -p "$(dirname "$STAGE_DIR/$dst")"
  cp -R "$src" "$STAGE_DIR/$dst"
}

echo "Creating Cursor Canon bundle..."

# Cursor integration files
copy_into_stage "${REPO_ROOT}/AGENTS.md" "."
copy_into_stage "${REPO_ROOT}/CURSOR.md" "."
copy_into_stage "${REPO_ROOT}/.cursor/mcp.json" ".cursor/mcp.json"

# Canon runtime needed by the Cursor runner
cp -R "${REPO_ROOT}/.cursor/agents" "$STAGE_DIR/.cursor/"
cp -R "${REPO_ROOT}/.cursor/hooks" "$STAGE_DIR/.cursor/"
rm -f "$STAGE_DIR/.cursor/hooks/state/continual-learning.json" "$STAGE_DIR/.cursor/hooks/state/._continual-learning.json"

cp -R "${REPO_ROOT}/mcp-server" "$STAGE_DIR/"
cp -R "${REPO_ROOT}/flows" "$STAGE_DIR/"
cp -R "${REPO_ROOT}/agents" "$STAGE_DIR/"
cp -R "${REPO_ROOT}/agent-rules" "$STAGE_DIR/"
cp -R "${REPO_ROOT}/principles" "$STAGE_DIR/"
cp -R "${REPO_ROOT}/templates" "$STAGE_DIR/"
cp -R "${REPO_ROOT}/hooks" "$STAGE_DIR/"
cp -R "${REPO_ROOT}/commands" "$STAGE_DIR/"
cp -R "${REPO_ROOT}/cursor-extension" "$STAGE_DIR/"
cp -R "${REPO_ROOT}/CLAUDE.md" "$STAGE_DIR/"

# Optional: include project-level MCP config (mostly for completeness)
if [ -f "${REPO_ROOT}/.mcp.json" ]; then
  cp -R "${REPO_ROOT}/.mcp.json" "$STAGE_DIR/"
fi

echo "Bundling to: $OUT_TGZ"
tar -C "$TMP_DIR/canon-cursor-bundle" -czf "$OUT_TGZ" .

echo "Bundle created: $OUT_TGZ"

