#!/usr/bin/env bash
# plugin-dir-resolver.test.sh — behavioral regression guard for the TypeScript
# resolvePluginDir resolver in src/app/server-state.ts.
#
# Why this file exists (DC4 — var-absent / literal-token regression guard):
#   Four prior boot fixes all assumed ${CLAUDE_PLUGIN_ROOT} would be expanded by
#   the harness, and none tested the CANON_PLUGIN_DIR var-ABSENT or literal-token
#   paths. This guard exercises those exact paths against the REAL TypeScript
#   resolver (via tsx) so it cannot drift from what ships — mirroring the approach
#   of mcp-json-resolver.test.sh for boot.sh.
#
# Layer 2 states tested (from DESIGN.md Regression Test Plan):
#   1. var present (real marker root)  → resolves to <fixture root>
#   2. var ABSENT                      → resolves via marker-walk to <fixture root>
#   3. literal ${CLAUDE_PLUGIN_ROOT}   → rejected; resolves via marker-walk
#   4. truly nothing (no markers)      → exits non-zero with diagnostic (DC3)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

# Locate tsx — the project uses tsx as its TypeScript execution runtime.
TSX_BIN="$SCRIPT_DIR/node_modules/.bin/tsx"
if [[ ! -x "$TSX_BIN" ]]; then
  echo "FATAL: tsx not found at $TSX_BIN — run 'npm ci' in mcp-server/ first"
  exit 1
fi

# The real resolver source — the guard reads it so it cannot drift from what ships.
RESOLVER_SRC="$SCRIPT_DIR/src/app/server-state.ts"
if [[ ! -f "$RESOLVER_SRC" ]]; then
  echo "FATAL: resolver source not found at $RESOLVER_SRC"
  exit 1
fi

# Build a temp fixture plugin root containing agents/ and principles/ (Canon markers)
# plus a mcp-server/src/app/ subdir (so the marker-walk from that path can traverse up).
make_fixture_root() {
  local root
  root="$(mktemp -d)"
  mkdir -p "$root/agents"
  mkdir -p "$root/principles"
  mkdir -p "$root/mcp-server/src/app"
  echo "$root"
}

# Write a temp TypeScript wrapper script that imports resolvePluginDir from the
# real server-state.ts, calls it with the given startDir, and prints the result.
# This is the key design: guard reads the real resolver — it cannot drift.
make_probe_script() {
  local start_dir="$1"
  local should_throw="${2:-false}"
  local tmpfile
  tmpfile="$(mktemp /tmp/canon-plugin-dir-probe-XXXXXX.ts)"
  if [[ "$should_throw" == "true" ]]; then
    cat > "$tmpfile" <<SCRIPT
import { resolvePluginDir } from "${RESOLVER_SRC}";
import { existsSync, statSync } from "node:fs";
const isDir = (p: string): boolean => {
  try { return existsSync(p) && statSync(p).isDirectory(); } catch { return false; }
};
const envVal: string | undefined = process.env.CANON_PLUGIN_DIR || undefined;
try {
  const result = resolvePluginDir(envVal, "${start_dir}", isDir);
  process.stdout.write("RESOLVED:" + result + "\n");
  process.exit(0);
} catch (e) {
  process.stderr.write("CANON FATAL: " + String(e) + "\n");
  process.exit(1);
}
SCRIPT
  else
    cat > "$tmpfile" <<SCRIPT
import { resolvePluginDir } from "${RESOLVER_SRC}";
import { existsSync, statSync } from "node:fs";
const isDir = (p: string): boolean => {
  try { return existsSync(p) && statSync(p).isDirectory(); } catch { return false; }
};
const envVal: string | undefined = process.env.CANON_PLUGIN_DIR || undefined;
const result = resolvePluginDir(envVal, "${start_dir}", isDir);
process.stdout.write(result + "\n");
SCRIPT
  fi
  echo "$tmpfile"
}

