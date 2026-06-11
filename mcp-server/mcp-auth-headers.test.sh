#!/usr/bin/env bash
# mcp-auth-headers.test.sh — behavioral tests for the headersHelper token-injection script.
#
# Tests inject CANON_MCP_TOKEN_FILE (or a temp HOME/CLAUDE_PLUGIN_DATA) to stay hermetic.
# All three resolveTokenPath tiers are covered, plus fail-closed / no-leak paths.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER="$SCRIPT_DIR/mcp-auth-headers.sh"
PASS=0
FAIL=0

pass() { echo "PASS: $1"; (( PASS++ )); }
fail() { echo "FAIL: $1"; (( FAIL++ )); }

# ---------------------------------------------------------------------------
# Test 1: shellcheck passes
# ---------------------------------------------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck "$HELPER" >/dev/null 2>&1; then
    pass "shellcheck mcp-auth-headers.sh"
  else
    fail "shellcheck mcp-auth-headers.sh"
    shellcheck "$HELPER" || true # DOCUMENTED FAIL-OPEN -- shellcheck output already emitted above; we continue to gather all failures
  fi
else
  echo "SKIP: shellcheck not installed"
fi

# ---------------------------------------------------------------------------
# Test 2: CANON_MCP_TOKEN_FILE tier — valid token file → correct JSON, exit 0
# ---------------------------------------------------------------------------
TMPDIR2=$(mktemp -d)
TOKEN_FILE2="$TMPDIR2/token"
echo "abc123def456" > "$TOKEN_FILE2"

STDOUT2=$(CANON_MCP_TOKEN_FILE="$TOKEN_FILE2" bash "$HELPER" 2>/dev/null)
EXIT2=$?
EXPECTED2='{"Authorization":"Bearer abc123def456"}'

if [[ $EXIT2 -eq 0 ]] && [[ "$STDOUT2" == "$EXPECTED2" ]]; then
  pass "CANON_MCP_TOKEN_FILE tier: valid token emits correct JSON, exit 0"
else
  fail "CANON_MCP_TOKEN_FILE tier: exit=$EXIT2, stdout='$STDOUT2', expected='$EXPECTED2'"
fi
rm -rf "$TMPDIR2"

# ---------------------------------------------------------------------------
# Test 3: CLAUDE_PLUGIN_DATA tier — valid token → correct JSON, exit 0
# ---------------------------------------------------------------------------
TMPDIR3=$(mktemp -d)
TOKEN_FILE3="$TMPDIR3/canon-mcp-token"
echo "plugindata_token_xyz" > "$TOKEN_FILE3"

# Unset CANON_MCP_TOKEN_FILE so the second tier is reached
STDOUT3=$(unset CANON_MCP_TOKEN_FILE 2>/dev/null; CLAUDE_PLUGIN_DATA="$TMPDIR3" bash "$HELPER" 2>/dev/null)
EXIT3=$?
EXPECTED3='{"Authorization":"Bearer plugindata_token_xyz"}'

if [[ $EXIT3 -eq 0 ]] && [[ "$STDOUT3" == "$EXPECTED3" ]]; then
  pass "CLAUDE_PLUGIN_DATA tier: valid token emits correct JSON, exit 0"
else
  fail "CLAUDE_PLUGIN_DATA tier: exit=$EXIT3, stdout='$STDOUT3', expected='$EXPECTED3'"
fi
rm -rf "$TMPDIR3"

# ---------------------------------------------------------------------------
# Test 4: HOME fallback tier — valid token → correct JSON, exit 0
# ---------------------------------------------------------------------------
TMPDIR4=$(mktemp -d)
mkdir -p "$TMPDIR4/.claude/canon"
TOKEN_FILE4="$TMPDIR4/.claude/canon/canon-mcp-token"
echo "home_fallback_token" > "$TOKEN_FILE4"

# Unset both overrides; point HOME at temp dir
STDOUT4=$(unset CANON_MCP_TOKEN_FILE 2>/dev/null; unset CLAUDE_PLUGIN_DATA 2>/dev/null; HOME="$TMPDIR4" bash "$HELPER" 2>/dev/null)
EXIT4=$?
EXPECTED4='{"Authorization":"Bearer home_fallback_token"}'

if [[ $EXIT4 -eq 0 ]] && [[ "$STDOUT4" == "$EXPECTED4" ]]; then
  pass "HOME fallback tier: valid token emits correct JSON, exit 0"
