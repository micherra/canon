#!/usr/bin/env bash
# session-start-server-guard.test.sh — behavioral tests for the SessionStart server guard hook.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/session-start-server-guard.sh"
PASS=0
FAIL=0

pass() { echo "PASS: $1"; ((PASS++)); }
fail() { echo "FAIL: $1"; ((FAIL++)); }

# ---------------------------------------------------------------------------
# Test 1: shellcheck passes
# ---------------------------------------------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck "$HOOK" >/dev/null 2>&1; then
    pass "shellcheck session-start-server-guard.sh"
  else
    fail "shellcheck session-start-server-guard.sh"
    shellcheck "$HOOK" || true
  fi
else
  echo "SKIP: shellcheck not installed"
fi

# ---------------------------------------------------------------------------
# Test 2: Stale PID (dead process) → PID file removed, no kill attempted
# The hook writes PID file to $PROJECT_DIR/.canon/canon-server.pid when
# CLAUDE_PLUGIN_DATA is unset. Mirror that path in the test.
# ---------------------------------------------------------------------------
TMPDIR_TEST=$(mktemp -d)
mkdir -p "$TMPDIR_TEST/.canon"
# Write a PID that is definitely dead (use a very high PID unlikely to exist)
DEAD_PID=999999
echo "${DEAD_PID}" > "$TMPDIR_TEST/.canon/canon-server.pid"
echo "3141" >> "$TMPDIR_TEST/.canon/canon-server.pid"

CANON_PROJECT_DIR="$TMPDIR_TEST" \
  CLAUDE_PLUGIN_DATA="" \
  bash "$HOOK" 2>&1
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]] && [[ ! -f "$TMPDIR_TEST/.canon/canon-server.pid" ]]; then
  pass "Stale PID (dead process): PID file removed, hook exits 0"
else
  fail "Stale PID: exit=$EXIT_CODE, pid_file_exists=$(test -f "$TMPDIR_TEST/.canon/canon-server.pid" && echo yes || echo no)"
fi
rm -rf "$TMPDIR_TEST"

# ---------------------------------------------------------------------------
# Test 3: PID whose ps cmdline does NOT match Canon → NOT killed
# We stub `ps` to return a cmdline that does not match 'tsx' or 'index.ts'.
# ---------------------------------------------------------------------------
TMPDIR_TEST=$(mktemp -d)
# Use our own PID (it's alive) but the stub `ps` returns a non-matching cmdline
FAKE_BIN=$(mktemp -d)
cat > "$FAKE_BIN/ps" <<'PSSTUB'
#!/usr/bin/env bash
# Return a non-Canon cmdline
echo "/usr/bin/python3 some-other-script.py"
PSSTUB
chmod +x "$FAKE_BIN/ps"

KILL_MARKER="$TMPDIR_TEST/kill_called"
cat > "$FAKE_BIN/kill" <<KILLSTUB
#!/usr/bin/env bash
touch "$KILL_MARKER"
exit 0
KILLSTUB
chmod +x "$FAKE_BIN/kill"

# Write PID file with our own PID (process is alive, but cmdline won't match)
mkdir -p "$TMPDIR_TEST/.canon"
echo "$$" > "$TMPDIR_TEST/.canon/canon-server.pid"
echo "3141" >> "$TMPDIR_TEST/.canon/canon-server.pid"

CANON_PROJECT_DIR="$TMPDIR_TEST" \
  CLAUDE_PLUGIN_DATA="" \
  PATH="$FAKE_BIN:$PATH" \
  bash "$HOOK" 2>&1
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]] && [[ ! -f "$KILL_MARKER" ]]; then
  pass "PID cmdline mismatch: process NOT killed, hook exits 0"
else
  fail "PID cmdline mismatch: exit=$EXIT_CODE, kill_called=$(test -f "$KILL_MARKER" && echo yes || echo no)"
fi
rm -rf "$TMPDIR_TEST" "$FAKE_BIN"

