#!/usr/bin/env bash
# Tests for tool-loop-detector.sh.
# Exercises: non-loop calls, 2-identical, 3-identical (loop), mixed calls,
# no session_id, fingerprint format, state file cleanup, different output breaks streak.

set -euo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/tool-loop-detector.sh"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

# Unique session_id for this test run to avoid cross-test state pollution
TEST_SESSION="test-session-$(date +%s)-$$"

# Helper: clean state file before each test
clean_state() {
  rm -f "${TMPDIR:-/tmp}/canon-tool-fingerprints-${TEST_SESSION}"
}

# Helper: build a minimal PostToolUse JSON payload
make_payload() {
  local tool="${1:-Bash}"
  local cmd="${2:-npm test}"
  local session="${3:-$TEST_SESSION}"
  printf '{"session_id":"%s","tool_name":"%s","tool_use_id":"use-abc","tool_input":{"command":"%s"},"tool_result":{"output":"ok"}}' \
    "$session" "$tool" "$cmd"
}

# Helper: run the hook with CANON_AGENT_TEAMS_MODE=on
run_hook() {
  CANON_AGENT_TEAMS_MODE=on bash "$HOOK" <<<"$1"
}

# ──────────────────────────────────────────────────────────────────────────────
# Test 1: Non-looping calls (3 different tool calls) → all exit 0
# ──────────────────────────────────────────────────────────────────────────────
clean_state
run_hook "$(make_payload "Bash" "npm test")" \
  || fail "test1: first different call should exit 0"
run_hook "$(make_payload "Bash" "npm run build")" \
  || fail "test1: second different call should exit 0"
run_hook "$(make_payload "Read" "/src/index.ts")" \
  || fail "test1: third different call should exit 0"
pass "non-looping calls exit 0"

# ──────────────────────────────────────────────────────────────────────────────
# Test 2: 2 identical calls → exit 0 (no loop yet)
# ──────────────────────────────────────────────────────────────────────────────
clean_state
PAYLOAD="$(make_payload "Bash" "git status")"
run_hook "$PAYLOAD" || fail "test2: call 1 should exit 0"
run_hook "$PAYLOAD" || fail "test2: call 2 should exit 0"
pass "2 identical calls exit 0 (no loop yet)"

# ──────────────────────────────────────────────────────────────────────────────
# Test 3: 3 identical calls → exit 2 (loop detected)
# ──────────────────────────────────────────────────────────────────────────────
clean_state
PAYLOAD="$(make_payload "Bash" "git status --porcelain")"
run_hook "$PAYLOAD" || fail "test3: call 1 should exit 0"
run_hook "$PAYLOAD" || fail "test3: call 2 should exit 0"
EXIT_CODE=0
CANON_AGENT_TEAMS_MODE=on bash "$HOOK" <<<"$PAYLOAD" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 2 ]]; then
  fail "test3: 3rd identical call should exit 2, got $EXIT_CODE"
fi
pass "3 identical calls exit 2 (loop detected)"

# ──────────────────────────────────────────────────────────────────────────────
# Test 4: Mixed calls reset streak — A A B A A A should detect on 3rd A
# ──────────────────────────────────────────────────────────────────────────────
clean_state
A="$(make_payload "Bash" "ls -la")"
B="$(make_payload "Bash" "pwd")"
run_hook "$A" || fail "test4: A1 should exit 0"
run_hook "$A" || fail "test4: A2 should exit 0"
run_hook "$B" || fail "test4: B should exit 0"
run_hook "$A" || fail "test4: A3 should exit 0 (streak reset by B)"
run_hook "$A" || fail "test4: A4 should exit 0"
EXIT_CODE=0
CANON_AGENT_TEAMS_MODE=on bash "$HOOK" <<<"$A" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 2 ]]; then
  fail "test4: 3rd consecutive A should exit 2, got $EXIT_CODE"
fi
pass "mixed calls reset streak; 3 consecutive A after B triggers exit 2"

# ──────────────────────────────────────────────────────────────────────────────
# Test 5: No session_id → exit 0 (cannot scope state)
# ──────────────────────────────────────────────────────────────────────────────
PAYLOAD_NO_SESSION='{"tool_name":"Bash","tool_use_id":"use-123","tool_input":{"command":"npm test"}}'
CANON_AGENT_TEAMS_MODE=on bash "$HOOK" <<<"$PAYLOAD_NO_SESSION" \
  || fail "test5: no session_id should exit 0"
