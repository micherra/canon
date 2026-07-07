#!/usr/bin/env bash
# Tests for run-agent-evals.sh fixture resolution (sub-suite fallback + fail-closed).
# Bash 3.2 compatible. Runs without model calls (--dry-run only).
#
# Root-caused bug: the holistic sub-suite (agents/reviewer/evals/holistic/eval-set.json)
# reuses unit-suite fixtures (agents/reviewer/evals/fixtures/*) but run-agent-evals.sh
# only ever looked under $EVAL_ROOT/fixtures — so every holistic case silently produced
# a WARNING + empty prompt content instead of resolving, and the mandatory holistic
# veto (decideCompositeGate) could never fire because its inputs were never scored.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVALS_DIR="$SCRIPT_DIR/.."
RUN_EVALS="$EVALS_DIR/run-agent-evals.sh"
HOLISTIC_ROOT="$EVALS_DIR/holistic"

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "FAIL: $1" >&2; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# ---------------------------------------------------------------------------
# T1: holistic suite's fixtures resolve via the unit-suite fallback — no
# "fixture file not found" warning, and both cases report DRYRUN (not ERROR).
# ---------------------------------------------------------------------------
output=$(bash "$RUN_EVALS" --eval-root "$HOLISTIC_ROOT" --dry-run 2>&1)

if printf '%s\n' "$output" | grep -q 'fixture file not found\|fixture not found'; then
  fail "T1a: holistic dry-run still reports a fixture-not-found warning/error. Output: $output"
else
  pass "T1a: holistic dry-run reports no fixture-not-found warning"
fi

dryrun_count=$(printf '%s\n' "$output" | grep -c '^  DRYRUN' || true)
if [[ "$dryrun_count" -eq 2 ]]; then
  pass "T1b: both holistic cases resolved to DRYRUN (fixtures found)"
else
  fail "T1b: expected 2 DRYRUN results, got $dryrun_count. Output: $output"
fi

if printf '%s\n' "$output" | tail -1 | grep -q 'exit'; then
  : # no-op — exit code checked below via $?
fi

# ---------------------------------------------------------------------------
# T2: unit suite (default eval-root) is unaffected by the fallback addition —
# its own fixtures still resolve directly, no regression.
# ---------------------------------------------------------------------------
output_unit=$(bash "$RUN_EVALS" --dry-run 2>&1)
if printf '%s\n' "$output_unit" | grep -q 'fixture file not found\|fixture not found'; then
  fail "T2: unit suite dry-run now reports a fixture-not-found warning/error (regression). Output: $output_unit"
else
  pass "T2: unit suite dry-run still resolves all fixtures directly"
fi

# ---------------------------------------------------------------------------
# T3: a fixture missing from BOTH the eval-root's own fixtures/ dir and the
# unit-suite fallback fails closed — non-zero exit, ERROR result, no silent
# skip. This is the regression guard for the Goodhart failure mode itself:
# a zero-scored case must never look like a pass.
# ---------------------------------------------------------------------------
TMP_ROOT=$(mktemp -d)
trap 'rm -rf "$TMP_ROOT"' EXIT

cat > "$TMP_ROOT/eval-set.json" <<'EOF'
{
  "agent": "reviewer",
  "evals": [
    {
      "id": "bogus-missing-fixture-case",
      "stage": "1",
      "split": "train",
      "kind": "must_not_flag",
      "fixture": "this-fixture-does-not-exist-anywhere",
      "expected_output": "n/a"
    }
  ]
}
EOF

set +e
missing_output=$(bash "$RUN_EVALS" --eval-root "$TMP_ROOT" --dry-run 2>&1)
missing_exit=$?
set -e

if [[ "$missing_exit" -ne 0 ]]; then
  pass "T3a: missing fixture (neither location) exits non-zero (fail-closed)"
else
  fail "T3a: missing fixture should exit non-zero, got exit 0. Output: $missing_output"
fi

if printf '%s\n' "$missing_output" | grep -q '^  ERROR.*bogus-missing-fixture-case'; then
  pass "T3b: missing fixture case is reported as ERROR, not a silent skip"
else
  fail "T3b: expected an ERROR result line for bogus-missing-fixture-case. Output: $missing_output"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "============================="
echo "Results: $PASS_COUNT passed, $FAIL_COUNT failed"
echo "============================="

if [[ $FAIL_COUNT -gt 0 ]]; then
  exit 1
fi
exit 0