else
  fail "HOME fallback tier: exit=$EXIT4, stdout='$STDOUT4', expected='$EXPECTED4'"
fi
rm -rf "$TMPDIR4"

# ---------------------------------------------------------------------------
# Test 5: Absent token file → no stdout, non-zero exit, stderr diagnostic
# ---------------------------------------------------------------------------
TMPDIR5=$(mktemp -d)
ABSENT_FILE="$TMPDIR5/does-not-exist"

STDOUT5=$(CANON_MCP_TOKEN_FILE="$ABSENT_FILE" bash "$HELPER" 2>/dev/null)
EXIT5=$?
STDERR5=$(CANON_MCP_TOKEN_FILE="$ABSENT_FILE" bash "$HELPER" 2>&1 >/dev/null)

if [[ $EXIT5 -ne 0 ]] && [[ -z "$STDOUT5" ]] && [[ -n "$STDERR5" ]]; then
  pass "Absent token file: no stdout, non-zero exit, stderr diagnostic present"
else
  fail "Absent token file: exit=$EXIT5, stdout='$STDOUT5', stderr_present=$([ -n "$STDERR5" ] && echo yes || echo no)"
fi
rm -rf "$TMPDIR5"

# ---------------------------------------------------------------------------
# Test 6: Empty token file → no stdout, non-zero exit
# ---------------------------------------------------------------------------
TMPDIR6=$(mktemp -d)
EMPTY_FILE="$TMPDIR6/empty-token"
touch "$EMPTY_FILE"  # zero bytes

STDOUT6=$(CANON_MCP_TOKEN_FILE="$EMPTY_FILE" bash "$HELPER" 2>/dev/null)
EXIT6=$?

if [[ $EXIT6 -ne 0 ]] && [[ -z "$STDOUT6" ]]; then
  pass "Empty token file: no stdout, non-zero exit"
else
  fail "Empty token file: exit=$EXIT6, stdout='$STDOUT6'"
fi
rm -rf "$TMPDIR6"

# ---------------------------------------------------------------------------
# Test 7: Whitespace-only token file → no stdout, non-zero exit
# ---------------------------------------------------------------------------
TMPDIR7=$(mktemp -d)
WS_FILE="$TMPDIR7/ws-token"
printf '   \n   \n' > "$WS_FILE"

STDOUT7=$(CANON_MCP_TOKEN_FILE="$WS_FILE" bash "$HELPER" 2>/dev/null)
EXIT7=$?

if [[ $EXIT7 -ne 0 ]] && [[ -z "$STDOUT7" ]]; then
  pass "Whitespace-only token file: no stdout, non-zero exit"
else
  fail "Whitespace-only token file: exit=$EXIT7, stdout='$STDOUT7'"
fi
rm -rf "$TMPDIR7"

# ---------------------------------------------------------------------------
# Test 8: Token value does NOT appear in stderr
# ---------------------------------------------------------------------------
TMPDIR8=$(mktemp -d)
TOKEN_FILE8="$TMPDIR8/token"
SECRET_TOKEN="super_secret_token_12345"
echo "$SECRET_TOKEN" > "$TOKEN_FILE8"

STDERR8=$(CANON_MCP_TOKEN_FILE="$TOKEN_FILE8" bash "$HELPER" 2>&1 >/dev/null)

if ! echo "$STDERR8" | grep -qF "$SECRET_TOKEN"; then
  pass "Token not leaked to stderr"
else
  fail "Token leaked to stderr: found '$SECRET_TOKEN' in stderr"
fi
rm -rf "$TMPDIR8"

# ---------------------------------------------------------------------------
# Test 9: Token with leading/trailing whitespace in file → trimmed correctly
# ---------------------------------------------------------------------------
TMPDIR9=$(mktemp -d)
TOKEN_FILE9="$TMPDIR9/token"
printf '  trimmed_token_abc  \n' > "$TOKEN_FILE9"

STDOUT9=$(CANON_MCP_TOKEN_FILE="$TOKEN_FILE9" bash "$HELPER" 2>/dev/null)
EXIT9=$?
EXPECTED9='{"Authorization":"Bearer trimmed_token_abc"}'

if [[ $EXIT9 -eq 0 ]] && [[ "$STDOUT9" == "$EXPECTED9" ]]; then
  pass "Token with whitespace in file: trimmed correctly, correct JSON"
else
  fail "Token with whitespace: exit=$EXIT9, stdout='$STDOUT9', expected='$EXPECTED9'"
fi
rm -rf "$TMPDIR9"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
