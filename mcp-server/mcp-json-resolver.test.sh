#!/usr/bin/env bash
# mcp-json-resolver.test.sh — behavioral tests for the HTTP launch path in .mcp.json.
#
# Why this file exists (regression guard — HTTP edition, see ADR-0003):
#   The stdio form (PRs #191/#287/#356/#370) embedded a bash -c payload in args[1];
#   tests exercised that payload's resolver under var-present/absent/loud-fail conditions.
#   The .mcp.json is now an HTTP form (PR #382): no args array, no -c payload.
#   Old guard: args[1] extraction → PAYLOAD → run_payload() → assert STUB_BOOTED/CANON FATAL
#   New guard (this file): url token presence + headersHelper ${...} resolution + boot.sh --daemon
#
# Old → new coverage mapping (per decision httpci-03, ADR-0003):
#
#   #356 class (CC stops expanding ${...} → config collapses to literal path):
#     Old: run_payload() with CLAUDE_PLUGIN_ROOT present/absent/cwd → STUB_BOOTED resolves
#     New: B1/B2 assert headersHelper ${...} resolves correctly (var-present + :-. absent)
#          B3 asserts literal-unexpanded path is detectably absent (no-file → fail loud)
#
#   #370 class (var-absent / broken install → silent -32000 collapse instead of loud fail):
#     Old: run_payload() truly-nothing → "CANON FATAL" + exit 1 (Tests 5/7)
#     New: C-loud-fail asserts boot.sh --daemon exits non-zero + names "daemon.ts" when
#          the daemon entry point is absent — no silent collapse on the HTTP launch path
#
#   Codex P2 class (hardcoded url port ignores CANON_DAEMON_PORT):
#     Old: no guard existed (HTTP form not yet in use)
#     New: assertion A asserts url contains ${CANON_DAEMON_PORT (not hardcoded port)
#
# The tests exercise the real .mcp.json so they cannot drift from what ships.
# Resolution is exercised against STUB scripts — no real server is launched.
# boot.sh --print-resolution exits 0 after printing resolution, never launches.
# set -uo pipefail: fail fast on unset vars and command errors.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MCP_JSON="$REPO_ROOT/.mcp.json"
PASS=0
FAIL=0
pass() { echo "PASS: $1"; PASS=$((PASS+1)); }
fail() { echo "FAIL: $1"; FAIL=$((FAIL+1)); }

# ── Assertion A: url port-honoring (Codex P2 static guard) ──────────────────
#
# Old guard: none (HTTP form not yet in use when the stdio tests were written).
# New guard: url must contain the ${CANON_DAEMON_PORT token — any hardcoded port
# re-introduction (the Codex P2 regression class) is caught statically.
#
# Extract url from the real config (cannot drift from what ships).
_url_tmp="$(mktemp)"
node -e 'const j=require(process.argv[1]);process.stdout.write(j.mcpServers.canon.url)' \
  "$MCP_JSON" > "$_url_tmp" 2>/dev/null || true
read -r URL_VAL < "$_url_tmp"
rm -f "$_url_tmp"

if [[ -z "$URL_VAL" ]]; then
  echo "FATAL: could not extract mcpServers.canon.url from $MCP_JSON — HTTP form required" >&2
  exit 1
fi

# A — assert url contains the port-honoring token (not hardcoded)
# shellcheck disable=SC2016  # intentional: comparing against a literal ${...} token string
if [[ "$URL_VAL" == *'${CANON_DAEMON_PORT'* ]]; then
  pass "A: url contains \${CANON_DAEMON_PORT token (port not hardcoded)"
else
  fail "A: url port token absent — url is [$URL_VAL] (Codex P2: port appears hardcoded)"
fi

# ── Assertion B: headersHelper \${...} resolution (#356 analog) ──────────────
#
# Old guard: Tests 1-3 ran the -c payload under CLAUDE_PLUGIN_ROOT set/absent/cwd,
#   asserting STUB_BOOTED resolves in each case (var-absent fallback).
# New guard: B1/B2 assert headersHelper ${...} resolves (var-present + :-. absent);
#   B3 asserts the literal-unexpanded path is detectably absent (no silent success).
#
# Extract headersHelper from the real config.
_helper_tmp="$(mktemp)"
node -e 'const j=require(process.argv[1]);process.stdout.write(j.mcpServers.canon.headersHelper)' \
  "$MCP_JSON" > "$_helper_tmp" 2>/dev/null || true
read -r HELPER_VAL < "$_helper_tmp"
rm -f "$_helper_tmp"

if [[ -z "$HELPER_VAL" ]]; then
  echo "FATAL: could not extract mcpServers.canon.headersHelper from $MCP_JSON" >&2
  exit 1
fi

