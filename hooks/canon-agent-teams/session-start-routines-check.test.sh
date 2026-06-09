#!/usr/bin/env bash
# Tests for session-start-routines-check.sh
# Run with: bash hooks/canon-agent-teams/session-start-routines-check.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/session-start-routines-check.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/../test-helpers.sh"

PASS=0
FAIL=0

echo ""
echo "=== session-start-routines-check.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# Helper: build a minimal routine .md file
# ---------------------------------------------------------------------------
make_routine_file() {
  local path="$1"
  local name="$2"
  local status="$3"
  local binding="${4:-}"   # explicit binding_target, optional
  local needs_state="${5:-git-native}"
  local needs_daemon="${6:-false}"

  mkdir -p "$(dirname "$path")"
  {
    echo "---"
    echo "name: ${name}"
    echo "title: ${name} title"
    echo "status: ${status}"
    if [[ -n "$binding" ]]; then
      echo "binding_target: ${binding}"
    fi
    echo "needs:"
    echo "  state: ${needs_state}"
    echo "  daemon: ${needs_daemon}"
    echo "---"
    echo ""
    echo "Routine body for ${name}."
  } > "$path"
}

# ---------------------------------------------------------------------------
# Test 1: No .canon/routines directory — exits 0 silently
# ---------------------------------------------------------------------------
echo "-- No routines dir: exits 0 silently --"

DIR1=$(mktemp -d)
trap 'rm -rf "$DIR1"' EXIT

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR1" HOME="$DIR1/home" bash "$HOOK" 2>&1) || EXIT_CODE=$?

if [[ "$EXIT_CODE" -eq 0 ]] && [[ -z "$OUTPUT" ]]; then
  echo "  PASS: no routines dir exits 0 silently"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected silent exit 0, got exit=$EXIT_CODE output='$OUTPUT'"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# Test 2: Enabled desktop-task routine with no SKILL.md → nudge printed
# ---------------------------------------------------------------------------
echo ""
echo "-- Drifted desktop-task: nudge printed --"

DIR2=$(mktemp -d)
ROUTINES_DIR2="$DIR2/.canon/routines"
HOME2="$DIR2/home"
mkdir -p "$ROUTINES_DIR2" "$HOME2"

make_routine_file "$ROUTINES_DIR2/nightly.md" "nightly-check" "enabled" "" "local-canon" "true"

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR2" HOME="$HOME2" bash "$HOOK" 2>&1) || EXIT_CODE=$?

if [[ "$EXIT_CODE" -eq 0 ]]; then
  echo "  PASS: drifted routine exits 0"
  PASS=$((PASS + 1))
else
  echo "  FAIL: drifted routine should exit 0, got $EXIT_CODE"
  FAIL=$((FAIL + 1))
fi

if echo "$OUTPUT" | grep -q "CANON NOTE:"; then
  echo "  PASS: nudge contains 'CANON NOTE:'"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected CANON NOTE: in output, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi

if echo "$OUTPUT" | grep -q "nightly-check"; then
  echo "  PASS: nudge names the drifted routine"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected routine name in nudge, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi

if echo "$OUTPUT" | grep -q "/canon:routines sync"; then
  echo "  PASS: nudge suggests /canon:routines sync"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected /canon:routines sync suggestion in output, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR2"

# ---------------------------------------------------------------------------
# Test 3: Enabled desktop-task routine WITH SKILL.md present → no nudge
# ---------------------------------------------------------------------------
echo ""
echo "-- Bound desktop-task: no nudge --"

DIR3=$(mktemp -d)
ROUTINES_DIR3="$DIR3/.canon/routines"
HOME3="$DIR3/home"
SKILL_DIR3="$HOME3/.claude/scheduled-tasks/bound-routine"
mkdir -p "$ROUTINES_DIR3" "$SKILL_DIR3"

make_routine_file "$ROUTINES_DIR3/bound.md" "bound-routine" "enabled" "" "local-canon" "true"
echo "# SKILL" > "$SKILL_DIR3/SKILL.md"

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR3" HOME="$HOME3" bash "$HOOK" 2>&1) || EXIT_CODE=$?

if [[ "$EXIT_CODE" -eq 0 ]] && [[ -z "$OUTPUT" ]]; then
  echo "  PASS: bound routine is silent"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected silent exit 0 for bound routine, got exit=$EXIT_CODE output='$OUTPUT'"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR3"

# ---------------------------------------------------------------------------
# Test 4: Cloud-routine (git-native, no daemon) — no nudge even without SKILL.md
# ---------------------------------------------------------------------------
echo ""
echo "-- Cloud-routine: no nudge (cloud state is external) --"

