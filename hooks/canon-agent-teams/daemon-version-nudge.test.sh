#!/usr/bin/env bash
# daemon-version-nudge.test.sh — behavioral tests for the stale-daemon
# version-mismatch nudge hook.
#
# Tests inject environment overrides to avoid touching the real daemon or the
# real plugin cache:
#   CLAUDE_PLUGIN_ROOT       — fixture plugin-root dir (sibling of fabricated
#                              X.Y.Z version dirs)
#   CANON_PROJECT_DIR        — fixture .canon/ state dir
#   CANON_NUDGE_HEALTH_CMD   — command whose stdout replaces the /health curl
#   CANON_DAEMON_NUDGE_TTL   — TTL seconds override
#   CANON_DAEMON_PORT        — port override (real-unreachable-port case)
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/daemon-version-nudge.sh"
PASS=0
FAIL=0

pass() { echo "PASS: $1"; (( PASS++ )); }
fail() { echo "FAIL: $1"; (( FAIL++ )); }

# ---------------------------------------------------------------------------
# Test: shellcheck passes
# ---------------------------------------------------------------------------
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck "$HOOK" >/dev/null 2>&1; then
    pass "shellcheck daemon-version-nudge.sh"
  else
    fail "shellcheck daemon-version-nudge.sh"
    shellcheck "$HOOK" || true # DOCUMENTED FAIL-OPEN -- shellcheck output already emitted above; continue to gather all failures
  fi
else
  echo "SKIP: shellcheck not installed"
fi

# ---------------------------------------------------------------------------
# Helper: build a fixture PARENT dir with the given sibling version dirs and
# return CLAUDE_PLUGIN_ROOT pointing at the given "current" version subdir.
# ---------------------------------------------------------------------------
make_plugin_root() {
  local parent="$1"
  local current="$2"
  shift 2
  mkdir -p "$parent"
  for v in "$current" "$@"; do
    mkdir -p "$parent/$v"
  done
  echo "$parent/$current"
}

# ---------------------------------------------------------------------------
# AC#1 + AC#2: mismatch -> nudge names both versions + /canon:doctor; exit 0
# ---------------------------------------------------------------------------
TMP1=$(mktemp -d)
PARENT1="$TMP1/cache/canon"
ROOT1=$(make_plugin_root "$PARENT1" "2.16.0" "2.17.0")
PROJDIR1="$TMP1/proj"
mkdir -p "$PROJDIR1"

OUTPUT=$(CLAUDE_PLUGIN_ROOT="$ROOT1" \
  CANON_PROJECT_DIR="$PROJDIR1" \
  CANON_NUDGE_HEALTH_CMD='echo "{\"version\":\"2.16.0\"}"' \
  CANON_DAEMON_NUDGE_TTL=3600 \
  bash "$HOOK" <<<'{}' 2>&1)
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]] && echo "$OUTPUT" | grep -q "2.16.0" && echo "$OUTPUT" | grep -q "2.17.0" && echo "$OUTPUT" | grep -q "/canon:doctor"; then
  pass "AC#1/AC#2: mismatch nudge names both versions + /canon:doctor, exit 0"
else
  fail "AC#1/AC#2: exit=$EXIT_CODE, output=$OUTPUT"
fi
rm -rf "$TMP1"

# ---------------------------------------------------------------------------
# AC#3: no signal/spawn tokens anywhere in the script
# ---------------------------------------------------------------------------
if grep -E 'kill|SIGTERM|SIGKILL|nohup|disown|boot\.sh' "$HOOK" >/dev/null 2>&1; then
  fail "AC#3: forbidden signal/spawn token found in $HOOK"
else
  pass "AC#3: no kill/SIGTERM/SIGKILL/nohup/disown/boot.sh tokens in script"
fi

# ---------------------------------------------------------------------------
# AC#4: TTL-cached probe -- two in-TTL calls -> exactly one probe
# ---------------------------------------------------------------------------
TMP4=$(mktemp -d)
PARENT4="$TMP4/cache/canon"
ROOT4=$(make_plugin_root "$PARENT4" "2.16.0" "2.17.0")
PROJDIR4="$TMP4/proj"
mkdir -p "$PROJDIR4"
COUNTER4="$TMP4/counter"
HEALTHCMD4="$TMP4/health_counter.sh"
cat > "$HEALTHCMD4" <<EOF
#!/usr/bin/env bash
echo x >> "$COUNTER4"
echo '{"version":"2.16.0"}'
EOF
chmod +x "$HEALTHCMD4"

CLAUDE_PLUGIN_ROOT="$ROOT4" \
  CANON_PROJECT_DIR="$PROJDIR4" \
  CANON_NUDGE_HEALTH_CMD="bash $HEALTHCMD4" \
  CANON_DAEMON_NUDGE_TTL=3600 \
  bash "$HOOK" <<<'{}' >/dev/null 2>&1