# Build a stub helper root: STUB_ROOT/mcp-server/mcp-auth-headers.sh emits a valid header.
# The stub uses only printf (no command substitution in the stub body itself).
STUB_HELPER_ROOT="$(mktemp -d)"
mkdir -p "$STUB_HELPER_ROOT/mcp-server"
printf '#!/usr/bin/env bash\n# stub helper — emits a valid Authorization header (STUBTOKEN only)\nprintf '"'"'{"Authorization":"Bearer STUBTOKEN"}'"'"'\n' \
  > "$STUB_HELPER_ROOT/mcp-server/mcp-auth-headers.sh"
chmod +x "$STUB_HELPER_ROOT/mcp-server/mcp-auth-headers.sh"

# B1 — var-PRESENT: expand HELPER_VAL with CLAUDE_PLUGIN_ROOT=<stub root>
# The token form is: ${CLAUDE_PLUGIN_ROOT:-.}/mcp-server/mcp-auth-headers.sh
# Deterministic expansion: replace the known token prefix without eval.
# HELPER_VAL looks like: ${CLAUDE_PLUGIN_ROOT:-.}/mcp-server/mcp-auth-headers.sh
# We expand it by replacing the leading ${CLAUDE_PLUGIN_ROOT:-.} with the stub root.
STRIPPED_HELPER="${HELPER_VAL#\$\{CLAUDE_PLUGIN_ROOT:-.\}}"
RESOLVED_B1="${STUB_HELPER_ROOT}${STRIPPED_HELPER}"

_b1_out="$(mktemp)"
_b1_run=0
if [[ -x "$RESOLVED_B1" ]]; then
  "$RESOLVED_B1" > "$_b1_out" 2>&1 && _b1_run=1 || true
fi
_b1_got=""
if [[ -s "$_b1_out" ]]; then
  read -r _b1_got < "$_b1_out"
fi
rm -f "$_b1_out"

if [[ "$RESOLVED_B1" == "$STUB_HELPER_ROOT/mcp-server/mcp-auth-headers.sh" ]] \
    && [[ -x "$RESOLVED_B1" ]] \
    && [[ "$_b1_run" -eq 1 ]] \
    && [[ "$_b1_got" == *'"Authorization"'* ]]; then
  pass "B1: headersHelper resolves + executes under CLAUDE_PLUGIN_ROOT=<stub root> (var-present #356)"
else
  fail "B1: headersHelper var-present: resolved=[$RESOLVED_B1] got=[$_b1_got] run=[$_b1_run]"
fi

# B2 — var-ABSENT (:-. fallback): CLAUDE_PLUGIN_ROOT unset → ${CLAUDE_PLUGIN_ROOT:-.}
# expands to '.' → path becomes ./mcp-server/mcp-auth-headers.sh
# Run from cwd = STUB_HELPER_ROOT so './mcp-server/mcp-auth-headers.sh' resolves.
RESOLVED_B2=".${STRIPPED_HELPER}"

_b2_out="$(mktemp)"
_b2_run=0
_b2_exit=0
(
  cd "$STUB_HELPER_ROOT"
  if [[ -x "$RESOLVED_B2" ]]; then
    "$RESOLVED_B2" > "$_b2_out" 2>&1
  else
    echo "NOT_FOUND" > "$_b2_out"
  fi
) || _b2_exit=$?
_b2_got=""
if [[ -s "$_b2_out" ]]; then
  read -r _b2_got < "$_b2_out"
fi
rm -f "$_b2_out"

# The :-.  fallback resolves ./mcp-server/mcp-auth-headers.sh in the stub cwd.
# Dev context (var absent, cwd is plugin root) mirrors how CC resolves it.
if [[ "$_b2_got" == *'"Authorization"'* ]]; then
  pass "B2: headersHelper resolves via :- fallback under var-ABSENT (dev context, #356 intent)"
else
  fail "B2: headersHelper var-absent: cwd=STUB, got=[$_b2_got] (:-. fallback broken)"
fi

# B3 — literal-unexpanded path MUST fail loud (#356/#370):
# If CC ever stops expanding ${CLAUDE_PLUGIN_ROOT:-.}, the helper path would be the
# literal string '${CLAUDE_PLUGIN_ROOT:-.}/mcp-server/mcp-auth-headers.sh' — which is
# not a real file. This guard confirms that if expansion regresses, the install
# fails detectably (helper-not-found) rather than silently producing a no-auth call.
LITERAL_PATH="$HELPER_VAL"   # the raw token string — still contains ${...}
if [[ ! -e "$LITERAL_PATH" ]]; then
  pass "B3: literal-unexpanded \${CLAUDE_PLUGIN_ROOT:-.} path does not exist (expansion regression is catchable, #356/#370)"
else
  fail "B3: literal path [$LITERAL_PATH] unexpectedly exists — guard no longer effective"
fi

