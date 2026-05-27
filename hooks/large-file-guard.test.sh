#!/usr/bin/env bash
# Tests for large-file-guard.sh
# Run with: bash hooks/large-file-guard.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/large-file-guard.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

PASS=0
FAIL=0

TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

echo ""
echo "=== large-file-guard.sh tests ==="
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
  echo "  PASS: no file_path passes silently"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected silent exit 0, got exit=$EXIT_CODE output=$OUTPUT"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# Excluded file types: pass silently
# ---------------------------------------------------------------------------
echo ""
echo "-- Excluded file types (should pass silently) --"

for ext in ".lock" ".svg" ".json" ".csv" ".sql"; do
  INPUT="{\"file_path\":\"/tmp/file${ext}\"}"
  OUTPUT=$(cd "$T_BASE" && echo "$INPUT" | bash "$HOOK" 2>&1) || true
  if [[ -z "$OUTPUT" ]]; then
    echo "  PASS: $ext file skipped"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $ext should be skipped, got: $OUTPUT"
    FAIL=$((FAIL + 1))
  fi
done

# Bundle/vendor/node_modules
for pattern in "bundle.js" "vendor.js" "node_modules/lib.js"; do
  INPUT="{\"file_path\":\"/tmp/${pattern}\"}"
  OUTPUT=$(cd "$T_BASE" && echo "$INPUT" | bash "$HOOK" 2>&1) || true
  if [[ -z "$OUTPUT" ]]; then
    echo "  PASS: $pattern file skipped"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $pattern should be skipped, got: $OUTPUT"
    FAIL=$((FAIL + 1))
  fi
done

# ---------------------------------------------------------------------------
# Edit call: existing file under threshold — silent
# ---------------------------------------------------------------------------
echo ""
echo "-- Edit call: existing file under threshold (should pass silently) --"

T_SMALL="$TMPDIR_BASE/t_small"
setup_repo "$T_SMALL"
# Create a 10-line file
seq 1 10 | awk '{print "line " $1}' > "$T_SMALL/src/small.ts"

INPUT="{\"file_path\":\"${T_SMALL}/src/small.ts\"}"
OUTPUT=$(cd "$T_SMALL" && echo "$INPUT" | bash "$HOOK" 2>&1) || true
if [[ -z "$OUTPUT" ]]; then
  echo "  PASS: small existing file is silent"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected silent for small file, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# Edit call: existing file over threshold — warns
# ---------------------------------------------------------------------------
echo ""
echo "-- Edit call: existing file over threshold (should warn) --"

T_LARGE="$TMPDIR_BASE/t_large"
setup_repo "$T_LARGE"
# Create a file with 510 lines (over default 500)
seq 1 510 | awk '{print "const x" $1 " = " $1 ";"}' > "$T_LARGE/src/large.ts"

EXIT_CODE=0
OUTPUT=$(cd "$T_LARGE" && echo "{\"file_path\":\"${T_LARGE}/src/large.ts\"}" | bash "$HOOK" 2>&1) || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]]; then
  echo "  PASS: large file exits 0 (advisory only)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: large file should exit 0, got $EXIT_CODE"
  FAIL=$((FAIL + 1))
fi

if echo "$OUTPUT" | grep -q "CANON WARNING"; then
  echo "  PASS: large existing file outputs CANON WARNING"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected CANON WARNING for large file, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# Custom threshold via config.json
# ---------------------------------------------------------------------------
echo ""
echo "-- Custom threshold via .canon/config.json --"

T_CUSTOM="$TMPDIR_BASE/t_custom"
setup_repo "$T_CUSTOM"
mkdir -p "$T_CUSTOM/.canon"
echo '{"max_file_lines": 50}' > "$T_CUSTOM/.canon/config.json"
# Create a 60-line file (over custom threshold of 50)
seq 1 60 | awk '{print "const y" $1 " = " $1 ";"}' > "$T_CUSTOM/src/medium.ts"

OUTPUT=$(cd "$T_CUSTOM" && echo "{\"file_path\":\"${T_CUSTOM}/src/medium.ts\"}" | bash "$HOOK" 2>&1) || true
if echo "$OUTPUT" | grep -q "CANON WARNING"; then
  echo "  PASS: custom threshold 50 warns for 60-line file"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected warning with custom threshold 50, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi

# A 40-line file is under the custom threshold — silent
seq 1 40 | awk '{print "const z" $1 " = " $1 ";"}' > "$T_CUSTOM/src/tiny.ts"
OUTPUT=$(cd "$T_CUSTOM" && echo "{\"file_path\":\"${T_CUSTOM}/src/tiny.ts\"}" | bash "$HOOK" 2>&1) || true
if [[ -z "$OUTPUT" ]]; then
  echo "  PASS: 40-line file under custom threshold 50 is silent"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected silent for 40-line file with threshold 50, got: $OUTPUT"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# Write call: content field line count over threshold — warns
# ---------------------------------------------------------------------------
echo ""
echo "-- Write call: content field over threshold (should warn) --"

T_WRITE="$TMPDIR_BASE/t_write"
setup_repo "$T_WRITE"

# Build a content string with 510 newline-separated lines, then JSON-encode it.
# jq encodes newlines as \n in the string value, which is what the hook parses.
if command -v jq &>/dev/null; then
  # Use jq to safely build the JSON payload with proper escaping.
  WRITE_INPUT=$(jq -n --arg fp "${T_WRITE}/src/newfile.ts" --arg ct "$(seq 1 510 | awk '{print "const w" $1 " = " $1 ";"}')" \
    '{"file_path": $fp, "content": $ct}')
else
  # Fallback: build a content field with 510 literal \n sequences.
  WRITE_INPUT="{\"file_path\":\"${T_WRITE}/src/newfile.ts\",\"content\":\"$(printf 'line%.0s\\n' {1..510})\"}"
fi

EXIT_CODE=0
OUTPUT=$(cd "$T_WRITE" && echo "$WRITE_INPUT" | bash "$HOOK" 2>&1) || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]]; then
  echo "  PASS: Write-path large content exits 0 (advisory only)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: Write-path large content should exit 0, got $EXIT_CODE"
  FAIL=$((FAIL + 1))
fi

if echo "$OUTPUT" | grep -q "CANON WARNING"; then
  echo "  PASS: Write-path large content outputs CANON WARNING"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected CANON WARNING for Write-path large content, got: $OUTPUT"
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