DIR4=$(mktemp -d)
ROUTINES_DIR4="$DIR4/.canon/routines"
HOME4="$DIR4/home"
mkdir -p "$ROUTINES_DIR4" "$HOME4"

make_routine_file "$ROUTINES_DIR4/cloud.md" "cloud-routine" "enabled" "" "git-native" "false"

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR4" HOME="$HOME4" bash "$HOOK" 2>&1) || EXIT_CODE=$?

if [[ "$EXIT_CODE" -eq 0 ]] && [[ -z "$OUTPUT" ]]; then
  echo "  PASS: cloud-routine is silent (no live binding check)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: cloud-routine should be silent, got exit=$EXIT_CODE output='$OUTPUT'"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR4"

# ---------------------------------------------------------------------------
# Test 5: Disabled routine — no nudge even if SKILL.md is missing
# ---------------------------------------------------------------------------
echo ""
echo "-- Disabled routine: no nudge --"

DIR5=$(mktemp -d)
ROUTINES_DIR5="$DIR5/.canon/routines"
HOME5="$DIR5/home"
mkdir -p "$ROUTINES_DIR5" "$HOME5"

make_routine_file "$ROUTINES_DIR5/disabled.md" "disabled-routine" "disabled" "" "local-canon" "true"

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR5" HOME="$HOME5" bash "$HOOK" 2>&1) || EXIT_CODE=$?

if [[ "$EXIT_CODE" -eq 0 ]] && [[ -z "$OUTPUT" ]]; then
  echo "  PASS: disabled routine is silent"
  PASS=$((PASS + 1))
else
  echo "  FAIL: disabled routine should be silent, got exit=$EXIT_CODE output='$OUTPUT'"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR5"

# ---------------------------------------------------------------------------
# Test 6: Explicit binding_target override — desktop-task via explicit field
# ---------------------------------------------------------------------------
echo ""
echo "-- Explicit binding_target desktop-task: nudge printed --"

DIR6=$(mktemp -d)
ROUTINES_DIR6="$DIR6/.canon/routines"
HOME6="$DIR6/home"
mkdir -p "$ROUTINES_DIR6" "$HOME6"

# git-native non-daemon would normally be cloud, but explicit override
make_routine_file "$ROUTINES_DIR6/override.md" "override-routine" "enabled" "desktop-task" "git-native" "false"

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR6" HOME="$HOME6" bash "$HOOK" 2>&1) || EXIT_CODE=$?

if [[ "$EXIT_CODE" -eq 0 ]] && echo "$OUTPUT" | grep -q "CANON NOTE:"; then
  echo "  PASS: explicit desktop-task override triggers nudge"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected nudge for explicit desktop-task override, got exit=$EXIT_CODE output='$OUTPUT'"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR6"

# ---------------------------------------------------------------------------
# Test 7 (LOAD-BEARING): Hook NEVER writes any file
# ---------------------------------------------------------------------------
echo ""
echo "-- WRITES-NOTHING: hook is strictly read-only --"

DIR7=$(mktemp -d)
ROUTINES_DIR7="$DIR7/.canon/routines"
HOME7="$DIR7/home"
mkdir -p "$ROUTINES_DIR7" "$HOME7"

# Create a drifted desktop-task routine (would trigger nudge)
make_routine_file "$ROUTINES_DIR7/drifted.md" "drifted-task" "enabled" "" "local-canon" "true"

# Snapshot the fixture dir before
BEFORE_FILES=$(find "$DIR7" -type f | sort)

CANON_PROJECT_DIR="$DIR7" HOME="$HOME7" bash "$HOOK" >/dev/null 2>&1 || true

# Snapshot after
AFTER_FILES=$(find "$DIR7" -type f | sort)

if [[ "$BEFORE_FILES" == "$AFTER_FILES" ]]; then
  echo "  PASS: hook wrote no files (before == after snapshot)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: hook wrote files!"
  echo "        Before: $BEFORE_FILES"
  echo "        After:  $AFTER_FILES"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR7"

# ---------------------------------------------------------------------------
# Test 8: Multiple drifted routines — all named in nudge
# ---------------------------------------------------------------------------
echo ""
echo "-- Multiple drifted routines: all named --"

DIR8=$(mktemp -d)
ROUTINES_DIR8="$DIR8/.canon/routines"
HOME8="$DIR8/home"
mkdir -p "$ROUTINES_DIR8" "$HOME8"

make_routine_file "$ROUTINES_DIR8/task-a.md" "task-alpha" "enabled" "" "local-canon" "true"
make_routine_file "$ROUTINES_DIR8/task-b.md" "task-beta" "enabled" "" "local-canon" "true"

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR8" HOME="$HOME8" bash "$HOOK" 2>&1) || EXIT_CODE=$?

