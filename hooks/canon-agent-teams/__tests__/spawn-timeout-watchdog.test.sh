#!/usr/bin/env bash
# Tests for spawn-timeout-watchdog.sh.
# Exercises: no timestamp file, under threshold, over threshold, custom env,
# custom config.json, HITL message includes agent identity, interval dedup,
# dedup expiry.

set -euo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/spawn-timeout-watchdog.sh"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

# Helper: create a temp .canon dir with optional spawn-start-ts
make_canon_dir() {
  local dir
  dir=$(mktemp -d)
  mkdir -p "${dir}/.canon"
  echo "$dir"
}

# Helper: run hook with CANON_AGENT_TEAMS_MODE=on, CANON_PROJECT_DIR set
run_hook() {
  local dir="$1"
  shift
  CANON_AGENT_TEAMS_MODE=on CANON_PROJECT_DIR="$dir" "$@" bash "$HOOK" \
    <'{"tool_name":"Bash","tool_input":{"command":"npm test"}}'
}

# Minimal JSON payload
PAYLOAD='{"tool_name":"Bash","tool_input":{"command":"npm test"}}'

# ──────────────────────────────────────────────────────────────────────────────
# Test 1: No spawn timestamp file → exit 0
# ──────────────────────────────────────────────────────────────────────────────
DIR1=$(make_canon_dir)
EXIT_CODE=0
CANON_AGENT_TEAMS_MODE=on CANON_PROJECT_DIR="$DIR1" bash "$HOOK" <<<"$PAYLOAD" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 0 ]]; then
  fail "test1: no spawn-start-ts should exit 0, got $EXIT_CODE"
fi
rm -rf "$DIR1"
pass "no spawn timestamp file exits 0"

# ──────────────────────────────────────────────────────────────────────────────
# Test 2: Spawn under threshold (1 minute ago, threshold 20) → exit 0
# ──────────────────────────────────────────────────────────────────────────────
DIR2=$(make_canon_dir)
echo "$(( $(date +%s) - 60 ))" > "${DIR2}/.canon/.spawn-start-ts"
EXIT_CODE=0
CANON_AGENT_TEAMS_MODE=on CANON_PROJECT_DIR="$DIR2" bash "$HOOK" <<<"$PAYLOAD" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 0 ]]; then
  fail "test2: spawn under threshold should exit 0, got $EXIT_CODE"
fi
rm -rf "$DIR2"
pass "spawn under threshold exits 0"

# ──────────────────────────────────────────────────────────────────────────────
# Test 3: Spawn over threshold (25 minutes ago, default threshold 20) → exit 2
# ──────────────────────────────────────────────────────────────────────────────
DIR3=$(make_canon_dir)
echo "$(( $(date +%s) - 1500 ))" > "${DIR3}/.canon/.spawn-start-ts"
EXIT_CODE=0
CANON_AGENT_TEAMS_MODE=on CANON_PROJECT_DIR="$DIR3" bash "$HOOK" <<<"$PAYLOAD" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 2 ]]; then
  fail "test3: spawn over threshold should exit 2, got $EXIT_CODE"
fi
rm -rf "$DIR3"
pass "spawn over threshold exits 2"

# ──────────────────────────────────────────────────────────────────────────────
# Test 4: Custom threshold via CANON_SPAWN_TIMEOUT_MINUTES env var
# (5 minute threshold, 6 minutes elapsed → exit 2)
# ──────────────────────────────────────────────────────────────────────────────
DIR4=$(make_canon_dir)
echo "$(( $(date +%s) - 360 ))" > "${DIR4}/.canon/.spawn-start-ts"
EXIT_CODE=0
CANON_AGENT_TEAMS_MODE=on CANON_PROJECT_DIR="$DIR4" CANON_SPAWN_TIMEOUT_MINUTES=5 bash "$HOOK" <<<"$PAYLOAD" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 2 ]]; then
  fail "test4: custom env threshold (5m), 6m elapsed should exit 2, got $EXIT_CODE"
fi
rm -rf "$DIR4"
pass "custom threshold via env var respected"