# ── Assertion C: boot.sh --daemon launch-path resolution (#370 loud-fail) ────
#
# Old guard: Tests 5/7 ran the -c payload with truly-nothing env → "CANON FATAL" + exit 1.
# New guard: C asserts boot.sh --daemon resolves daemon.ts (the HTTP entry the supervisor
#   uses); C-loud-fail asserts boot.sh --daemon FAILS LOUD (non-zero + "daemon.ts" in
#   output) when daemon.ts is absent — no silent collapse (#370 invariant on HTTP path).
#
# Use --print-resolution: exits 0 after printing "SERVER_DIR NODE_PATH TSX_BIN",
# never launches. Use REPO_ROOT as the plugin root so daemon.ts is present.
REAL_BOOT_SH="$REPO_ROOT/mcp-server/boot.sh"

# C — daemon.ts present → boot.sh --daemon --print-resolution exits 0
_c_out="$(mktemp)"
_c_exit=0
CLAUDE_PLUGIN_ROOT="$REPO_ROOT" bash "$REAL_BOOT_SH" --daemon --print-resolution \
  > "$_c_out" 2>&1 || _c_exit=$?
_c_got=""
if [[ -s "$_c_out" ]]; then
  read -r _c_got < "$_c_out"
fi
rm -f "$_c_out"

if [[ "$_c_exit" -eq 0 ]] && [[ -n "$_c_got" ]]; then
  pass "C: boot.sh --daemon --print-resolution resolves SERVER_DIR (daemon.ts present, exit 0)"
else
  fail "C: boot.sh --daemon: exit=[$_c_exit] got=[$_c_got] (resolution failed)"
fi

# C-loud-fail — daemon.ts ABSENT → boot.sh --daemon must exit non-zero + name "daemon.ts"
# Build a stub plugin root that has mcp-server/src/app/index.ts but NOT daemon.ts.
STUB_NO_DAEMON="$(mktemp -d)"
mkdir -p "$STUB_NO_DAEMON/mcp-server/src/app"
touch "$STUB_NO_DAEMON/mcp-server/src/app/index.ts"
# daemon.ts is intentionally absent to trigger the #370 loud-fail path.

_cf_out="$(mktemp)"
_cf_exit=0
CLAUDE_PLUGIN_ROOT="$STUB_NO_DAEMON" bash "$REAL_BOOT_SH" --daemon --print-resolution \
  > "$_cf_out" 2>&1 || _cf_exit=$?
_cf_got=""
if [[ -s "$_cf_out" ]]; then
  # Read all output (may be multiple lines from stderr redirect)
  _cf_got="$(<"$_cf_out")"
fi
rm -f "$_cf_out"
rm -rf "$STUB_NO_DAEMON"

if [[ "$_cf_exit" -ne 0 ]] && [[ "$_cf_got" == *"daemon.ts"* ]]; then
  pass "C-loud-fail: boot.sh --daemon exits non-zero + names daemon.ts when entry absent (#370 on HTTP path)"
else
  fail "C-loud-fail: boot.sh --daemon silent collapse? exit=[$_cf_exit] got=[$_cf_got]"
fi

# ── Advisory 2: hooks/lint.sh shellchecks the HTTP form ─────────────────────
#
# Old: Advisory 2 confirmed hooks/lint.sh ran shellcheck on the -c payload (stdio form).
# New: hooks/lint.sh Check 2 + Check 3 now target the HTTP form. Check 2 verifies no
#   ${CLAUDE_PLUGIN_ROOT} token leaks into non-(-c) args (N/A for HTTP — gracefully
#   skips). Check 3 attempts to extract a -c payload (absent → skip notice, not fail).
#   The mcp-auth-headers.sh helper shipped in mcp-server/ is shellchecked by the
#   main hooks/lint.sh shellcheck loop (it covers hooks/**/*.sh; mcp-server/ files
#   are shellchecked separately). This test confirms the whole lint gate passes.
if command -v shellcheck >/dev/null 2>&1 && command -v jq >/dev/null 2>&1; then
  _adv2_out="$(mktemp)"
  _adv2_exit=0
  bash "$REPO_ROOT/hooks/lint.sh" > "$_adv2_out" 2>&1 || _adv2_exit=$?
  rm -f "$_adv2_out"
  if [[ "$_adv2_exit" -eq 0 ]]; then
    pass "Advisory 2: hooks/lint.sh passes on real HTTP-form .mcp.json (shellcheck + install guards)"
  else
    fail "Advisory 2: hooks/lint.sh failed on HTTP form — run 'bash hooks/lint.sh' for details"
  fi
else
  echo "SKIP: Advisory 2 lint test (shellcheck or jq not installed)"
fi

# Clean up stub helper root
rm -rf "$STUB_HELPER_ROOT"

echo "----"
echo "mcp-json-resolver: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
