#!/usr/bin/env bash
set -euo pipefail

OUT_DIR="dist"
OUT_TGZ="${OUT_DIR}/cursor-canon-everything.tgz"

mkdir -p "$OUT_DIR"

TMP_DIR="$(mktemp -d)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

STAGE_DIR="$TMP_DIR/cursor-canon-bundle"
mkdir -p "$STAGE_DIR"

copy_into_stage() {
  local src="$1"
  local dst="$2"
  mkdir -p "$(dirname "$STAGE_DIR/$dst")"
  cp -R "$src" "$STAGE_DIR/$dst"
}

repo_root="$(pwd)"

echo "Creating Cursor Canon bundle..."

# Cursor integration files
copy_into_stage "${repo_root}/AGENTS.md" "."
copy_into_stage "${repo_root}/CURSOR.md" "."
copy_into_stage "${repo_root}/.cursor/mcp.json" ".cursor/mcp.json"
cp -R "${repo_root}/.cursor/agents" "$STAGE_DIR/.cursor/"
cp -R "${repo_root}/.cursor/hooks" "$STAGE_DIR/.cursor/"

# Canon runtime needed by the Cursor runner
cp -R "${repo_root}/mcp-server" "$STAGE_DIR/"
cp -R "${repo_root}/flows" "$STAGE_DIR/"
cp -R "${repo_root}/agents" "$STAGE_DIR/"
cp -R "${repo_root}/agent-rules" "$STAGE_DIR/"
cp -R "${repo_root}/principles" "$STAGE_DIR/"
cp -R "${repo_root}/templates" "$STAGE_DIR/"
cp -R "${repo_root}/hooks" "$STAGE_DIR/"
cp -R "${repo_root}/commands" "$STAGE_DIR/"
cp -R "${repo_root}/cursor-extension" "$STAGE_DIR/"
cp -R "${repo_root}/CLAUDE.md" "$STAGE_DIR/"

# Optional: include project-level MCP config (mostly for completeness)
if [ -f "${repo_root}/.mcp.json" ]; then
  cp -R "${repo_root}/.mcp.json" "$STAGE_DIR/"
fi

echo "Bundling to: $OUT_TGZ"
tar -C "$TMP_DIR/cursor-canon-bundle" -czf "$OUT_TGZ" .

echo "Bundle created: $OUT_TGZ"

