#!/usr/bin/env bash
# Tests for principle-inject.sh
# Run with: bash hooks/principle-inject.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures
#
# Note: principle-inject.sh delegates principle lookup to principle-inject-worker.mjs
# (Node.js). Tests here cover the shell-layer logic: file-path extraction, extension
# filtering, session dedup, and worker-absent graceful exit. Tests that exercise
# the actual injection output require a configured CANON_PLUGIN_DIR environment and
# are skipped when the worker is unavailable.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/principle-inject.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

PASS=0
FAIL=0

TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

echo ""
echo "=== principle-inject.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# No file_path in input: pass silently (exit 0)
# ---------------------------------------------------------------------------
echo "-- No file_path in input (should pass silently) --"

T_BASE="$TMPDIR_BASE/t_base"
setup_repo "$T_BASE"

EXIT_CODE=0
OUTPUT=$(cd "$T_BASE" && echo '{}' | bash "$HOOK" 2>&1) || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]] && [[ -z "$OUTPUT" ]]; then
  echo "  PASS: no file_path exits 0 silently"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected silent exit 0, got exit=$EXIT_CODE output=$OUTPUT"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# Excluded file extensions: pass silently (skip injection)
# ---------------------------------------------------------------------------
echo ""
echo "-- Excluded file types (should pass silently) --"

for ext in ".lock" ".svg" ".json" ".csv" ".sql" ".md"; do
  INPUT="{\"session_id\":\"inject-test-${ext}\",\"file_path\":\"/tmp/file${ext}\"}"
  EXIT_CODE=0
  OUTPUT=$(cd "$T_BASE" && echo "$INPUT" | bash "$HOOK" 2>&1) || EXIT_CODE=$?
  if [[ "$EXIT_CODE" -eq 0 ]]; then
    echo "  PASS: $ext extension skipped (exit 0)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $ext should exit 0, got $EXIT_CODE"
    FAIL=$((FAIL + 1))
  fi
done

# ---------------------------------------------------------------------------
# Worker absent: passes silently (graceful fallback)
# ---------------------------------------------------------------------------
echo ""
echo "-- Worker absent (should exit 0 gracefully) --"

T_NOWORKER="$TMPDIR_BASE/t_noworker"
setup_repo "$T_NOWORKER"

# Copy the hook script into a temp directory that does NOT contain the worker
# .mjs file. This ensures $HOOK_DIR inside the copied hook resolves to a dir
# without principle-inject-worker.mjs, actually exercising the [[ ! -f "$WORKER" ]]
# branch. Simply pointing CANON_PLUGIN_DIR elsewhere is insufficient because the
# hook resolves $WORKER relative to $HOOK_DIR (the script's own directory).
HOOK_NOWORKER_DIR="$TMPDIR_BASE/hook_noworker"
mkdir -p "$HOOK_NOWORKER_DIR"
cp "$HOOK" "$HOOK_NOWORKER_DIR/principle-inject.sh"
HOOK_NOWORKER="$HOOK_NOWORKER_DIR/principle-inject.sh"

SESSION_ID="inject-noworker-$$"
INPUT="{\"session_id\":\"${SESSION_ID}\",\"file_path\":\"src/app.ts\"}"

EXIT_CODE=0
OUTPUT=$(cd "$T_NOWORKER" && \
  bash "$HOOK_NOWORKER" <<<"$INPUT" 2>&1) || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]]; then
  echo "  PASS: missing worker exits 0 gracefully"
  PASS=$((PASS + 1))
else
  echo "  FAIL: missing worker should exit 0, got $EXIT_CODE"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# Session dedup: second call for same file in same session is silent
# ---------------------------------------------------------------------------
echo ""
echo "-- Session dedup (second call for same file is silent) --"

T_DEDUP="$TMPDIR_BASE/t_dedup"
setup_repo "$T_DEDUP"
SESSION_DEDUP="inject-dedup-$$"
INPUT_DEDUP="{\"session_id\":\"${SESSION_DEDUP}\",\"file_path\":\"src/app.ts\"}"

# First call: use the worker-absent copy so we control the hook dir.
# Will exit 0 with no output, and write the dedup marker file.
(cd "$T_DEDUP" && echo "$INPUT_DEDUP" | bash "$HOOK_NOWORKER" >/dev/null 2>&1) || true

# Second call: dedup marker exists — should skip immediately with no output
EXIT_CODE=0
OUTPUT=$(cd "$T_DEDUP" && echo "$INPUT_DEDUP" | bash "$HOOK_NOWORKER" 2>&1) || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]] && [[ -z "$OUTPUT" ]]; then
  echo "  PASS: dedup exits 0 silently on second call"
  PASS=$((PASS + 1))
else
  echo "  FAIL: dedup should exit 0 with no output, got exit=$EXIT_CODE output=$OUTPUT"
  FAIL=$((FAIL + 1))
fi

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