CLAUDE_PLUGIN_ROOT="$ROOT4" \
  CANON_PROJECT_DIR="$PROJDIR4" \
  CANON_NUDGE_HEALTH_CMD="bash $HEALTHCMD4" \
  CANON_DAEMON_NUDGE_TTL=3600 \
  bash "$HOOK" <<<'{}' >/dev/null 2>&1

COUNT4=0
if [[ -f "$COUNTER4" ]]; then
  COUNT4=$(wc -l < "$COUNTER4" | tr -d '[:space:]')
fi
if [[ "$COUNT4" -eq 1 ]]; then
  pass "AC#4: two in-TTL calls -> exactly one probe"
else
  fail "AC#4: expected 1 probe, got $COUNT4"
fi
rm -rf "$TMP4"

# ---------------------------------------------------------------------------
# AC#5a: empty body -> no nudge, exit 0
# ---------------------------------------------------------------------------
TMP5A=$(mktemp -d)
PARENT5A="$TMP5A/cache/canon"
ROOT5A=$(make_plugin_root "$PARENT5A" "2.16.0" "2.17.0")
PROJDIR5A="$TMP5A/proj"
mkdir -p "$PROJDIR5A"

OUTPUT=$(CLAUDE_PLUGIN_ROOT="$ROOT5A" \
  CANON_PROJECT_DIR="$PROJDIR5A" \
  CANON_NUDGE_HEALTH_CMD='true' \
  CANON_DAEMON_NUDGE_TTL=3600 \
  bash "$HOOK" <<<'{}' 2>&1)
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]] && ! echo "$OUTPUT" | grep -q "CANON NOTE"; then
  pass "AC#5a: empty /health body -> no nudge, exit 0"
else
  fail "AC#5a: exit=$EXIT_CODE, output=$OUTPUT"
fi
rm -rf "$TMP5A"

# ---------------------------------------------------------------------------
# AC#5b: malformed body -> no nudge, exit 0
# ---------------------------------------------------------------------------
TMP5B=$(mktemp -d)
PARENT5B="$TMP5B/cache/canon"
ROOT5B=$(make_plugin_root "$PARENT5B" "2.16.0" "2.17.0")
PROJDIR5B="$TMP5B/proj"
mkdir -p "$PROJDIR5B"

OUTPUT=$(CLAUDE_PLUGIN_ROOT="$ROOT5B" \
  CANON_PROJECT_DIR="$PROJDIR5B" \
  CANON_NUDGE_HEALTH_CMD="echo 'not json'" \
  CANON_DAEMON_NUDGE_TTL=3600 \
  bash "$HOOK" <<<'{}' 2>&1)
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]] && ! echo "$OUTPUT" | grep -q "CANON NOTE"; then
  pass "AC#5b: malformed /health body -> no nudge, exit 0"
else
  fail "AC#5b: exit=$EXIT_CODE, output=$OUTPUT"
fi
rm -rf "$TMP5B"

# ---------------------------------------------------------------------------
# AC#5c: real unreachable port (no health cmd) -> no nudge, exit 0
# ---------------------------------------------------------------------------
TMP5C=$(mktemp -d)
PARENT5C="$TMP5C/cache/canon"
ROOT5C=$(make_plugin_root "$PARENT5C" "2.16.0" "2.17.0")
PROJDIR5C="$TMP5C/proj"
mkdir -p "$PROJDIR5C"

OUTPUT=$(CLAUDE_PLUGIN_ROOT="$ROOT5C" \
  CANON_PROJECT_DIR="$PROJDIR5C" \
  CANON_DAEMON_PORT=19 \
  CANON_DAEMON_NUDGE_TTL=3600 \
  bash "$HOOK" <<<'{}' 2>&1)
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]] && ! echo "$OUTPUT" | grep -q "CANON NOTE"; then
  pass "AC#5c: unreachable port -> no nudge, exit 0"
else
  fail "AC#5c: exit=$EXIT_CODE, output=$OUTPUT"
fi
rm -rf "$TMP5C"

# ---------------------------------------------------------------------------
# AC#6: mid-session mismatch detected after TTL expiry (TTL=0 forces re-probe)
# ---------------------------------------------------------------------------
TMP6=$(mktemp -d)
PARENT6="$TMP6/cache/canon"
ROOT6=$(make_plugin_root "$PARENT6" "2.16.0")
PROJDIR6="$TMP6/proj"
mkdir -p "$PROJDIR6"

OUTPUT_FIRST=$(CLAUDE_PLUGIN_ROOT="$ROOT6" \
  CANON_PROJECT_DIR="$PROJDIR6" \
  CANON_NUDGE_HEALTH_CMD='echo "{\"version\":\"2.16.0\"}"' \
  CANON_DAEMON_NUDGE_TTL=0 \
  bash "$HOOK" <<<'{}' 2>&1)
EXIT_FIRST=$?

mkdir -p "$PARENT6/2.17.0"

