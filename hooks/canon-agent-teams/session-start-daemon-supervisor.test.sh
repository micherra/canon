#!/usr/bin/env bash
# session-start-daemon-supervisor.test.sh — behavioral tests for the daemon supervisor hook.
#
# Tests inject environment overrides to avoid hitting the real tsx daemon:
#   CANON_HTTP_DAEMON   — flag gate (default 0)
#   CLAUDE_PLUGIN_DATA  — data directory (use temp dirs)
#   CANON_DAEMON_PORT   — port to probe (use a port we control in tests)
#   CANON_SUPERVISOR_START_TIMEOUT — seconds to wait for daemon start
#   CANON_SUPERVISOR_BOOT_CMD — command run to start the daemon (override for tests)
#   CLAUDE_PLUGIN_ROOT  — root for package.json resolution
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/session-start-daemon-supervisor.sh"
PASS=0
FAIL=0

pass() { echo "PASS: $1"; (( PASS++ )); }
fail() { echo "FAIL: $1"; (( FAIL++ )); }

# ---------------------------------------------------------------------------
# Test 1: shellcheck passes
# ---------------------------------------------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck "$HOOK" >/dev/null 2>&1; then
    pass "shellcheck session-start-daemon-supervisor.sh"
  else
    fail "shellcheck session-start-daemon-supervisor.sh"
    shellcheck "$HOOK" || true # DOCUMENTED FAIL-OPEN -- shellcheck output already emitted above; we continue to gather all failures
  fi
else
  echo "SKIP: shellcheck not installed"
fi

# ---------------------------------------------------------------------------
# Test 2: Flag off (CANON_HTTP_DAEMON unset) → instant exit 0, no side effects
# ---------------------------------------------------------------------------
TMPDATA=$(mktemp -d)
MARKER="$TMPDATA/boot_called"

OUTPUT=$(CANON_HTTP_DAEMON=0 \
  CLAUDE_PLUGIN_DATA="$TMPDATA" \
  CANON_SUPERVISOR_BOOT_CMD="touch $MARKER" \
  bash "$HOOK" 2>&1)
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]] && [[ ! -f "$MARKER" ]]; then
  pass "Flag off: instant exit 0, boot not called"
else
  fail "Flag off: exit=$EXIT_CODE, boot_called=$(test -f "$MARKER" && echo yes || echo no), output=$OUTPUT"
fi
rm -rf "$TMPDATA"

# ---------------------------------------------------------------------------
# Test 3: No daemon listening → boot cmd called, exit 0
# Uses CANON_SUPERVISOR_BOOT_CMD to inject a touch marker rather than a real
# daemon — tests that the start path is reached and exits 0. We do NOT poll
# a real daemon here because polling on a non-listening port will timeout;
# instead we set TIMEOUT=1 to let the poll fail quickly after boot is called.
# ---------------------------------------------------------------------------
TMPDATA=$(mktemp -d)
TMPROOT=$(mktemp -d)
mkdir -p "$TMPROOT/mcp-server"
echo '{"name":"canon-mcp","version":"1.0.0-test"}' > "$TMPROOT/mcp-server/package.json"

BOOT_MARKER3a="$TMPDATA/boot_called3a"

OUTPUT=$(CANON_HTTP_DAEMON=1 \
  CLAUDE_PLUGIN_DATA="$TMPDATA" \
  CLAUDE_PLUGIN_ROOT="$TMPROOT" \
  CANON_DAEMON_PORT=19997 \
  CANON_SUPERVISOR_BOOT_CMD="touch $BOOT_MARKER3a" \
  CANON_SUPERVISOR_START_TIMEOUT=1 \
  bash "$HOOK" 2>&1)
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]] && [[ -f "$BOOT_MARKER3a" ]]; then
  pass "No daemon listening: start path triggered, boot cmd called, exit 0"