# ---------------------------------------------------------------------------
# Test 4: Health probe failure → WARN printed mentioning /mcp
# ---------------------------------------------------------------------------
# Don't run on 127.0.0.1:3142 at all — stub curl to fail
TMPDIR_TEST=$(mktemp -d)
FAKE_BIN=$(mktemp -d)
cat > "$FAKE_BIN/curl" <<'CURLSTUB'
#!/usr/bin/env bash
# Simulate health probe failure
exit 1
CURLSTUB
chmod +x "$FAKE_BIN/curl"

OUTPUT=$(CANON_PROJECT_DIR="$TMPDIR_TEST" \
  CLAUDE_PLUGIN_DATA="" \
  CANON_GUARD_HEALTH_TIMEOUT=0 \
  PATH="$FAKE_BIN:$PATH" \
  bash "$HOOK" 2>&1)
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]] && echo "$OUTPUT" | grep -q "/mcp"; then
  pass "Health probe failure: WARN printed mentioning /mcp, hook exits 0"
else
  fail "Health probe failure: exit=$EXIT_CODE, output=$(echo "$OUTPUT" | head -3)"
fi
rm -rf "$TMPDIR_TEST" "$FAKE_BIN"

# ---------------------------------------------------------------------------
# Test 5: Hook always exits 0
# ---------------------------------------------------------------------------
TMPDIR_TEST=$(mktemp -d)
CANON_PROJECT_DIR="$TMPDIR_TEST" CLAUDE_PLUGIN_DATA="" bash "$HOOK" >/dev/null 2>&1
EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
  pass "Hook always exits 0 (no PID file, health probe likely fails)"
else
  fail "Hook exits non-zero: $EXIT_CODE"
fi
rm -rf "$TMPDIR_TEST"

# ---------------------------------------------------------------------------
# F2b Test 6: CANON_DAEMON_PORT set → curl probes that port, not the default :3142
# ---------------------------------------------------------------------------
TMPDIR_TEST=$(mktemp -d)
FAKE_BIN=$(mktemp -d)
PROBE_URL_FILE="$TMPDIR_TEST/probe_url"

cat > "$FAKE_BIN/curl" <<CURLSTUB6
#!/usr/bin/env bash
# Record the URL curl was called with
echo "\$*" >> "${PROBE_URL_FILE}"
exit 1  # simulate unhealthy so WARN is emitted
CURLSTUB6
chmod +x "$FAKE_BIN/curl"

OUTPUT=$(CANON_PROJECT_DIR="$TMPDIR_TEST" \
  CLAUDE_PLUGIN_DATA="" \
  CANON_DAEMON_PORT=3142 \
  CANON_GUARD_HEALTH_TIMEOUT=0 \
  PATH="$FAKE_BIN:$PATH" \
  bash "$HOOK" 2>&1)
EXIT_CODE=$?

PROBE_URL=""
if [[ -f "$PROBE_URL_FILE" ]]; then
  PROBE_URL=$(cat "$PROBE_URL_FILE")
fi

if [[ $EXIT_CODE -eq 0 ]] \
   && echo "$PROBE_URL" | grep -q ":3142/health" \
   && ! echo "$PROBE_URL" | grep -q ":3141/health" \
   && echo "$OUTPUT" | grep -q ":3142"; then
  pass "F2b: CANON_DAEMON_PORT=3142 → curl targets :3142 and WARN mentions :3142"
else
  fail "F2b: CANON_DAEMON_PORT=3142: exit=$EXIT_CODE probe_url='${PROBE_URL}' warn_output='$(echo "$OUTPUT" | grep -i warn || echo none)'"
fi
rm -rf "$TMPDIR_TEST" "$FAKE_BIN"

# ---------------------------------------------------------------------------
# F2b Test 7: CANON_DAEMON_PORT unset → curl probes default :3142 (matches supervisor)
# ---------------------------------------------------------------------------
TMPDIR_TEST=$(mktemp -d)
FAKE_BIN=$(mktemp -d)
PROBE_URL_FILE="$TMPDIR_TEST/probe_url"

cat > "$FAKE_BIN/curl" <<CURLSTUB7
#!/usr/bin/env bash
echo "\$*" >> "${PROBE_URL_FILE}"
exit 1
CURLSTUB7
chmod +x "$FAKE_BIN/curl"

