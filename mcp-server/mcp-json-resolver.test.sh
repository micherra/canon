#!/usr/bin/env bash
# mcp-json-resolver.test.sh — behavioral tests for the boot.sh *locator* embedded
# in .mcp.json's `args` (the `-c` payload that runs BEFORE boot.sh).
#
# Why this file exists (regression guard, see PRs #191/#287/#356):
#   Four prior boot fixes all assumed ${CLAUDE_PLUGIN_ROOT} would be set and only
#   changed HOW it was passed (args <-> env). None tested the var-ABSENT path, so
#   the config kept silently collapsing to `bash "/mcp-server/boot.sh"` -> -32000.
#   These tests exercise the resolver with the var present, absent (dev context),
#   absent+cwd-only, cache-fallback-only, and truly-nothing (must FAIL LOUD).
#
# The payload is read from the real .mcp.json so the test cannot drift from what
# ships. Resolution is exercised against a STUB boot.sh (no real server launch).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MCP_JSON="$REPO_ROOT/.mcp.json"
PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

# Extract the exact `-c` payload Claude Code would run (from the real config).
PAYLOAD="$(node -e 'const j=require(process.argv[1]);process.stdout.write(j.mcpServers.canon.args[1])' "$MCP_JSON")"
if [[ -z "$PAYLOAD" ]]; then
  echo "FATAL: could not extract args[1] from $MCP_JSON"; exit 1
fi

# A fake plugin/project root whose mcp-server/boot.sh is a stub that announces itself.
make_stub_root() {
  local root; root="$(mktemp -d)"
  mkdir -p "$root/mcp-server"
  printf '#!/usr/bin/env bash\necho "STUB_BOOTED:%s"\n' "$root" > "$root/mcp-server/boot.sh"
  chmod +x "$root/mcp-server/boot.sh"
  echo "$root"
}

# Run the payload under a fully controlled env in a guaranteed-empty cwd.
# args: HOME cwd CLAUDE_PLUGIN_ROOT CANON_PLUGIN_DIR CLAUDE_PROJECT_DIR
run_payload() {
  ( cd "$2" && env -i HOME="$1" PATH="$PATH" PWD="$2" \
      CLAUDE_PLUGIN_ROOT="$3" CANON_PLUGIN_DIR="$4" CLAUDE_PROJECT_DIR="$5" \
      bash -c "$PAYLOAD" 2>&1; echo "EXIT:$?" )
}

STUB="$(make_stub_root)"
EMPTY="$(mktemp -d)"   # guaranteed to contain no mcp-server/boot.sh

# Test 1 — plugin context: CLAUDE_PLUGIN_ROOT set -> candidate 1.
OUT="$(run_payload /nonexistent "$EMPTY" "$STUB" "" "")"
if [[ "$OUT" == *"STUB_BOOTED:$STUB"* ]]; then
  pass "candidate CLAUDE_PLUGIN_ROOT resolves"
else
  fail "CLAUDE_PLUGIN_ROOT: got [$OUT]"
fi

# Test 2 — THE regression: plugin vars absent, CLAUDE_PROJECT_DIR set (dev context).
OUT="$(run_payload /nonexistent "$EMPTY" "" "" "$STUB")"
if [[ "$OUT" == *"STUB_BOOTED:$STUB"* ]]; then
  pass "var-ABSENT dev context resolves via CLAUDE_PROJECT_DIR"
else
  fail "var-absent dev: got [$OUT]"
fi

# Test 3 — only cwd/PWD points at the root (every candidate var empty).
OUT="$(run_payload /nonexistent "$STUB" "" "" "")"
if [[ "$OUT" == *"STUB_BOOTED:$STUB"* ]]; then
  pass "candidate PWD resolves"
else
  fail "PWD: got [$OUT]"
fi

# Test 4 — all candidate vars miss + empty cwd; plugin-cache glob finds newest install.
CACHE_HOME="$(mktemp -d)"
mkdir -p "$CACHE_HOME/.claude/plugins/cache/mk/canon/9.9.9/mcp-server"
printf '#!/usr/bin/env bash\necho "STUB_BOOTED:cache"\n' > "$CACHE_HOME/.claude/plugins/cache/mk/canon/9.9.9/mcp-server/boot.sh"
OUT="$(run_payload "$CACHE_HOME" "$EMPTY" "" "" "")"
if [[ "$OUT" == *"STUB_BOOTED:cache"* ]]; then
  pass "plugin-cache fallback resolves newest install"
else
  fail "cache fallback: got [$OUT]"
fi

# Test 5 — truly nothing: MUST fail loud (CANON FATAL) and exit non-zero. No silent collapse.
OUT="$(run_payload /tmp/canon-no-home-xyz "$EMPTY" "" "" "")"
if [[ "$OUT" == *"CANON FATAL"* && "$OUT" == *"EXIT:1"* ]]; then
  pass "fails loud when boot.sh truly unlocatable (no -32000 silent collapse)"
else
  fail "loud-fail: got [$OUT]"
fi

echo "----"
echo "mcp-json-resolver: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