OUTPUT_SECOND=$(CLAUDE_PLUGIN_ROOT="$ROOT6" \
  CANON_PROJECT_DIR="$PROJDIR6" \
  CANON_NUDGE_HEALTH_CMD='echo "{\"version\":\"2.16.0\"}"' \
  CANON_DAEMON_NUDGE_TTL=0 \
  bash "$HOOK" <<<'{}' 2>&1)
EXIT_SECOND=$?

if [[ $EXIT_FIRST -eq 0 ]] && ! echo "$OUTPUT_FIRST" | grep -q "CANON NOTE" \
  && [[ $EXIT_SECOND -eq 0 ]] && echo "$OUTPUT_SECOND" | grep -q "2.16.0" && echo "$OUTPUT_SECOND" | grep -q "2.17.0"; then
  pass "AC#6: mid-session sibling-dir change detected after TTL expiry"
else
  fail "AC#6: first(exit=$EXIT_FIRST,out=$OUTPUT_FIRST) second(exit=$EXIT_SECOND,out=$OUTPUT_SECOND)"
fi
rm -rf "$TMP6"

# ---------------------------------------------------------------------------
# AC#7: repeated calls under same mismatch pair -> single nudge (dedup)
# ---------------------------------------------------------------------------
TMP7=$(mktemp -d)
PARENT7="$TMP7/cache/canon"
ROOT7=$(make_plugin_root "$PARENT7" "2.16.0" "2.17.0")
PROJDIR7="$TMP7/proj"
mkdir -p "$PROJDIR7"

OUTPUT_A=$(CLAUDE_PLUGIN_ROOT="$ROOT7" \
  CANON_PROJECT_DIR="$PROJDIR7" \
  CANON_NUDGE_HEALTH_CMD='echo "{\"version\":\"2.16.0\"}"' \
  CANON_DAEMON_NUDGE_TTL=3600 \
  bash "$HOOK" <<<'{}' 2>&1)
OUTPUT_B=$(CLAUDE_PLUGIN_ROOT="$ROOT7" \
  CANON_PROJECT_DIR="$PROJDIR7" \
  CANON_NUDGE_HEALTH_CMD='echo "{\"version\":\"2.16.0\"}"' \
  CANON_DAEMON_NUDGE_TTL=3600 \
  bash "$HOOK" <<<'{}' 2>&1)

NUDGE_COUNT=$(printf '%s\n%s\n' "$OUTPUT_A" "$OUTPUT_B" | grep -c "CANON NOTE")
if [[ "$NUDGE_COUNT" -eq 1 ]]; then
  pass "AC#7: two in-window mismatch calls -> exactly one nudge"
else
  fail "AC#7: expected 1 nudge, got $NUDGE_COUNT (A=$OUTPUT_A B=$OUTPUT_B)"
fi
rm -rf "$TMP7"

# ---------------------------------------------------------------------------
# Match case: daemon version == max sibling -> no nudge, exit 0
# ---------------------------------------------------------------------------
TMPM=$(mktemp -d)
PARENTM="$TMPM/cache/canon"
ROOTM=$(make_plugin_root "$PARENTM" "2.16.0" "2.17.0")
PROJDIRM="$TMPM/proj"
mkdir -p "$PROJDIRM"

OUTPUT=$(CLAUDE_PLUGIN_ROOT="$ROOTM" \
  CANON_PROJECT_DIR="$PROJDIRM" \
  CANON_NUDGE_HEALTH_CMD='echo "{\"version\":\"2.17.0\"}"' \
  CANON_DAEMON_NUDGE_TTL=3600 \
  bash "$HOOK" <<<'{}' 2>&1)
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]] && ! echo "$OUTPUT" | grep -q "CANON NOTE"; then
  pass "Match case: daemon version == max sibling -> no nudge, exit 0"
else
  fail "Match case: exit=$EXIT_CODE, output=$OUTPUT"
fi
rm -rf "$TMPM"

# ---------------------------------------------------------------------------
# Unresolvable installed: CLAUDE_PLUGIN_ROOT empty/unset -> exit 0, no nudge
# ---------------------------------------------------------------------------
TMPU=$(mktemp -d)
PROJDIRU="$TMPU/proj"
mkdir -p "$PROJDIRU"

OUTPUT=$(CLAUDE_PLUGIN_ROOT="" \
  CANON_PROJECT_DIR="$PROJDIRU" \
  CANON_NUDGE_HEALTH_CMD='echo "{\"version\":\"2.16.0\"}"' \
  CANON_DAEMON_NUDGE_TTL=3600 \
  bash "$HOOK" <<<'{}' 2>&1)
EXIT_CODE=$?

if [[ $EXIT_CODE -eq 0 ]] && ! echo "$OUTPUT" | grep -q "CANON NOTE"; then
  pass "Unresolvable installed version: CLAUDE_PLUGIN_ROOT unset -> exit 0, no nudge"
else
  fail "Unresolvable installed version: exit=$EXIT_CODE, output=$OUTPUT"
fi
rm -rf "$TMPU"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== daemon-version-nudge.test.sh: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
