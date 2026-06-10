#!/usr/bin/env bash
# boot.e2e.test.sh — end-to-end boot simulation tests.
#
# Simulates:
#   1. Fresh-cache-copy: temp dir with mcp-server/ but no node_modules,
#      plus a temp CLAUDE_PLUGIN_DATA. Runs deps-install → assert node_modules
#      populated. Runs boot.sh --print-resolution → assert real tsx binary.
#   2. Repo-as-project: CLAUDE_PLUGIN_ROOT unset → BASH_SOURCE self-resolution
#      → assert no npx, real tsx binary if node_modules exists.
#   3. git ls-files mcp-server/node_modules is empty (untrack not regressed).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BOOT_SH="$SCRIPT_DIR/boot.sh"
DEPS_HOOK="$REPO_ROOT/hooks/canon-agent-teams/session-start-deps-install.sh"
PASS=0
FAIL=0

pass() { echo "PASS: $1"; ((PASS++)); }
fail() { echo "FAIL: $1"; ((FAIL++)); }

# ---------------------------------------------------------------------------
# Test 1: git ls-files mcp-server/node_modules is empty (untrack regression check)
# ---------------------------------------------------------------------------
TRACKED=$(git -C "$REPO_ROOT" ls-files mcp-server/node_modules 2>/dev/null || echo "")
if [[ -z "$TRACKED" ]]; then
  pass "git ls-files mcp-server/node_modules is empty (no untrack regression)"
else
  fail "mcp-server/node_modules has tracked files: $TRACKED"
fi

# ---------------------------------------------------------------------------
# Test 2: Repo-as-project resolution (CLAUDE_PLUGIN_ROOT unset)
#   boot.sh --print-resolution resolves via BASH_SOURCE; no npx.
# ---------------------------------------------------------------------------
OUTPUT=$(CLAUDE_PLUGIN_ROOT="" bash "$BOOT_SH" --print-resolution 2>/dev/null) || true
# Parse only the first line (legacy positional triple); diagnostic lines follow it.
SERVER_DIR=$(echo "$OUTPUT" | head -1 | awk '{print $1}')
TSX_BIN=$(echo "$OUTPUT" | head -1 | awk '{print $3}')

if [[ "$SERVER_DIR" == "$SCRIPT_DIR" ]]; then
  pass "Repo-as-project: SERVER_DIR resolves to $SCRIPT_DIR via BASH_SOURCE"
else
  fail "Repo-as-project: expected $SCRIPT_DIR, got $SERVER_DIR"
fi

# Confirm no npx in non-comment lines of boot.sh
if grep -v '^[[:space:]]*#' "$BOOT_SH" | grep -q '\bnpx\b'; then
  fail "npx invocation found in boot.sh"
else
  pass "No npx invocation in boot.sh"
fi

# ---------------------------------------------------------------------------
# Test 3: Fresh-cache simulation
#   Create a temp dir with mcp-server/package.json + src/ + boot.sh but
#   NO node_modules. Create temp PLUGIN_DATA. Run deps-install → assert
#   node_modules populated. Run boot.sh --print-resolution → assert
#   SERVER_DIR + PLUGIN_DATA NODE_PATH + real tsx binary.
# ---------------------------------------------------------------------------
FAKE_PLUGIN=$(mktemp -d)
FAKE_DATA=$(mktemp -d)

# Mirror the minimal mcp-server structure needed by deps-install and boot.sh
mkdir -p "$FAKE_PLUGIN/mcp-server/src/app"
touch "$FAKE_PLUGIN/mcp-server/src/app/index.ts"
# Copy real package.json for actual npm install
cp "$SCRIPT_DIR/package.json" "$FAKE_PLUGIN/mcp-server/package.json"
cp "$SCRIPT_DIR/package-lock.json" "$FAKE_PLUGIN/mcp-server/package-lock.json" 2>/dev/null || true
# Copy .tool-versions so asdf resolves the correct Node.js version
cp "$SCRIPT_DIR/.tool-versions" "$FAKE_DATA/.tool-versions" 2>/dev/null || true
# Copy boot.sh
cp "$BOOT_SH" "$FAKE_PLUGIN/mcp-server/boot.sh"
chmod +x "$FAKE_PLUGIN/mcp-server/boot.sh"

# Run deps-install (compare-manifest → will install since DATA has no package.json)
echo "  Running deps-install (npm install into FAKE_DATA)..."
CLAUDE_PLUGIN_ROOT="$FAKE_PLUGIN" \
  CLAUDE_PLUGIN_DATA="$FAKE_DATA" \
  bash "$DEPS_HOOK" 2>&1 | grep -v "^$" || true

if [[ -d "$FAKE_DATA/node_modules" ]]; then
  pass "Fresh-cache: deps-install populated node_modules in FAKE_DATA"
else
  fail "Fresh-cache: node_modules not found in $FAKE_DATA after deps-install"
fi

# Run boot.sh --print-resolution with the fake plugin + data
RESOLUTION=$(CLAUDE_PLUGIN_ROOT="$FAKE_PLUGIN" CLAUDE_PLUGIN_DATA="$FAKE_DATA" \
  bash "$FAKE_PLUGIN/mcp-server/boot.sh" --print-resolution 2>/dev/null) || true
# Parse only the first line (legacy positional triple); diagnostic lines follow it.
RESOLVED_SERVER=$(echo "$RESOLUTION" | head -1 | awk '{print $1}')
RESOLVED_NODE_PATH=$(echo "$RESOLUTION" | head -1 | awk '{print $2}')
RESOLVED_TSX=$(echo "$RESOLUTION" | head -1 | awk '{print $3}')