else
  fail "No daemon listening: exit=$EXIT_CODE, boot_called=$(test -f "$BOOT_MARKER3a" && echo yes || echo no), output=$(echo "$OUTPUT" | head -5)"
fi
rm -rf "$TMPDATA" "$TMPROOT"

# ---------------------------------------------------------------------------
# Test 4: Healthy same-version daemon → no restart attempted
# ---------------------------------------------------------------------------
TMPDATA=$(mktemp -d)
TMPROOT=$(mktemp -d)
mkdir -p "$TMPROOT/mcp-server"
echo '{"name":"canon-mcp","version":"2.0.0-test"}' > "$TMPROOT/mcp-server/package.json"

# Start a real health server for this test
FREE_PORT2=$(python3 -c "
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
")

python3 -c "
import http.server, json

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            body = json.dumps({'ok': True, 'port': ${FREE_PORT2}, 'version': '2.0.0-test', 'transport': 'http'}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(body)
    def log_message(self, *a): pass

http.server.HTTPServer(('127.0.0.1', ${FREE_PORT2}), H).serve_forever()
" &
FAKE_SERVER_PID=$!
disown "$FAKE_SERVER_PID" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- disown prevents bash job-tracking; cleanup via explicit kill below
sleep 0.5  # Give server time to start

BOOT_MARKER="$TMPDATA/boot_called"
OUTPUT=$(CANON_HTTP_DAEMON=1 \
  CLAUDE_PLUGIN_DATA="$TMPDATA" \
  CLAUDE_PLUGIN_ROOT="$TMPROOT" \
  CANON_DAEMON_PORT="$FREE_PORT2" \
  CANON_SUPERVISOR_BOOT_CMD="touch $BOOT_MARKER" \
  CANON_SUPERVISOR_START_TIMEOUT=5 \
  bash "$HOOK" 2>&1)
EXIT_CODE=$?

kill "$FAKE_SERVER_PID" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- cleanup only; process may have already exited

if [[ $EXIT_CODE -eq 0 ]] && [[ ! -f "$BOOT_MARKER" ]]; then
  pass "Healthy same-version: no restart attempted, exit 0"
else
  fail "Healthy same-version: exit=$EXIT_CODE, boot_called=$(test -f "$BOOT_MARKER" && echo yes || echo no), output=$(echo "$OUTPUT" | head -3)"
fi
rm -rf "$TMPDATA" "$TMPROOT"

# ---------------------------------------------------------------------------
# Test 5: Version mismatch + matching cmdline PID → TERM sent, restart attempted
# ---------------------------------------------------------------------------
TMPDATA=$(mktemp -d)
TMPROOT=$(mktemp -d)
mkdir -p "$TMPROOT/mcp-server"
echo '{"name":"canon-mcp","version":"3.0.0-new"}' > "$TMPROOT/mcp-server/package.json"

# Start a health server returning OLD version
FREE_PORT3=$(python3 -c "
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
")

python3 -c "
import http.server, json

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            body = json.dumps({'ok': True, 'port': ${FREE_PORT3}, 'version': '2.9.9-old', 'transport': 'http'}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(body)
    def log_message(self, *a): pass

http.server.HTTPServer(('127.0.0.1', ${FREE_PORT3}), H).serve_forever()
" &
FAKE_SERVER_PID3=$!
disown "$FAKE_SERVER_PID3" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- disown prevents bash job-tracking; cleanup via explicit kill below
sleep 0.5

# Write a PID file pointing to a REAL background process that passes identity check.
# We use a long-running sleep as the "daemon" — ps stub returns tsx+daemon.ts for it.
# We MUST use a real PID because kill is a shell builtin and ignores PATH stubs.
# The supervisor will send SIGTERM to this process; it's harmless (just a sleep).
sleep 999 &
FAKE_DAEMON_PID=$!
disown "$FAKE_DAEMON_PID" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- disown prevents bash job-tracking
echo "$FAKE_DAEMON_PID" > "$TMPDATA/canon-daemon.pid"

FAKE_BIN=$(mktemp -d)
cat > "$FAKE_BIN/ps" <<'PSSTUB'
#!/usr/bin/env bash
# Return a cmdline matching tsx + daemon.ts for any PID
echo "node tsx src/app/daemon.ts"
PSSTUB
chmod +x "$FAKE_BIN/ps"

BOOT_MARKER3="$TMPDATA/boot_called3"
OUTPUT3=$(CANON_HTTP_DAEMON=1 \
  CLAUDE_PLUGIN_DATA="$TMPDATA" \
  CLAUDE_PLUGIN_ROOT="$TMPROOT" \
  CANON_DAEMON_PORT="$FREE_PORT3" \
  CANON_SUPERVISOR_BOOT_CMD="touch $BOOT_MARKER3" \
  CANON_SUPERVISOR_START_TIMEOUT=3 \
  PATH="$FAKE_BIN:$PATH" \
  bash "$HOOK" 2>&1)
EXIT_CODE3=$?

# Verify: the fake daemon process was killed (TERM sent by supervisor)
if kill -0 "$FAKE_DAEMON_PID" 2>/dev/null; then
  DAEMON_KILLED=no
  kill "$FAKE_DAEMON_PID" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- cleanup only
else
  DAEMON_KILLED=yes
fi

kill "$FAKE_SERVER_PID3" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- cleanup only

if [[ $EXIT_CODE3 -eq 0 ]] && [[ "$DAEMON_KILLED" == "yes" ]]; then
  pass "Version mismatch + matching cmdline: TERM sent, restart attempted, exit 0"
else
  fail "Version mismatch: exit=$EXIT_CODE3, daemon_killed=${DAEMON_KILLED}, output=$(echo "$OUTPUT3" | head -5)"
fi
rm -rf "$TMPDATA" "$TMPROOT" "$FAKE_BIN"

# ---------------------------------------------------------------------------
# Test 6: PID alive but cmdline NOT a daemon → never killed (identity guard)
# ---------------------------------------------------------------------------
TMPDATA=$(mktemp -d)
TMPROOT=$(mktemp -d)
mkdir -p "$TMPROOT/mcp-server"
echo '{"name":"canon-mcp","version":"4.0.0-new"}' > "$TMPROOT/mcp-server/package.json"

# Start a health server returning OLD version
FREE_PORT4=$(python3 -c "
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
")

python3 -c "
import http.server, json

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            body = json.dumps({'ok': True, 'port': ${FREE_PORT4}, 'version': '3.9.9-old', 'transport': 'http'}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(body)
    def log_message(self, *a): pass

http.server.HTTPServer(('127.0.0.1', ${FREE_PORT4}), H).serve_forever()
" &
FAKE_SERVER_PID4=$!
disown "$FAKE_SERVER_PID4" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- disown prevents bash job-tracking; cleanup via explicit kill below
sleep 0.5

# Use a real alive process as the PID — supervisor will check its cmdline
# via ps (stubbed to return non-daemon). Since kill is a builtin, we cannot
# stub it; instead, we verify the process is still alive after supervisor runs.
sleep 999 &
FAKE_NONDAEMON_PID=$!
disown "$FAKE_NONDAEMON_PID" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- disown prevents bash job-tracking
echo "$FAKE_NONDAEMON_PID" > "$TMPDATA/canon-daemon.pid"

FAKE_BIN4=$(mktemp -d)
cat > "$FAKE_BIN4/ps" <<'PSSTUB'
#!/usr/bin/env bash
# Return NON-daemon cmdline — should NOT be killed
echo "/usr/bin/python3 some-other-process.py"
PSSTUB
chmod +x "$FAKE_BIN4/ps"

OUTPUT4=$(CANON_HTTP_DAEMON=1 \
  CLAUDE_PLUGIN_DATA="$TMPDATA" \
  CLAUDE_PLUGIN_ROOT="$TMPROOT" \
  CANON_DAEMON_PORT="$FREE_PORT4" \
  CANON_SUPERVISOR_BOOT_CMD="echo boot-would-run" \
  CANON_SUPERVISOR_START_TIMEOUT=3 \
  PATH="$FAKE_BIN4:$PATH" \
  bash "$HOOK" 2>&1)
EXIT_CODE4=$?

kill "$FAKE_SERVER_PID4" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- cleanup only

# Verify process survived (supervisor did NOT kill it — identity guard worked)
if kill -0 "$FAKE_NONDAEMON_PID" 2>/dev/null; then
  SURVIVED=yes
else
  SURVIVED=no
fi
kill "$FAKE_NONDAEMON_PID" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- cleanup only

if [[ $EXIT_CODE4 -eq 0 ]] && [[ "$SURVIVED" == "yes" ]]; then
  pass "Identity guard: non-daemon PID NOT killed, exit 0"
else
  fail "Identity guard: exit=$EXIT_CODE4, survived=${SURVIVED}, output=$(echo "$OUTPUT4" | head -5)"
fi
rm -rf "$TMPDATA" "$TMPROOT" "$FAKE_BIN4"

# ---------------------------------------------------------------------------
# Test 7: Concurrent invocation (lock dir held, fresh) → second exits 0, no start
# ---------------------------------------------------------------------------
TMPDATA=$(mktemp -d)
TMPROOT=$(mktemp -d)
mkdir -p "$TMPROOT/mcp-server"
echo '{"name":"canon-mcp","version":"5.0.0-test"}' > "$TMPROOT/mcp-server/package.json"

# Hold the lock directory manually (simulate another session starting the daemon)
LOCK_DIR="$TMPDATA/canon-daemon.lock"
mkdir "$LOCK_DIR"

BOOT_MARKER7="$TMPDATA/boot_called7"
OUTPUT7=$(CANON_HTTP_DAEMON=1 \
  CLAUDE_PLUGIN_DATA="$TMPDATA" \
  CLAUDE_PLUGIN_ROOT="$TMPROOT" \
  CANON_DAEMON_PORT=19999 \
  CANON_SUPERVISOR_BOOT_CMD="touch $BOOT_MARKER7" \
  CANON_SUPERVISOR_START_TIMEOUT=3 \
  bash "$HOOK" 2>&1)
EXIT_CODE7=$?

rmdir "$LOCK_DIR" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- cleanup only; may have been removed by hook

if [[ $EXIT_CODE7 -eq 0 ]] && [[ ! -f "$BOOT_MARKER7" ]]; then
  pass "Concurrent invocation (fresh lock): exits 0, no start"
else
  fail "Concurrent invocation: exit=$EXIT_CODE7, boot_called=$(test -f "$BOOT_MARKER7" && echo yes || echo no), output=$(echo "$OUTPUT7" | head -3)"
fi
rm -rf "$TMPDATA" "$TMPROOT"

# ---------------------------------------------------------------------------
# Test 8: Stale lock (>60s) → reclaimed, start path runs
# ---------------------------------------------------------------------------
TMPDATA=$(mktemp -d)
TMPROOT=$(mktemp -d)
mkdir -p "$TMPROOT/mcp-server"
echo '{"name":"canon-mcp","version":"6.0.0-test"}' > "$TMPROOT/mcp-server/package.json"

# Create a stale lock — set mtime to 120s ago
LOCK_DIR8="$TMPDATA/canon-daemon.lock"
mkdir "$LOCK_DIR8"
# Set the modification time to 120 seconds in the past
touch -d "$(date -v-120S '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date --date='120 seconds ago' '+%Y-%m-%d %H:%M:%S')" "$LOCK_DIR8" 2>/dev/null || \
  python3 -c "
import os, time
path = '$LOCK_DIR8'
old = time.time() - 120
os.utime(path, (old, old))
"

BOOT_MARKER8="$TMPDATA/boot_called8"
OUTPUT8=$(CANON_HTTP_DAEMON=1 \
  CLAUDE_PLUGIN_DATA="$TMPDATA" \
  CLAUDE_PLUGIN_ROOT="$TMPROOT" \
  CANON_DAEMON_PORT=19998 \
  CANON_SUPERVISOR_BOOT_CMD="touch $BOOT_MARKER8" \
  CANON_SUPERVISOR_START_TIMEOUT=3 \
  bash "$HOOK" 2>&1)
EXIT_CODE8=$?

# The stale lock should have been reclaimed (rmdir) and boot called
if [[ $EXIT_CODE8 -eq 0 ]] && [[ -f "$BOOT_MARKER8" ]]; then
  pass "Stale lock (>60s): reclaimed, start path ran, exit 0"
else
  fail "Stale lock: exit=$EXIT_CODE8, boot_called=$(test -f "$BOOT_MARKER8" && echo yes || echo no), output=$(echo "$OUTPUT8" | head -5)"
fi
rm -rf "$TMPDATA" "$TMPROOT"

# ---------------------------------------------------------------------------
# Test 9: Post-start poll version mismatch (old daemon survived) → WARNING, not success
#
# Simulates the case where the old daemon was not killed (survived) and the new
# start command was issued, but the health poll returns the OLD version instead
# of the expected new version. The supervisor must report a WARNING rather than
# falsely claiming "started successfully".
# ---------------------------------------------------------------------------
TMPDATA=$(mktemp -d)
TMPROOT=$(mktemp -d)
mkdir -p "$TMPROOT/mcp-server"
# Plugin expects NEW version 9.0.0-new
echo '{"name":"canon-mcp","version":"9.0.0-new"}' > "$TMPROOT/mcp-server/package.json"

# Start a fake health server returning OLD version (simulates stale daemon that survived)
FREE_PORT9=$(python3 -c "
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
")

python3 -c "
import http.server, json

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            body = json.dumps({'ok': True, 'port': ${FREE_PORT9}, 'version': '8.9.9-old', 'transport': 'http'}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(body)
    def log_message(self, *a): pass

http.server.HTTPServer(('127.0.0.1', ${FREE_PORT9}), H).serve_forever()
" &
FAKE_SERVER_PID9=$!
disown "$FAKE_SERVER_PID9" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- disown prevents bash job-tracking; cleanup via explicit kill below
sleep 0.5

# No PID file → supervisor goes through start path, issues boot cmd, then polls
BOOT_MARKER9="$TMPDATA/boot_called9"
OUTPUT9=$(CANON_HTTP_DAEMON=1 \
  CLAUDE_PLUGIN_DATA="$TMPDATA" \
  CLAUDE_PLUGIN_ROOT="$TMPROOT" \
  CANON_DAEMON_PORT="$FREE_PORT9" \
  CANON_SUPERVISOR_BOOT_CMD="touch $BOOT_MARKER9" \
  CANON_SUPERVISOR_START_TIMEOUT=3 \
  bash "$HOOK" 2>&1)
EXIT_CODE9=$?

kill "$FAKE_SERVER_PID9" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- cleanup only

# Boot was called (start path was entered), exit 0 (advisory hook never fails)
# Output must contain WARNING about old daemon surviving, NOT "started successfully"
BOOT_WAS_CALLED=no
[[ -f "$BOOT_MARKER9" ]] && BOOT_WAS_CALLED=yes

WARNED_OLD_DAEMON=no
if echo "$OUTPUT9" | grep -q "old daemon may have survived"; then
  WARNED_OLD_DAEMON=yes
fi

FALSELY_REPORTED_SUCCESS=no
if echo "$OUTPUT9" | grep -q "started successfully"; then
  FALSELY_REPORTED_SUCCESS=yes
fi

if [[ $EXIT_CODE9 -eq 0 ]] && [[ "$BOOT_WAS_CALLED" == "yes" ]] && [[ "$WARNED_OLD_DAEMON" == "yes" ]] && [[ "$FALSELY_REPORTED_SUCCESS" == "no" ]]; then
  pass "Post-start poll version mismatch: WARNING emitted, 'started successfully' NOT printed, exit 0"
else
  fail "Post-start poll mismatch: exit=$EXIT_CODE9, boot_called=${BOOT_WAS_CALLED}, warned_old=${WARNED_OLD_DAEMON}, false_success=${FALSELY_REPORTED_SUCCESS}, output=$(echo "$OUTPUT9" | head -8)"
fi
rm -rf "$TMPDATA" "$TMPROOT"

# ---------------------------------------------------------------------------
# Test 10: CANON_HTTP_DAEMON=1, no-op boot cmd, short timeout, unused port →
# LOUD recovery block emitted, exit 0
#
# This is the critical risk-mitigation test: when the daemon cannot be reached
# after the supervisor's best-effort start attempt (poll timeout reached), the
# hook must print a LOUD actionable error — not a quiet warning.
# ---------------------------------------------------------------------------
TMPDATA=$(mktemp -d)
TMPROOT=$(mktemp -d)
mkdir -p "$TMPROOT/mcp-server"
echo '{"name":"canon-mcp","version":"10.0.0-test"}' > "$TMPROOT/mcp-server/package.json"

# Find an unused port via python3 (daemon will never start on it)
FREE_PORT10=$(python3 -c "
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
")

# Use ':' (no-op shell builtin) as the boot command — it exits immediately
# without starting any daemon. The health poll will time out.
OUTPUT10=$(CANON_HTTP_DAEMON=1 \
  CLAUDE_PLUGIN_DATA="$TMPDATA" \
  CLAUDE_PLUGIN_ROOT="$TMPROOT" \
  CANON_DAEMON_PORT="$FREE_PORT10" \
  CANON_SUPERVISOR_BOOT_CMD=":" \
  CANON_SUPERVISOR_START_TIMEOUT=1 \
  bash "$HOOK" 2>&1)
EXIT_CODE10=$?

# Assert: exit 0 (advisory hook never blocks session startup)
EXIT_OK10=no
[[ $EXIT_CODE10 -eq 0 ]] && EXIT_OK10=yes

# Assert: output contains the loud recovery markers
CONTAINS_FAIL_MSG10=no
CONTAINS_BOOTSH10=no
CONTAINS_KILLSWITCH10=no
echo "$OUTPUT10" | grep -q "tools will FAIL" && CONTAINS_FAIL_MSG10=yes
echo "$OUTPUT10" | grep -q "boot.sh --daemon" && CONTAINS_BOOTSH10=yes
echo "$OUTPUT10" | grep -q "unset CANON_HTTP_DAEMON" && CONTAINS_KILLSWITCH10=yes

if [[ "$EXIT_OK10" == "yes" ]] && [[ "$CONTAINS_FAIL_MSG10" == "yes" ]] && \
   [[ "$CONTAINS_BOOTSH10" == "yes" ]] && [[ "$CONTAINS_KILLSWITCH10" == "yes" ]]; then
  pass "Daemon unreachable after start attempt: LOUD recovery block emitted, exit 0"
else
  fail "Daemon unreachable after start attempt: exit=${EXIT_CODE10}, fail_msg=${CONTAINS_FAIL_MSG10}, boot_sh=${CONTAINS_BOOTSH10}, killswitch=${CONTAINS_KILLSWITCH10}, output=$(echo "$OUTPUT10" | head -10)"
fi
rm -rf "$TMPDATA" "$TMPROOT"

# ---------------------------------------------------------------------------
# Test 11a: CANON_HTTP_DAEMON=0 (flag off) → recovery block NOT printed
# ---------------------------------------------------------------------------
TMPDATA=$(mktemp -d)
TMPROOT=$(mktemp -d)
mkdir -p "$TMPROOT/mcp-server"
echo '{"name":"canon-mcp","version":"11.0.0-test"}' > "$TMPROOT/mcp-server/package.json"

FREE_PORT11=$(python3 -c "
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
")

OUTPUT11=$(CANON_HTTP_DAEMON=0 \
  CLAUDE_PLUGIN_DATA="$TMPDATA" \
  CLAUDE_PLUGIN_ROOT="$TMPROOT" \
  CANON_DAEMON_PORT="$FREE_PORT11" \
  CANON_SUPERVISOR_BOOT_CMD=":" \
  CANON_SUPERVISOR_START_TIMEOUT=1 \
  bash "$HOOK" 2>&1)
EXIT_CODE11=$?

RECOVERY_BLOCK_PRINTED11=no
echo "$OUTPUT11" | grep -q "tools will FAIL" && RECOVERY_BLOCK_PRINTED11=yes

if [[ $EXIT_CODE11 -eq 0 ]] && [[ "$RECOVERY_BLOCK_PRINTED11" == "no" ]]; then
  pass "Flag off (CANON_HTTP_DAEMON=0): recovery block NOT printed, exit 0"
else
  fail "Flag off: exit=${EXIT_CODE11}, recovery_block_printed=${RECOVERY_BLOCK_PRINTED11}, output=$(echo "$OUTPUT11" | head -5)"
fi
rm -rf "$TMPDATA" "$TMPROOT"

# ---------------------------------------------------------------------------
# Test 11b: CANON_HTTP_DAEMON=1, healthy daemon → recovery block NOT printed
# ---------------------------------------------------------------------------
TMPDATA=$(mktemp -d)
TMPROOT=$(mktemp -d)
mkdir -p "$TMPROOT/mcp-server"
echo '{"name":"canon-mcp","version":"11b.0.0-test"}' > "$TMPROOT/mcp-server/package.json"

FREE_PORT11B=$(python3 -c "
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
")

# Start a healthy daemon mock
python3 -c "
import http.server, json

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            body = json.dumps({'ok': True, 'port': ${FREE_PORT11B}, 'version': '11b.0.0-test', 'transport': 'http'}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(body)
    def log_message(self, *a): pass

http.server.HTTPServer(('127.0.0.1', ${FREE_PORT11B}), H).serve_forever()
" &
FAKE_SERVER_PID11B=$!
disown "$FAKE_SERVER_PID11B" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- disown prevents bash job-tracking; cleanup via explicit kill below
sleep 0.5

BOOT_MARKER11B="$TMPDATA/boot_called11b"
OUTPUT11B=$(CANON_HTTP_DAEMON=1 \
  CLAUDE_PLUGIN_DATA="$TMPDATA" \
  CLAUDE_PLUGIN_ROOT="$TMPROOT" \
  CANON_DAEMON_PORT="$FREE_PORT11B" \
  CANON_SUPERVISOR_BOOT_CMD="touch $BOOT_MARKER11B" \
  CANON_SUPERVISOR_START_TIMEOUT=3 \
  bash "$HOOK" 2>&1)
EXIT_CODE11B=$?

kill "$FAKE_SERVER_PID11B" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- cleanup only; process may have already exited

RECOVERY_BLOCK_PRINTED11B=no
echo "$OUTPUT11B" | grep -q "tools will FAIL" && RECOVERY_BLOCK_PRINTED11B=yes

if [[ $EXIT_CODE11B -eq 0 ]] && [[ "$RECOVERY_BLOCK_PRINTED11B" == "no" ]]; then
  pass "Healthy daemon (same version): recovery block NOT printed, exit 0"
else
  fail "Healthy daemon: exit=${EXIT_CODE11B}, recovery_block_printed=${RECOVERY_BLOCK_PRINTED11B}, output=$(echo "$OUTPUT11B" | head -5)"
fi
rm -rf "$TMPDATA" "$TMPROOT"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
