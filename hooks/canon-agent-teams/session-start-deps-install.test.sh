#!/usr/bin/env bash
# session-start-deps-install.test.sh — behavioral tests for the SessionStart deps install hook.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/session-start-deps-install.sh"
PASS=0
FAIL=0

pass() { echo "PASS: $1"; ((PASS++)); }
fail() { echo "FAIL: $1"; ((FAIL++)); }

# ---------------------------------------------------------------------------
# Test 1: shellcheck passes
# ---------------------------------------------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck "$HOOK" >/dev/null 2>&1; then
    pass "shellcheck session-start-deps-install.sh"
  else
    fail "shellcheck session-start-deps-install.sh"
    shellcheck "$HOOK" || true
  fi
else
  echo "SKIP: shellcheck not installed"
fi

# ---------------------------------------------------------------------------
# Test 2: Differing/absent $DATA/package.json triggers install branch
# Stub npm with a fake that touches a marker and exits 0.
# ---------------------------------------------------------------------------
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MCP_PKG="$REPO_ROOT/mcp-server/package.json"

if [[ -f "$MCP_PKG" ]]; then
  TMPDATA=$(mktemp -d)
  # Create fake npm stub
  FAKE_BIN=$(mktemp -d)
  cat > "$FAKE_BIN/npm" <<'NPMSTUB'
#!/usr/bin/env bash
# Fake npm stub for testing
touch "$CANON_TEST_MARKER"
exit 0
NPMSTUB
  chmod +x "$FAKE_BIN/npm"

  MARKER=$(mktemp)
  rm -f "$MARKER"  # We want to test if it gets created

  # Run hook with DATA dir that has no package.json (triggers install)
  CANON_TEST_MARKER="$MARKER" \
    CLAUDE_PLUGIN_ROOT="$REPO_ROOT" \
    CLAUDE_PLUGIN_DATA="$TMPDATA" \
    PATH="$FAKE_BIN:$PATH" \
    bash "$HOOK"
  EXIT_CODE=$?

  if [[ $EXIT_CODE -eq 0 ]] && [[ -f "$MARKER" ]] && [[ -f "$TMPDATA/package.json" ]]; then
    pass "Install branch triggered when DATA/package.json absent; hook exits 0"
  else
    fail "Install branch test: exit=$EXIT_CODE, marker=${MARKER} exists=$(test -f "$MARKER" && echo yes || echo no), pkg_copied=$(test -f "$TMPDATA/package.json" && echo yes || echo no)"
  fi
  rm -f "$MARKER"
  rm -rf "$TMPDATA" "$FAKE_BIN"
else
  echo "SKIP: mcp-server/package.json not found (test 2)"
fi

# ---------------------------------------------------------------------------
# Test 3: Matching manifest skips the install branch (npm NOT called)
# ---------------------------------------------------------------------------
if [[ -f "$MCP_PKG" ]]; then
  TMPDATA=$(mktemp -d)
  FAKE_BIN=$(mktemp -d)
  cat > "$FAKE_BIN/npm" <<'NPMSTUB'
#!/usr/bin/env bash
touch "$CANON_TEST_MARKER"
exit 0
NPMSTUB
  chmod +x "$FAKE_BIN/npm"

  # Pre-copy matching package.json to DATA
  cp "$MCP_PKG" "$TMPDATA/package.json"
  MARKER=$(mktemp)
  rm -f "$MARKER"

  CANON_TEST_MARKER="$MARKER" \
    CLAUDE_PLUGIN_ROOT="$REPO_ROOT" \
    CLAUDE_PLUGIN_DATA="$TMPDATA" \
    PATH="$FAKE_BIN:$PATH" \
    bash "$HOOK"
  EXIT_CODE=$?

  if [[ $EXIT_CODE -eq 0 ]] && [[ ! -f "$MARKER" ]]; then
    pass "Matching manifests: install branch skipped, hook exits 0"
  else
    fail "Matching manifests: exit=$EXIT_CODE, npm called=$(test -f "$MARKER" && echo yes || echo no)"
  fi
  rm -f "$MARKER"
  rm -rf "$TMPDATA" "$FAKE_BIN"
else
  echo "SKIP: mcp-server/package.json not found (test 3)"
fi

# ---------------------------------------------------------------------------
# Test 4: npm failure → removes stored manifest + hook exits 0 (retry guarantee)
# ---------------------------------------------------------------------------
if [[ -f "$MCP_PKG" ]]; then
  TMPDATA=$(mktemp -d)
  FAKE_BIN=$(mktemp -d)
  cat > "$FAKE_BIN/npm" <<'NPMSTUB'
#!/usr/bin/env bash
# Simulate npm failure
exit 1
NPMSTUB
  chmod +x "$FAKE_BIN/npm"

  CLAUDE_PLUGIN_ROOT="$REPO_ROOT" \
    CLAUDE_PLUGIN_DATA="$TMPDATA" \
    PATH="$FAKE_BIN:$PATH" \
    bash "$HOOK"
  EXIT_CODE=$?

  if [[ $EXIT_CODE -eq 0 ]] && [[ ! -f "$TMPDATA/package.json" ]]; then
    pass "npm failure: manifest removed (retry guarantee), hook exits 0"
  else
    fail "npm failure: exit=$EXIT_CODE, pkg.json exists=$(test -f "$TMPDATA/package.json" && echo yes || echo no)"
  fi
  rm -rf "$TMPDATA" "$FAKE_BIN"
else
  echo "SKIP: mcp-server/package.json not found (test 4)"
fi

# ---------------------------------------------------------------------------
# Test 5: CLAUDE_PLUGIN_DATA unset → hook exits 0 with dev note (no npm call)
# ---------------------------------------------------------------------------
FAKE_BIN=$(mktemp -d)
MARKER=$(mktemp)
rm -f "$MARKER"
cat > "$FAKE_BIN/npm" <<NPMSTUB
#!/usr/bin/env bash
touch "$MARKER"
exit 0
NPMSTUB
chmod +x "$FAKE_BIN/npm"

OUTPUT=$(CLAUDE_PLUGIN_DATA="" \
  CLAUDE_PLUGIN_ROOT="" \
  CANON_TEST_MARKER="$MARKER" \
  PATH="$FAKE_BIN:$PATH" \
  bash "$HOOK" 2>&1)
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]] && [[ ! -f "$MARKER" ]]; then
  pass "PLUGIN_DATA unset: hook exits 0, no npm call"
else
  fail "PLUGIN_DATA unset: exit=$EXIT_CODE, npm called=$(test -f "$MARKER" && echo yes || echo no)"
fi
rm -f "$MARKER"
rm -rf "$FAKE_BIN"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
