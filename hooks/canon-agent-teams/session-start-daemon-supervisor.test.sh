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
# F2c Test 12: Healthy same-version daemon, PID file has WRONG port → port reconciled
#
# Scenario: daemon is healthy at CANON_DAEMON_PORT, but canon-daemon.pid records a
# different (stale) port. After the healthy+same-version branch runs, the PID file's
# port line must be updated to the live port. PID line must be unchanged.
# ---------------------------------------------------------------------------
TMPDATA=$(mktemp -d)
TMPROOT=$(mktemp -d)
mkdir -p "$TMPROOT/mcp-server"
echo '{"name":"canon-mcp","version":"12.0.0-test"}' > "$TMPROOT/mcp-server/package.json"

FREE_PORT12=$(python3 -c "
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
            body = json.dumps({'ok': True, 'port': ${FREE_PORT12}, 'version': '12.0.0-test', 'transport': 'http'}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(body)
    def log_message(self, *a): pass

http.server.HTTPServer(('127.0.0.1', ${FREE_PORT12}), H).serve_forever()
" &
FAKE_SERVER_PID12=$!
disown "$FAKE_SERVER_PID12" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- disown prevents bash job-tracking; cleanup via explicit kill below
sleep 0.5

# Write a PID file with the LIVE pid but a STALE port (9999 instead of $FREE_PORT12)
FAKE_PID12=99999
echo "${FAKE_PID12}" > "$TMPDATA/canon-daemon.pid"
echo "9999" >> "$TMPDATA/canon-daemon.pid"

BOOT_MARKER12="$TMPDATA/boot_called12"
OUTPUT12=$(CANON_HTTP_DAEMON=1 \
  CLAUDE_PLUGIN_DATA="$TMPDATA" \
  CLAUDE_PLUGIN_ROOT="$TMPROOT" \
  CANON_DAEMON_PORT="$FREE_PORT12" \
  CANON_SUPERVISOR_BOOT_CMD="touch $BOOT_MARKER12" \
  CANON_SUPERVISOR_START_TIMEOUT=3 \
  bash "$HOOK" 2>&1)
EXIT_CODE12=$?

kill "$FAKE_SERVER_PID12" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- cleanup only

# Read the updated PID file
PID_LINE12=""
PORT_LINE12=""
if [[ -f "$TMPDATA/canon-daemon.pid" ]]; then
  PID_LINE12=$(sed -n '1p' "$TMPDATA/canon-daemon.pid")
  PORT_LINE12=$(sed -n '2p' "$TMPDATA/canon-daemon.pid")
fi

if [[ $EXIT_CODE12 -eq 0 ]] \
   && [[ ! -f "$BOOT_MARKER12" ]] \
   && [[ "$PID_LINE12" == "${FAKE_PID12}" ]] \
   && [[ "$PORT_LINE12" == "${FREE_PORT12}" ]]; then
  pass "F2c: Port reconciled in PID file (stale 9999 → live ${FREE_PORT12}), PID unchanged, no restart"
else
  fail "F2c: exit=$EXIT_CODE12, boot_called=$(test -f "$BOOT_MARKER12" && echo yes || echo no), pid_line='${PID_LINE12}', port_line='${PORT_LINE12}' (expected pid=${FAKE_PID12} port=${FREE_PORT12}), output=$(echo "$OUTPUT12" | head -5)"
fi
rm -rf "$TMPDATA" "$TMPROOT"

# ---------------------------------------------------------------------------
# F2c Test 13: Healthy same-version daemon, PID file has CORRECT port → no change
# ---------------------------------------------------------------------------
TMPDATA=$(mktemp -d)
TMPROOT=$(mktemp -d)
mkdir -p "$TMPROOT/mcp-server"
echo '{"name":"canon-mcp","version":"13.0.0-test"}' > "$TMPROOT/mcp-server/package.json"

FREE_PORT13=$(python3 -c "
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
            body = json.dumps({'ok': True, 'port': ${FREE_PORT13}, 'version': '13.0.0-test', 'transport': 'http'}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(body)
    def log_message(self, *a): pass

http.server.HTTPServer(('127.0.0.1', ${FREE_PORT13}), H).serve_forever()
" &
FAKE_SERVER_PID13=$!
disown "$FAKE_SERVER_PID13" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- disown prevents bash job-tracking; cleanup via explicit kill below
sleep 0.5

# Write a PID file with the CORRECT port already
FAKE_PID13=99998
echo "${FAKE_PID13}" > "$TMPDATA/canon-daemon.pid"
echo "${FREE_PORT13}" >> "$TMPDATA/canon-daemon.pid"

BOOT_MARKER13="$TMPDATA/boot_called13"
OUTPUT13=$(CANON_HTTP_DAEMON=1 \
  CLAUDE_PLUGIN_DATA="$TMPDATA" \
  CLAUDE_PLUGIN_ROOT="$TMPROOT" \
  CANON_DAEMON_PORT="$FREE_PORT13" \
  CANON_SUPERVISOR_BOOT_CMD="touch $BOOT_MARKER13" \
  CANON_SUPERVISOR_START_TIMEOUT=3 \
  bash "$HOOK" 2>&1)
EXIT_CODE13=$?

kill "$FAKE_SERVER_PID13" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- cleanup only

PID_LINE13=""
PORT_LINE13=""
if [[ -f "$TMPDATA/canon-daemon.pid" ]]; then
  PID_LINE13=$(sed -n '1p' "$TMPDATA/canon-daemon.pid")
  PORT_LINE13=$(sed -n '2p' "$TMPDATA/canon-daemon.pid")
fi

if [[ $EXIT_CODE13 -eq 0 ]] \
   && [[ ! -f "$BOOT_MARKER13" ]] \
   && [[ "$PID_LINE13" == "${FAKE_PID13}" ]] \
   && [[ "$PORT_LINE13" == "${FREE_PORT13}" ]]; then
  pass "F2c: PID file already correct — no modification, no restart"
else
  fail "F2c no-change: exit=$EXIT_CODE13, boot_called=$(test -f "$BOOT_MARKER13" && echo yes || echo no), pid_line='${PID_LINE13}', port_line='${PORT_LINE13}', output=$(echo "$OUTPUT13" | head -5)"
fi
rm -rf "$TMPDATA" "$TMPROOT"

# ---------------------------------------------------------------------------
# T-A: Survivor recovery happy path (dc-01) — SIGTERM/SIGKILL clears a real
# Canon-daemon survivor squatting the port after a failed start; retry once
# brings the target version up.
# ---------------------------------------------------------------------------
TMPDATA=$(mktemp -d)
TMPROOT=$(mktemp -d)
mkdir -p "$TMPROOT/mcp-server"
echo '{"name":"canon-mcp","version":"20.0.0-target"}' > "$TMPROOT/mcp-server/package.json"

FREE_PORTA=$(python3 -c "
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
")

# Survivor: real python /health server at OLD version, bound to FREE_PORTA
python3 -c "
import http.server, json

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            body = json.dumps({'ok': True, 'port': ${FREE_PORTA}, 'version': '19.9.9-old', 'transport': 'http'}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(body)
    def log_message(self, *a): pass

http.server.HTTPServer(('127.0.0.1', ${FREE_PORTA}), H).serve_forever()
" &
SURVIVOR_PID_A=$!
disown "$SURVIVOR_PID_A" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- disown prevents bash job-tracking; cleanup via explicit kill below
sleep 0.5

# Boot script: tries to bind FREE_PORTA at TARGET version; exits quietly if the
# port is still held (survivor alive), succeeds once the survivor is cleared.
BOOT_SCRIPT_A="$TMPDATA/boot_target.py"
cat > "$BOOT_SCRIPT_A" <<PYEOF
import http.server, json, sys

class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == '/health':
            body = json.dumps({'ok': True, 'port': ${FREE_PORTA}, 'version': '20.0.0-target', 'transport': 'http'}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(body)
    def log_message(self, *a): pass

try:
    server = http.server.HTTPServer(('127.0.0.1', ${FREE_PORTA}), H)
except OSError:
    sys.exit(0)
server.serve_forever()
PYEOF

FAKE_BIN_A=$(mktemp -d)
cat > "$FAKE_BIN_A/ps" <<'PSSTUB'
#!/usr/bin/env bash
echo "node tsx src/app/daemon.ts"
PSSTUB
chmod +x "$FAKE_BIN_A/ps"

# The boot script's second invocation binds successfully and calls
# serve_forever() (never exits). The hook backgrounds CANON_SUPERVISOR_BOOT_CMD
# via `eval "$CMD" &`; if $CMD is a single non-backgrounded command, that eval
# wrapper synchronously waits on it and keeps holding the wrapper's own
# inherited stdout fd (the command-substitution pipe below) open for as long
# as the child lives — even though the child's OWN fds are redirected to a
# file. Nesting `nohup ... &` inside the injected command makes eval return
# immediately once the payload is detached, releasing that fd.
OUTPUT_A=$(CANON_HTTP_DAEMON=1 \
  CLAUDE_PLUGIN_DATA="$TMPDATA" \
  CLAUDE_PLUGIN_ROOT="$TMPROOT" \
  CANON_DAEMON_PORT="$FREE_PORTA" \
  CANON_SUPERVISOR_BOOT_CMD="nohup python3 $BOOT_SCRIPT_A >$TMPDATA/boot-target.log 2>&1 &" \
  CANON_SUPERVISOR_PORT_OWNER_CMD="echo $SURVIVOR_PID_A" \
  CANON_SUPERVISOR_START_TIMEOUT=3 \
  CANON_SUPERVISOR_TERM_GRACE=2 \
  CANON_SUPERVISOR_KILL_WAIT=2 \
  PATH="$FAKE_BIN_A:$PATH" \
  bash "$HOOK" 2>&1)
EXIT_CODE_A=$?

SURVIVOR_DEAD_A=no
if ! kill -0 "$SURVIVOR_PID_A" 2>/dev/null; then
  SURVIVOR_DEAD_A=yes
fi
kill "$SURVIVOR_PID_A" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- cleanup only; process should already be dead (expected outcome)

# The successful retry leaves an orphaned python /health server bound to
# FREE_PORTA (disowned by the hook, reparented to init) — find and kill it
# so it doesn't linger past this test.
LEFTOVER_A=$(lsof -nP -iTCP:"$FREE_PORTA" -sTCP:LISTEN -t 2>/dev/null | head -n1)
[[ -n "$LEFTOVER_A" ]] && kill -9 "$LEFTOVER_A" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- best-effort cleanup of the orphaned test survivor

STARTED_TARGET_A=no
echo "$OUTPUT_A" | grep -q "started successfully (v20.0.0-target)" && STARTED_TARGET_A=yes

if [[ $EXIT_CODE_A -eq 0 ]] && [[ "$SURVIVOR_DEAD_A" == "yes" ]] && [[ "$STARTED_TARGET_A" == "yes" ]]; then
  pass "T-A: survivor recovery happy path — killed, retried, started at target version"
else
  fail "T-A: exit=$EXIT_CODE_A, survivor_dead=${SURVIVOR_DEAD_A}, started_target=${STARTED_TARGET_A}, output=$(echo "$OUTPUT_A" | head -10)"
fi
rm -rf "$TMPDATA" "$TMPROOT" "$FAKE_BIN_A"

# ---------------------------------------------------------------------------
# T-B: Non-Canon port owner is never killed (dc-02) — identity guard blocks
# recovery when the real port owner's cmdline does not match tsx+daemon.ts.
# ---------------------------------------------------------------------------
TMPDATA=$(mktemp -d)
TMPROOT=$(mktemp -d)
mkdir -p "$TMPROOT/mcp-server"
echo '{"name":"canon-mcp","version":"21.0.0-target"}' > "$TMPROOT/mcp-server/package.json"

FREE_PORTB=$(python3 -c "
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
")

# Real, killable process standing in as the "port owner" — must survive.
sleep 999 &
OWNER_PID_B=$!
disown "$OWNER_PID_B" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- disown prevents bash job-tracking

FAKE_BIN_B=$(mktemp -d)
cat > "$FAKE_BIN_B/ps" <<'PSSTUB'
#!/usr/bin/env bash
echo "/usr/bin/python3 some-other-process.py"
PSSTUB
chmod +x "$FAKE_BIN_B/ps"

OUTPUT_B=$(CANON_HTTP_DAEMON=1 \
  CLAUDE_PLUGIN_DATA="$TMPDATA" \
  CLAUDE_PLUGIN_ROOT="$TMPROOT" \
  CANON_DAEMON_PORT="$FREE_PORTB" \
  CANON_SUPERVISOR_BOOT_CMD=":" \
  CANON_SUPERVISOR_PORT_OWNER_CMD="echo $OWNER_PID_B" \
  CANON_SUPERVISOR_START_TIMEOUT=1 \
  PATH="$FAKE_BIN_B:$PATH" \
  bash "$HOOK" 2>&1)
EXIT_CODE_B=$?

OWNER_SURVIVED_B=no
if kill -0 "$OWNER_PID_B" 2>/dev/null; then
  OWNER_SURVIVED_B=yes
fi
kill "$OWNER_PID_B" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- cleanup only

WARNED_IDENTITY_B=no
echo "$OUTPUT_B" | grep -q "refusing to kill (identity guard)" && WARNED_IDENTITY_B=yes

if [[ $EXIT_CODE_B -eq 0 ]] && [[ "$OWNER_SURVIVED_B" == "yes" ]] && [[ "$WARNED_IDENTITY_B" == "yes" ]]; then
  pass "T-B: non-Canon port owner never killed, identity guard warns, exit 0"
else
  fail "T-B: exit=$EXIT_CODE_B, owner_survived=${OWNER_SURVIVED_B}, warned=${WARNED_IDENTITY_B}, output=$(echo "$OUTPUT_B" | head -10)"
fi
rm -rf "$TMPDATA" "$TMPROOT" "$FAKE_BIN_B"

# ---------------------------------------------------------------------------
# T-C: lsof-absent / owner-unknown → fail-closed (dc-03) — the port-owner
# resolver override fails (rc != 0); recovery cannot proceed, loud WARN.
# ---------------------------------------------------------------------------
TMPDATA=$(mktemp -d)
TMPROOT=$(mktemp -d)
mkdir -p "$TMPROOT/mcp-server"
echo '{"name":"canon-mcp","version":"22.0.0-target"}' > "$TMPROOT/mcp-server/package.json"

FREE_PORTC=$(python3 -c "
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
")

OUTPUT_C=$(CANON_HTTP_DAEMON=1 \
  CLAUDE_PLUGIN_DATA="$TMPDATA" \
  CLAUDE_PLUGIN_ROOT="$TMPROOT" \
  CANON_DAEMON_PORT="$FREE_PORTC" \
  CANON_SUPERVISOR_BOOT_CMD=":" \
  CANON_SUPERVISOR_PORT_OWNER_CMD="false" \
  CANON_SUPERVISOR_START_TIMEOUT=1 \
  bash "$HOOK" 2>&1)
EXIT_CODE_C=$?

CONTAINS_UNKNOWN_C=no
echo "$OUTPUT_C" | grep -q "could not be identified" && CONTAINS_UNKNOWN_C=yes
CONTAINS_CANNOT_RECOVER_C=no
echo "$OUTPUT_C" | grep -q "cannot auto-recover" && CONTAINS_CANNOT_RECOVER_C=yes

if [[ $EXIT_CODE_C -eq 0 ]] && [[ "$CONTAINS_UNKNOWN_C" == "yes" ]] && [[ "$CONTAINS_CANNOT_RECOVER_C" == "yes" ]]; then
  pass "T-C: lsof-absent/owner-unknown fails closed, loud WARN, exit 0"
else
  fail "T-C: exit=$EXIT_CODE_C, unknown_warn=${CONTAINS_UNKNOWN_C}, cannot_recover_warn=${CONTAINS_CANNOT_RECOVER_C}, output=$(echo "$OUTPUT_C" | head -10)"
fi
rm -rf "$TMPDATA" "$TMPROOT"

# ---------------------------------------------------------------------------
# T-D: retry-exhausted after a successful kill → fail-closed loud block
# (dc-03) — owner identity-confirms as a Canon daemon, escalate_kill clears
# it, but the retried start still fails; the existing loud recovery block
# must fire (not a silent pass).
# ---------------------------------------------------------------------------
TMPDATA=$(mktemp -d)
TMPROOT=$(mktemp -d)
mkdir -p "$TMPROOT/mcp-server"
echo '{"name":"canon-mcp","version":"23.0.0-target"}' > "$TMPROOT/mcp-server/package.json"

FREE_PORTD=$(python3 -c "
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
")

# Real, killable process standing in as a Canon-daemon-identified owner.
sleep 999 &
OWNER_PID_D=$!
disown "$OWNER_PID_D" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- disown prevents bash job-tracking

FAKE_BIN_D=$(mktemp -d)
cat > "$FAKE_BIN_D/ps" <<'PSSTUB'
#!/usr/bin/env bash
echo "node tsx src/app/daemon.ts"
PSSTUB
chmod +x "$FAKE_BIN_D/ps"

OUTPUT_D=$(CANON_HTTP_DAEMON=1 \
  CLAUDE_PLUGIN_DATA="$TMPDATA" \
  CLAUDE_PLUGIN_ROOT="$TMPROOT" \
  CANON_DAEMON_PORT="$FREE_PORTD" \
  CANON_SUPERVISOR_BOOT_CMD=":" \
  CANON_SUPERVISOR_PORT_OWNER_CMD="echo $OWNER_PID_D" \
  CANON_SUPERVISOR_START_TIMEOUT=1 \
  CANON_SUPERVISOR_TERM_GRACE=1 \
  CANON_SUPERVISOR_KILL_WAIT=1 \
  PATH="$FAKE_BIN_D:$PATH" \
  bash "$HOOK" 2>&1)
EXIT_CODE_D=$?

OWNER_DEAD_D=no
if ! kill -0 "$OWNER_PID_D" 2>/dev/null; then
  OWNER_DEAD_D=yes
fi
kill "$OWNER_PID_D" 2>/dev/null || true # DOCUMENTED FAIL-OPEN -- cleanup only; process should already be dead

CONTAINS_FAIL_MSG_D=no
echo "$OUTPUT_D" | grep -q "tools will FAIL" && CONTAINS_FAIL_MSG_D=yes

if [[ $EXIT_CODE_D -eq 0 ]] && [[ "$OWNER_DEAD_D" == "yes" ]] && [[ "$CONTAINS_FAIL_MSG_D" == "yes" ]]; then
  pass "T-D: retry-exhausted after successful kill — loud recovery block fires, exit 0"
else
  fail "T-D: exit=$EXIT_CODE_D, owner_dead=${OWNER_DEAD_D}, fail_msg=${CONTAINS_FAIL_MSG_D}, output=$(echo "$OUTPUT_D" | head -10)"
fi
rm -rf "$TMPDATA" "$TMPROOT" "$FAKE_BIN_D"

# ---------------------------------------------------------------------------
# T-E: port-free after failed start → existing loud block preserved
# (dc-03/dc-04) — guards that Test 10's down-daemon behavior still fires
# when routed through the new recovery orchestration.
# ---------------------------------------------------------------------------
TMPDATA=$(mktemp -d)
TMPROOT=$(mktemp -d)
mkdir -p "$TMPROOT/mcp-server"
echo '{"name":"canon-mcp","version":"24.0.0-target"}' > "$TMPROOT/mcp-server/package.json"

FREE_PORTE=$(python3 -c "
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
")

OUTPUT_E=$(CANON_HTTP_DAEMON=1 \
  CLAUDE_PLUGIN_DATA="$TMPDATA" \
  CLAUDE_PLUGIN_ROOT="$TMPROOT" \
  CANON_DAEMON_PORT="$FREE_PORTE" \
  CANON_SUPERVISOR_BOOT_CMD=":" \
  CANON_SUPERVISOR_PORT_OWNER_CMD="true" \
  CANON_SUPERVISOR_START_TIMEOUT=1 \
  bash "$HOOK" 2>&1)
EXIT_CODE_E=$?

CONTAINS_FAIL_MSG_E=no
echo "$OUTPUT_E" | grep -q "tools will FAIL" && CONTAINS_FAIL_MSG_E=yes

if [[ $EXIT_CODE_E -eq 0 ]] && [[ "$CONTAINS_FAIL_MSG_E" == "yes" ]]; then
  pass "T-E: port-free after failed start — existing loud recovery block preserved, exit 0"
else
  fail "T-E: exit=$EXIT_CODE_E, fail_msg=${CONTAINS_FAIL_MSG_E}, output=$(echo "$OUTPUT_E" | head -10)"
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