OUTPUT=$(CANON_PROJECT_DIR="$TMPDIR_TEST" \
  CLAUDE_PLUGIN_DATA="" \
  CANON_GUARD_HEALTH_TIMEOUT=0 \
  PATH="$FAKE_BIN:$PATH" \
  bash "$HOOK" 2>&1)
EXIT_CODE=$?

PROBE_URL=""
if [[ -f "$PROBE_URL_FILE" ]]; then
  PROBE_URL=$(cat "$PROBE_URL_FILE")
fi

if [[ $EXIT_CODE -eq 0 ]] \
   && echo "$PROBE_URL" | grep -q ":3142/health" \
   && echo "$OUTPUT" | grep -q ":3142"; then
  pass "F2b: CANON_DAEMON_PORT unset → curl targets default :3142 (matches supervisor) and WARN mentions :3142"
else
  fail "F2b: CANON_DAEMON_PORT unset: exit=$EXIT_CODE probe_url='${PROBE_URL}' warn_output='$(echo "$OUTPUT" | grep -i warn || echo none)'"
fi
rm -rf "$TMPDIR_TEST" "$FAKE_BIN"

# ---------------------------------------------------------------------------
# Test 8: down-then-up — curl fails the first two probes then succeeds within
# the budget → NO WARN (false-positive eliminated, AC #4).
# ---------------------------------------------------------------------------
TMPDIR_TEST=$(mktemp -d)
FAKE_BIN=$(mktemp -d)
CALL_COUNT_FILE="$TMPDIR_TEST/call_count"
echo 0 > "$CALL_COUNT_FILE"
cat > "$FAKE_BIN/curl" <<CURLSTUB8
#!/usr/bin/env bash
COUNT=\$(cat "$CALL_COUNT_FILE")
COUNT=\$((COUNT + 1))
echo "\$COUNT" > "$CALL_COUNT_FILE"
if [[ "\$COUNT" -lt 3 ]]; then
  exit 1
fi
exit 0
CURLSTUB8
chmod +x "$FAKE_BIN/curl"

OUTPUT=$(CANON_PROJECT_DIR="$TMPDIR_TEST" \
  CLAUDE_PLUGIN_DATA="" \
  CANON_GUARD_HEALTH_TIMEOUT=5 \
  PATH="$FAKE_BIN:$PATH" \
  bash "$HOOK" 2>&1)
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]] && ! echo "$OUTPUT" | grep -q "CANON WARN"; then
  pass "Down-then-up within budget: no WARN, hook exits 0 (AC #4)"
else
  fail "Down-then-up within budget: exit=$EXIT_CODE output=$(echo "$OUTPUT" | head -3)"
fi
rm -rf "$TMPDIR_TEST" "$FAKE_BIN"

# ---------------------------------------------------------------------------
# Test 9: genuine-down — curl fails through the whole budget → WARN still
# fires exactly once, exit 0 (AC #6, no false-negative).
# ---------------------------------------------------------------------------
TMPDIR_TEST=$(mktemp -d)
FAKE_BIN=$(mktemp -d)
cat > "$FAKE_BIN/curl" <<'CURLSTUB9'
#!/usr/bin/env bash
exit 1
CURLSTUB9
chmod +x "$FAKE_BIN/curl"

OUTPUT=$(CANON_PROJECT_DIR="$TMPDIR_TEST" \
  CLAUDE_PLUGIN_DATA="" \
  CANON_GUARD_HEALTH_TIMEOUT=1 \
  PATH="$FAKE_BIN:$PATH" \
  bash "$HOOK" 2>&1)
EXIT_CODE=$?
WARN_COUNT=$(echo "$OUTPUT" | grep -c "CANON WARN")

if [[ $EXIT_CODE -eq 0 ]] && [[ "$WARN_COUNT" -eq 1 ]]; then
  pass "Genuine down through full budget: WARN fires exactly once, hook exits 0 (AC #6)"
else
  fail "Genuine down: exit=$EXIT_CODE warn_count=$WARN_COUNT output=$(echo "$OUTPUT" | head -5)"
fi
rm -rf "$TMPDIR_TEST" "$FAKE_BIN"