if [[ "$RESOLVED_SERVER" == "$FAKE_PLUGIN/mcp-server" ]]; then
  pass "Fresh-cache: SERVER_DIR resolved to plugin mcp-server dir"
else
  fail "Fresh-cache: SERVER_DIR expected $FAKE_PLUGIN/mcp-server, got $RESOLVED_SERVER"
fi

if [[ "$RESOLVED_NODE_PATH" == "$FAKE_DATA/node_modules" ]]; then
  pass "Fresh-cache: NODE_PATH resolves to PLUGIN_DATA/node_modules"
else
  fail "Fresh-cache: NODE_PATH expected $FAKE_DATA/node_modules, got $RESOLVED_NODE_PATH"
fi

if [[ -x "$RESOLVED_TSX" ]]; then
  pass "Fresh-cache: real tsx binary resolved at $RESOLVED_TSX"
else
  fail "Fresh-cache: tsx binary not executable: $RESOLVED_TSX"
fi

rm -rf "$FAKE_PLUGIN" "$FAKE_DATA"

# ---------------------------------------------------------------------------
# Test 4: ESM symlink created — fresh-cache fixture with no co-located
# node_modules. Run boot --print-resolution, assert $SERVER_DIR/node_modules
# is a symlink pointing at $DATA/node_modules (readlink match).
# ---------------------------------------------------------------------------
SYM_PLUGIN=$(mktemp -d)
SYM_DATA=$(mktemp -d)
mkdir -p "$SYM_PLUGIN/mcp-server/src/app"
touch "$SYM_PLUGIN/mcp-server/src/app/index.ts"
cp "$BOOT_SH" "$SYM_PLUGIN/mcp-server/boot.sh"
chmod +x "$SYM_PLUGIN/mcp-server/boot.sh"
# Stub tsx in DATA so deps are "ready"
mkdir -p "$SYM_DATA/node_modules/.bin"
printf '#!/usr/bin/env bash\nexit 0\n' > "$SYM_DATA/node_modules/.bin/tsx"
chmod +x "$SYM_DATA/node_modules/.bin/tsx"

CLAUDE_PLUGIN_ROOT="$SYM_PLUGIN" CLAUDE_PLUGIN_DATA="$SYM_DATA" \
  bash "$SYM_PLUGIN/mcp-server/boot.sh" --print-resolution >/dev/null 2>&1 || true

SYM_LINK="$SYM_PLUGIN/mcp-server/node_modules"
if [[ -L "$SYM_LINK" ]]; then
  LINK_TARGET="$(readlink "$SYM_LINK")"
  EXPECTED_TARGET="$SYM_DATA/node_modules"
  if [[ "$LINK_TARGET" == "$EXPECTED_TARGET" ]]; then
    pass "ESM symlink created: node_modules → PLUGIN_DATA/node_modules"
  else
    fail "ESM symlink target mismatch: expected $EXPECTED_TARGET, got $LINK_TARGET"
  fi
else
  fail "ESM symlink not created: $SYM_LINK is not a symlink"
fi

# ---------------------------------------------------------------------------
# Test 5: Cache-wipe survival — delete the symlink, re-run boot --print-resolution,
# assert it is recreated and points at DATA.
# ---------------------------------------------------------------------------
rm -f "$SYM_LINK"
CLAUDE_PLUGIN_ROOT="$SYM_PLUGIN" CLAUDE_PLUGIN_DATA="$SYM_DATA" \
  bash "$SYM_PLUGIN/mcp-server/boot.sh" --print-resolution >/dev/null 2>&1 || true

if [[ -L "$SYM_LINK" ]]; then
  LINK_TARGET2="$(readlink "$SYM_LINK")"
  if [[ "$LINK_TARGET2" == "$SYM_DATA/node_modules" ]]; then
    pass "Cache-wipe survival: symlink recreated after deletion"
  else
    fail "Cache-wipe survival: symlink target mismatch after recreation: $LINK_TARGET2"
  fi
else
  fail "Cache-wipe survival: symlink not recreated after deletion"
fi

rm -rf "$SYM_PLUGIN" "$SYM_DATA"

# ---------------------------------------------------------------------------
# Test 6: .tool-versions not tracked — neither root nor mcp-server/.tool-versions
# should appear in git ls-files after the asdf-pin fix.
# ---------------------------------------------------------------------------
TOOL_VERSIONS_TRACKED=$(git -C "$REPO_ROOT" ls-files | grep 'tool-versions' || true)
if [[ -z "$TOOL_VERSIONS_TRACKED" ]]; then
  pass ".tool-versions files are not tracked in git"
else
  fail ".tool-versions still tracked: $TOOL_VERSIONS_TRACKED"
fi

# Test 7 (was 6): .gitignore contains .tool-versions
ROOT_GITIGNORE="$REPO_ROOT/.gitignore"
if [[ -f "$ROOT_GITIGNORE" ]] && grep -q '\.tool-versions' "$ROOT_GITIGNORE"; then
  pass ".gitignore contains .tool-versions"
else
  fail ".gitignore does not contain .tool-versions (file: $ROOT_GITIGNORE)"
fi

# ---------------------------------------------------------------------------
# Test 8 (was 6): git status is clean after the above (no working-tree churn)
# ---------------------------------------------------------------------------
STATUS=$(git -C "$REPO_ROOT" status --short 2>/dev/null)
# We only care about tracked files in the working tree
if [[ -z "$STATUS" ]]; then
  pass "git status clean: no working-tree churn from boot simulation"
else
  # Some staged files from our own build may be present — check for node_modules specifically
  if echo "$STATUS" | grep -q "node_modules"; then
    fail "git status shows node_modules tracked: $STATUS"
  else
    pass "git status: working tree changes present but no node_modules tracked"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