# Run the probe script under a controlled env. Returns tsx stdout.
# Args: probe_script canon_plugin_dir
run_probe() {
  local probe="$1"
  local canon_plugin_dir="$2"
  CANON_PLUGIN_DIR="$canon_plugin_dir" \
    "$TSX_BIN" --tsconfig "$SCRIPT_DIR/tsconfig.json" "$probe" 2>/dev/null
}

# Run probe and capture both stdout+stderr+exit
run_probe_full() {
  local probe="$1"
  local canon_plugin_dir="$2"
  ( CANON_PLUGIN_DIR="$canon_plugin_dir" \
    "$TSX_BIN" --tsconfig "$SCRIPT_DIR/tsconfig.json" "$probe" 2>&1; echo "EXIT:$?" )
}

FIXTURE="$(make_fixture_root)"
EMPTY_DIR="$(mktemp -d)"  # no Canon markers above it (just an empty temp dir)

# ── Test 1: var present (real marker root) → resolves to fixture root ─────────
PROBE="$(make_probe_script "$FIXTURE/mcp-server/src/app")"
OUT="$(run_probe "$PROBE" "$FIXTURE" 2>&1)"
rm -f "$PROBE"
if [[ "$OUT" == "$FIXTURE" ]]; then
  pass "var present (real marker root) resolves to fixture root"
else
  fail "var present: expected [$FIXTURE] got [$OUT]"
fi

# ── Test 2: var ABSENT → resolves via marker-walk to fixture root (DC1) ────────
# With CANON_PLUGIN_DIR empty (simulates unset — resolvePluginDir treats falsy as absent),
# the marker-walk starts from fixture/mcp-server/src/app and walks up to fixture.
PROBE="$(make_probe_script "$FIXTURE/mcp-server/src/app")"
OUT="$(run_probe "$PROBE" "" 2>&1)"
rm -f "$PROBE"
if [[ "$OUT" == "$FIXTURE" ]]; then
  pass "var ABSENT — resolves via marker-walk to fixture root (DC1)"
else
  fail "var-absent: expected [$FIXTURE] got [$OUT]"
fi

# ── Test 3: literal ${CLAUDE_PLUGIN_ROOT} token → rejected; resolves via marker-walk ──
# The literal token contains ${...} so the resolver rejects it and falls back to the
# marker-walk. The result must equal fixture root and must NOT contain the token string.
PROBE="$(make_probe_script "$FIXTURE/mcp-server/src/app")"
# Use single quotes to prevent bash expanding the variable
OUT="$(run_probe "$PROBE" '${CLAUDE_PLUGIN_ROOT}' 2>&1)"
rm -f "$PROBE"
if [[ "$OUT" == "$FIXTURE" && "$OUT" != *'${CLAUDE_PLUGIN_ROOT}'* ]]; then
  pass "literal \${CLAUDE_PLUGIN_ROOT} token rejected; marker-walk resolves to fixture root (DC2)"
else
  fail "literal-token: expected [$FIXTURE] (no token in path) got [$OUT]"
fi

# ── Test 4: truly nothing → exits non-zero with a loud diagnostic (DC3) ────────
# CANON_PLUGIN_DIR is the literal token AND the start dir is an empty dir with
# no Canon markers anywhere above it → findAnchorDir throws a loud diagnostic.
PROBE="$(make_probe_script "$EMPTY_DIR" "true")"
OUT="$(run_probe_full "$PROBE" '${CLAUDE_PLUGIN_ROOT}' 2>&1)"
rm -f "$PROBE"
if [[ "$OUT" == *"CANON FATAL"* && "$OUT" == *"EXIT:1"* ]]; then
  pass "truly nothing — fails loud with diagnostic, exits non-zero (DC3)"
else
  fail "truly-nothing: expected CANON FATAL + EXIT:1, got [$OUT]"
fi

# Cleanup temp dirs
rm -rf "$FIXTURE" "$EMPTY_DIR"

echo "----"
echo "plugin-dir-resolver: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