# ---------------------------------------------------------------------------
# Test 10: corrected remediation text — mentions /mcp, does NOT mention stdio
# (AC #5).
# ---------------------------------------------------------------------------
TMPDIR_TEST=$(mktemp -d)
FAKE_BIN=$(mktemp -d)
cat > "$FAKE_BIN/curl" <<'CURLSTUB10'
#!/usr/bin/env bash
exit 1
CURLSTUB10
chmod +x "$FAKE_BIN/curl"

OUTPUT=$(CANON_PROJECT_DIR="$TMPDIR_TEST" \
  CLAUDE_PLUGIN_DATA="" \
  CANON_GUARD_HEALTH_TIMEOUT=0 \
  PATH="$FAKE_BIN:$PATH" \
  bash "$HOOK" 2>&1)

if echo "$OUTPUT" | grep -q "/mcp" && ! echo "$OUTPUT" | grep -qi "stdio"; then
  pass "Remediation text: mentions /mcp, does not mention stdio (AC #5)"
else
  fail "Remediation text: output=$(echo "$OUTPUT" | head -3)"
fi
rm -rf "$TMPDIR_TEST" "$FAKE_BIN"

# ---------------------------------------------------------------------------
# Test 11: budget=0 → exactly one immediate probe, no sleeps (fast path).
# ---------------------------------------------------------------------------
TMPDIR_TEST=$(mktemp -d)
FAKE_BIN=$(mktemp -d)
CALL_COUNT_FILE="$TMPDIR_TEST/call_count"
cat > "$FAKE_BIN/curl" <<CURLSTUB11
#!/usr/bin/env bash
COUNT=\$(cat "$CALL_COUNT_FILE" 2>/dev/null || echo 0)
COUNT=\$((COUNT + 1))
echo "\$COUNT" > "$CALL_COUNT_FILE"
exit 1
CURLSTUB11
chmod +x "$FAKE_BIN/curl"

CANON_PROJECT_DIR="$TMPDIR_TEST" \
  CLAUDE_PLUGIN_DATA="" \
  CANON_GUARD_HEALTH_TIMEOUT=0 \
  PATH="$FAKE_BIN:$PATH" \
  bash "$HOOK" >/dev/null 2>&1

CALL_COUNT=$(cat "$CALL_COUNT_FILE" 2>/dev/null || echo -1)
if [[ "$CALL_COUNT" -eq 1 ]]; then
  pass "Budget=0: exactly one immediate probe, no sleeps"
else
  fail "Budget=0: expected 1 curl call, got $CALL_COUNT"
fi
rm -rf "$TMPDIR_TEST" "$FAKE_BIN"

# ---------------------------------------------------------------------------
# Test 12: injection/non-numeric CANON_GUARD_HEALTH_TIMEOUT coerces to the
# default (8) — no arithmetic-context command substitution, no hang.
# ---------------------------------------------------------------------------
TMPDIR_TEST=$(mktemp -d)
FAKE_BIN=$(mktemp -d)
INJECTION_MARKER="$TMPDIR_TEST/should_not_exist"
cat > "$FAKE_BIN/curl" <<'CURLSTUB12'
#!/usr/bin/env bash
exit 1
CURLSTUB12
chmod +x "$FAKE_BIN/curl"

OUTPUT=$(timeout 15 env CANON_PROJECT_DIR="$TMPDIR_TEST" \
  CLAUDE_PLUGIN_DATA="" \
  CANON_GUARD_HEALTH_TIMEOUT="x[\$(touch ${INJECTION_MARKER})]" \
  PATH="$FAKE_BIN:$PATH" \
  bash "$HOOK" 2>&1)
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]] && [[ ! -f "$INJECTION_MARKER" ]] && echo "$OUTPUT" | grep -q "budget 8s"; then
  pass "Injection/non-numeric CANON_GUARD_HEALTH_TIMEOUT coerces to default 8, no substitution executed"
else
  fail "Injection guard: exit=$EXIT_CODE marker_exists=$(test -f "$INJECTION_MARKER" && echo yes || echo no) output=$(echo "$OUTPUT" | head -3)"
fi
rm -rf "$TMPDIR_TEST" "$FAKE_BIN"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