# ──────────────────────────────────────────────────────────────────────────────
# Test 5: Custom threshold via config.json (5 minutes, 6 minutes elapsed → exit 2)
# ──────────────────────────────────────────────────────────────────────────────
DIR5=$(make_canon_dir)
echo "$(( $(date +%s) - 360 ))" > "${DIR5}/.canon/.spawn-start-ts"
printf '{"spawn_timeout_minutes": 5}' > "${DIR5}/.canon/config.json"
EXIT_CODE=0
CANON_AGENT_TEAMS_MODE=on CANON_PROJECT_DIR="$DIR5" bash "$HOOK" <<<"$PAYLOAD" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 2 ]]; then
  fail "test5: config.json threshold (5m), 6m elapsed should exit 2, got $EXIT_CODE"
fi
rm -rf "$DIR5"
pass "custom threshold via config.json respected"

# ──────────────────────────────────────────────────────────────────────────────
# Test 6: HITL message includes agent identity (CANON_AGENT_TYPE, CANON_STEP_ID)
# ──────────────────────────────────────────────────────────────────────────────
DIR6=$(make_canon_dir)
echo "$(( $(date +%s) - 1500 ))" > "${DIR6}/.canon/.spawn-start-ts"
OUTPUT=$(CANON_AGENT_TEAMS_MODE=on CANON_PROJECT_DIR="$DIR6" \
  CANON_AGENT_TYPE="reviewer" CANON_STEP_ID="review-pass-2" \
  bash "$HOOK" <<<"$PAYLOAD" 2>&1 || true)
if ! echo "$OUTPUT" | grep -q "reviewer"; then
  fail "test6: HITL message should include agent type 'reviewer', output: $OUTPUT"
fi
if ! echo "$OUTPUT" | grep -q "review-pass-2"; then
  fail "test6: HITL message should include step ID 'review-pass-2', output: $OUTPUT"
fi
rm -rf "$DIR6"
pass "HITL message includes agent identity"

# ──────────────────────────────────────────────────────────────────────────────
# Test 7: Interval-aware dedup — second call within threshold interval → exit 0
# ──────────────────────────────────────────────────────────────────────────────
DIR7=$(make_canon_dir)
echo "$(( $(date +%s) - 1500 ))" > "${DIR7}/.canon/.spawn-start-ts"
# First call: should exit 2 and write dedup file
EXIT_CODE=0
CANON_AGENT_TEAMS_MODE=on CANON_PROJECT_DIR="$DIR7" bash "$HOOK" <<<"$PAYLOAD" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 2 ]]; then
  fail "test7: first call over threshold should exit 2, got $EXIT_CODE"
fi
# Dedup file should exist now (written to 'now')
DEDUP="${DIR7}/.canon/.spawn-watchdog-shown"
if [[ ! -f "$DEDUP" ]]; then
  fail "test7: dedup file should be created after first fire"
fi
# Second call immediately after — within dedup interval → exit 0
EXIT_CODE=0
CANON_AGENT_TEAMS_MODE=on CANON_PROJECT_DIR="$DIR7" bash "$HOOK" <<<"$PAYLOAD" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 0 ]]; then
  fail "test7: second call within dedup interval should exit 0, got $EXIT_CODE"
fi
rm -rf "$DIR7"
pass "interval-aware dedup suppresses second fire"

# ──────────────────────────────────────────────────────────────────────────────
# Test 8: Dedup expires after threshold interval → fires again (exit 2)
# ──────────────────────────────────────────────────────────────────────────────
DIR8=$(make_canon_dir)
# Spawn started 40 minutes ago (2400 seconds)
echo "$(( $(date +%s) - 2400 ))" > "${DIR8}/.canon/.spawn-start-ts"
# Dedup file shows it last fired 25 minutes ago (> threshold of 20 min)
echo "$(( $(date +%s) - 1500 ))" > "${DIR8}/.canon/.spawn-watchdog-shown"
EXIT_CODE=0
CANON_AGENT_TEAMS_MODE=on CANON_PROJECT_DIR="$DIR8" bash "$HOOK" <<<"$PAYLOAD" || EXIT_CODE=$?
if [[ "$EXIT_CODE" -ne 2 ]]; then
  fail "test8: dedup expired (25m ago, threshold 20m) should re-fire exit 2, got $EXIT_CODE"
fi
rm -rf "$DIR8"
pass "dedup expires after threshold interval — re-fires"

echo "spawn-timeout-watchdog.sh: all tests passed"