CANON_AGENT_TEAMS_MODE=on bash "$HOOK" <<<"$PAYLOAD_NO_SESSION" \
  || fail "test5: no session_id call 2 should exit 0"
CANON_AGENT_TEAMS_MODE=on bash "$HOOK" <<<"$PAYLOAD_NO_SESSION" \
  || fail "test5: no session_id call 3 should exit 0"
pass "no session_id exits 0 (cannot scope state)"

# ──────────────────────────────────────────────────────────────────────────────
# Test 6: Fingerprint uses SHA-256 and is exactly 16 hex chars
# ──────────────────────────────────────────────────────────────────────────────
SESSION_6="test-fp-${RANDOM}"
clean_state
PAYLOAD_6="$(make_payload "Bash" "cat /etc/hosts" "$SESSION_6")"
CANON_AGENT_TEAMS_MODE=on bash "$HOOK" <<<"$PAYLOAD_6" || true
STATE_FILE="${TMPDIR:-/tmp}/canon-tool-fingerprints-${SESSION_6}"
if [[ ! -f "$STATE_FILE" ]]; then
  fail "test6: state file not created"
fi
FINGERPRINT=$(cat "$STATE_FILE")
if ! echo "$FINGERPRINT" | grep -qE '^[0-9a-f]{16}$'; then
  fail "test6: fingerprint should be 16 hex chars, got: '$FINGERPRINT'"
fi
rm -f "$STATE_FILE"
pass "fingerprint is 16-char hex (SHA-256 prefix)"

# ──────────────────────────────────────────────────────────────────────────────
# Test 7: State file deleted after detection (reset on loop)
# ──────────────────────────────────────────────────────────────────────────────
SESSION_7="test-cleanup-${RANDOM}"
PAYLOAD_7="$(make_payload "Edit" "/some/file.ts" "$SESSION_7")"
CANON_AGENT_TEAMS_MODE=on bash "$HOOK" <<<"$PAYLOAD_7" || true
CANON_AGENT_TEAMS_MODE=on bash "$HOOK" <<<"$PAYLOAD_7" || true
EXIT_CODE=0
CANON_AGENT_TEAMS_MODE=on bash "$HOOK" <<<"$PAYLOAD_7" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 2 ]]; then
  fail "test7: 3rd identical call should exit 2 (setup)"
fi
STATE_FILE="${TMPDIR:-/tmp}/canon-tool-fingerprints-${SESSION_7}"
if [[ -f "$STATE_FILE" ]]; then
  fail "test7: state file should be deleted after loop detection"
fi
pass "state file cleaned up after detection"

# ──────────────────────────────────────────────────────────────────────────────
# Test 8: Different tool_output breaks streak
# (same tool + input but different tool_result.output → different fingerprint → no loop)
# ──────────────────────────────────────────────────────────────────────────────
SESSION_8="test-output-${RANDOM}"
# Three payloads: same tool + input, different tool_result output each time
P8A=$(printf '{"session_id":"%s","tool_name":"Bash","tool_use_id":"u1","tool_input":{"command":"npm test"},"tool_result":{"output":"PASS"}}' "$SESSION_8")
P8B=$(printf '{"session_id":"%s","tool_name":"Bash","tool_use_id":"u2","tool_input":{"command":"npm test"},"tool_result":{"output":"FAIL"}}' "$SESSION_8")
P8C=$(printf '{"session_id":"%s","tool_name":"Bash","tool_use_id":"u3","tool_input":{"command":"npm test"},"tool_result":{"output":"ERROR"}}' "$SESSION_8")
CANON_AGENT_TEAMS_MODE=on bash "$HOOK" <<<"$P8A" || true
CANON_AGENT_TEAMS_MODE=on bash "$HOOK" <<<"$P8B" || true
EXIT_CODE=0
CANON_AGENT_TEAMS_MODE=on bash "$HOOK" <<<"$P8C" || EXIT_CODE=$?
# Different outputs produce different fingerprints → streak is broken → exit 0
if [[ "$EXIT_CODE" -ne 0 ]]; then
  fail "test8: different tool_output should break streak (exit 0), got exit $EXIT_CODE"
fi
rm -f "${TMPDIR:-/tmp}/canon-tool-fingerprints-${SESSION_8}"
pass "different tool_output breaks streak (fingerprints differ)"

echo "tool-loop-detector.sh: all tests passed"