NAMED_A=false
NAMED_B=false
echo "$OUTPUT" | grep -q "task-alpha" && NAMED_A=true || true
echo "$OUTPUT" | grep -q "task-beta" && NAMED_B=true || true

if [[ "$EXIT_CODE" -eq 0 ]] && [[ "$NAMED_A" == "true" ]] && [[ "$NAMED_B" == "true" ]]; then
  echo "  PASS: both drifted routines named in nudge"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected both names in output, got exit=$EXIT_CODE output='$OUTPUT'"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR8"

# ---------------------------------------------------------------------------
# Test 9: README.md in routines dir is skipped
# ---------------------------------------------------------------------------
echo ""
echo "-- README.md in routines dir: skipped --"

DIR9=$(mktemp -d)
ROUTINES_DIR9="$DIR9/.canon/routines"
HOME9="$DIR9/home"
mkdir -p "$ROUTINES_DIR9" "$HOME9"

# Only a README (no real routines)
echo "# Routines" > "$ROUTINES_DIR9/README.md"

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR9" HOME="$HOME9" bash "$HOOK" 2>&1) || EXIT_CODE=$?

if [[ "$EXIT_CODE" -eq 0 ]] && [[ -z "$OUTPUT" ]]; then
  echo "  PASS: README.md is skipped"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected silent exit 0, got exit=$EXIT_CODE output='$OUTPUT'"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR9"

# ---------------------------------------------------------------------------
# Test 10: binding_target: ~ (YAML null) — falls through to needs-based derivation
#
# A canon-maintenance-shaped routine: binding_target: ~ + needs: state=local-canon, daemon=true
# → should resolve to desktop-task → no SKILL.md → nudge MUST fire.
# This validates the fix for the Codex P2 bug: resolve_binding must not return
# the literal string "~" — it must treat it as UNSET and use needs.
# ---------------------------------------------------------------------------
echo ""
echo "-- binding_target: ~ (YAML null) + daemon: true → desktop-task → nudge --"

DIR10=$(mktemp -d)
ROUTINES_DIR10="$DIR10/.canon/routines"
HOME10="$DIR10/home"
mkdir -p "$ROUTINES_DIR10" "$HOME10"

# Write fixture manually so binding_target: ~ is emitted literally
cat > "$ROUTINES_DIR10/canon-maintenance.md" <<'FIXTURE'
---
name: canon-maintenance
title: Canon Maintenance
status: enabled
binding_target: ~
needs:
  state: local-canon
  daemon: true
---

Canon maintenance routine body.
FIXTURE

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR10" HOME="$HOME10" bash "$HOOK" 2>&1) || EXIT_CODE=$?

if [[ "$EXIT_CODE" -eq 0 ]]; then
  echo "  PASS: exits 0"
  PASS=$((PASS + 1))
else
  echo "  FAIL: should exit 0, got $EXIT_CODE"
  FAIL=$((FAIL + 1))
fi

if echo "$OUTPUT" | grep -q "CANON NOTE:"; then
  echo "  PASS: binding_target:~ triggers nudge (falls through to needs-based desktop-task)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected CANON NOTE: for binding_target:~ routine, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi

if echo "$OUTPUT" | grep -q "canon-maintenance"; then
  echo "  PASS: nudge names the routine"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected routine name in nudge, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR10"

# ---------------------------------------------------------------------------
# Test 11: binding_target: ~ (YAML null) — with SKILL.md present → no nudge
# ---------------------------------------------------------------------------
echo ""
echo "-- binding_target: ~ with SKILL.md present → no nudge --"

DIR11=$(mktemp -d)
ROUTINES_DIR11="$DIR11/.canon/routines"
HOME11="$DIR11/home"
SKILL_DIR11="$HOME11/.claude/scheduled-tasks/canon-maintenance"
mkdir -p "$ROUTINES_DIR11" "$SKILL_DIR11"

cat > "$ROUTINES_DIR11/canon-maintenance.md" <<'FIXTURE'
---
name: canon-maintenance
title: Canon Maintenance
status: enabled
binding_target: ~
needs:
  state: local-canon
  daemon: true
---

Canon maintenance routine body.
FIXTURE
echo "# SKILL" > "$SKILL_DIR11/SKILL.md"

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR11" HOME="$HOME11" bash "$HOOK" 2>&1) || EXIT_CODE=$?

if [[ "$EXIT_CODE" -eq 0 ]] && [[ -z "$OUTPUT" ]]; then
  echo "  PASS: binding_target:~ with SKILL.md present → silent (bound)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected silent exit 0, got exit=$EXIT_CODE output='$OUTPUT'"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR11"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi

exit 0
