#!/bin/bash
# Tests for workflows-lint.mjs (via hooks/workflows-lint.sh).
# Run with: bash hooks/workflows-lint.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures
#
# AC#3 mechanical proof: one valid fixture exits 0; one fixture per banned
# construct exits non-zero AND names the construct in stdout/stderr.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LINT_HELPER="$REPO_ROOT/mcp-server/scripts/workflows-lint.mjs"
FIXTURES_DIR="$SCRIPT_DIR/__tests__/workflows-lint"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

echo ""
echo "=== workflows-lint.mjs tests ==="
echo ""

# ---------------------------------------------------------------------------
# Helper: run_lint_on_dir <expected_exit> <dir> <description>
#   Runs the node lint helper on <dir>. Checks exit code only.
# ---------------------------------------------------------------------------
run_lint_on_dir() {
  local expected_exit="$1"
  local dir="$2"
  local description="$3"

  local actual_exit=0
  node "$LINT_HELPER" "$dir" >/dev/null 2>&1 || actual_exit=$?

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------------------
# Helper: run_lint_with_construct <fixture_file> <expected_construct> <description>
#   Copies fixture_file to a temp dir, runs lint on that dir.
#   Asserts: non-zero exit AND output contains expected_construct.
# ---------------------------------------------------------------------------
run_lint_with_construct() {
  local fixture_file="$1"
  local expected_construct="$2"
  local description="$3"

  local tmpdir
  tmpdir="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmpdir'" EXIT INT TERM

  cp "$fixture_file" "$tmpdir/"

  local actual_exit=0
  local output
  output=$(node "$LINT_HELPER" "$tmpdir" 2>&1) || actual_exit=$?

  local exit_ok=true
  local output_ok=true

  if [[ "$actual_exit" -eq 0 ]]; then
    exit_ok=false
  fi

  if ! echo "$output" | grep -qF "$expected_construct"; then
    output_ok=false
  fi

  if [[ "$exit_ok" == "true" ]] && [[ "$output_ok" == "true" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    if [[ "$exit_ok" == "false" ]]; then
      echo "        expected non-zero exit, got exit=0"
    fi
    if [[ "$output_ok" == "false" ]]; then
      echo "        expected output containing: $expected_construct"
      echo "        actual output: $output"
    fi
    FAIL=$((FAIL + 1))
  fi

  rm -rf "$tmpdir"
  # Reset trap to avoid double-rm on subsequent iterations
  trap - EXIT INT TERM
}

# ---------------------------------------------------------------------------
# Test: valid fixture passes (exit 0)
# ---------------------------------------------------------------------------
echo "--- Valid fixture ---"

# Create a temp dir with ONLY the valid fixture so other bad fixtures don't interfere
VALID_TMPDIR="$(mktemp -d)"
cp "$FIXTURES_DIR/valid-canon-probe.js" "$VALID_TMPDIR/"
run_lint_on_dir 0 "$VALID_TMPDIR" "valid fixture (exit 0)"
rm -rf "$VALID_TMPDIR"

echo ""
echo "--- Banned-construct fixtures (each must fail naming the construct) ---"

run_lint_with_construct \
  "$FIXTURES_DIR/bad-date-now.js" \
  "Date.now()" \
  "bad-date-now.js: named 'Date.now()'"

run_lint_with_construct \
  "$FIXTURES_DIR/bad-math-random.js" \
  "Math.random()" \
  "bad-math-random.js: named 'Math.random()'"

run_lint_with_construct \
  "$FIXTURES_DIR/bad-argless-new-date.js" \
  "argless new Date()" \
  "bad-argless-new-date.js: named 'argless new Date()'"

run_lint_with_construct \
  "$FIXTURES_DIR/bad-isolation.js" \
  "isolation" \
  "bad-isolation.js: named 'isolation'"

run_lint_with_construct \
  "$FIXTURES_DIR/bad-ts-syntax.js" \
  "TS syntax" \
  "bad-ts-syntax.js: named 'TS syntax'"

run_lint_with_construct \
  "$FIXTURES_DIR/bad-malformed.js" \
  "parse error" \
  "bad-malformed.js: named 'parse error'"

run_lint_with_construct \
  "$FIXTURES_DIR/bad-nonliteral-meta.js" \
  "meta" \
  "bad-nonliteral-meta.js: named 'meta'"

# ---------------------------------------------------------------------------
# Advisory 1: TS-syntax detection robustness — diagnostic-path unit probe
#
# The AST .type-node path (tested above via bad-ts-syntax.js) handles the
# current TS version (6.x), which does NOT emit a parseDiagnostic for type
# annotations in ScriptKind.JS mode.  The diagnostic-path (hasTsOnlySyntaxDiag,
# codes 8009–8013) handles future TS versions that may change this behaviour.
#
# Since we cannot trigger codes 8009–8013 with the current TS, this probe
# exercises hasTsOnlySyntaxDiag directly via the --probe-ts-diagnostic flag,
# which simulates a fake code-8010 diagnostic and verifies the classification
# is "TS syntax (type annotation)" — NOT "parse error".
# ---------------------------------------------------------------------------
echo ""
echo "--- TS-diagnostic path unit probe (Advisory 1 robustness) ---"

DIAG_PROBE_EXIT=0
DIAG_PROBE_OUTPUT=""
DIAG_PROBE_OUTPUT=$(node "$LINT_HELPER" --probe-ts-diagnostic 2>&1) || DIAG_PROBE_EXIT=$?

if [[ "$DIAG_PROBE_EXIT" -eq 0 ]] && echo "$DIAG_PROBE_OUTPUT" | grep -qF "TS syntax (type annotation)"; then
  echo "  PASS: TS-diagnostic path classifies code 8010 as 'TS syntax' (not 'parse error')"
  PASS=$((PASS + 1))
else
  echo "  FAIL: TS-diagnostic path did not produce expected output"
  echo "        expected: exit=0, output containing 'TS syntax (type annotation)'"
  echo "        actual exit=$DIAG_PROBE_EXIT, output: $DIAG_PROBE_OUTPUT"
  FAIL=$((FAIL + 1))
fi

# ---------------------------------------------------------------------------
# Advisory 2: isolation key-scoped boundary — negative test
#
# The lint bans `isolation` as an agent-option PROPERTY KEY only.
# A bare variable named `isolation` must NOT trigger the ban.
#
# This pair of assertions locks the boundary:
#   bad-isolation.js (property key)  → must FAIL naming "isolation"  (tested above)
#   ok-isolation-variable.js (bare var) → must PASS (exit 0)
# ---------------------------------------------------------------------------
echo ""
echo "--- isolation key-scoped boundary (Advisory 2 negative test) ---"

ISO_VAR_TMPDIR="$(mktemp -d)"
# shellcheck disable=SC2064
trap "rm -rf '$ISO_VAR_TMPDIR'" EXIT INT TERM
cp "$FIXTURES_DIR/ok-isolation-variable.js" "$ISO_VAR_TMPDIR/"

ISO_VAR_EXIT=0
ISO_VAR_OUTPUT=""
ISO_VAR_OUTPUT=$(node "$LINT_HELPER" "$ISO_VAR_TMPDIR" 2>&1) || ISO_VAR_EXIT=$?

if [[ "$ISO_VAR_EXIT" -eq 0 ]]; then
  echo "  PASS: ok-isolation-variable.js passes lint (bare 'isolation' variable not banned)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: ok-isolation-variable.js should PASS lint (exit 0) but got exit=$ISO_VAR_EXIT"
  echo "        output: $ISO_VAR_OUTPUT"
  FAIL=$((FAIL + 1))
fi

rm -rf "$ISO_VAR_TMPDIR"
trap - EXIT INT TERM

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
if [[ $FAIL -gt 0 ]]; then
  echo "workflows-lint tests: $PASS passed, $FAIL FAILED."
  exit 1
else
  echo "workflows-lint tests: $PASS passed, 0 failed."
  exit 0
fi
