#!/usr/bin/env bash
# Tests for run-agent-evals.sh's SUT-invocation retry loop (W2 — sibling of the
# run-evals.sh fix in skills/canon/evals/__tests__/eval-core.test.sh T14-T16).
# Bash 3.2 compatible. Uses a stub `claude` on PATH so this is deterministic and
# makes zero live API calls.
#
# Root-caused bug: run-agent-evals.sh shares lib/eval-core.sh's judge/vote
# machinery with run-evals.sh (including is_transient_eval_failure), but its own
# SUT-invocation call site had no retry loop at all — a transient "Error:
# Reached max turns" under parallel load would report ERROR on the very first
# hit, with no chance to recover, unlike run-evals.sh's run_eval_case.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVALS_DIR="$SCRIPT_DIR/.."
RUN_AGENT_EVALS="$EVALS_DIR/run-agent-evals.sh"

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "FAIL: $1" >&2; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# A real case id from this suite's eval-set.json — its fixture resolves fine,
# so DRYRUN/NOJUDGE selection below exercises only the retry loop, not fixture
# resolution (that's fixture-resolution.test.sh's job).
CASE_ID="stage1-errors-are-values"

STUB_DIR=$(mktemp -d)
trap 'rm -rf "$STUB_DIR"' EXIT

cat > "$STUB_DIR/claude" <<'STUB'
#!/usr/bin/env bash
# Fake `claude` CLI — mirrors skills/canon/evals/__tests__/eval-core.test.sh's
# stub. Behavior selected via FAKE_CLAUDE_MODE; call count tracked in
# FAKE_CLAUDE_COUNTER_FILE (each invocation is a fresh process).
count=0
[[ -f "$FAKE_CLAUDE_COUNTER_FILE" ]] && count=$(cat "$FAKE_CLAUDE_COUNTER_FILE")
count=$((count + 1))
echo "$count" > "$FAKE_CLAUDE_COUNTER_FILE"

case "$FAKE_CLAUDE_MODE" in
  transient-then-success)
    if [[ "$count" -lt 2 ]]; then
      echo "Error: Reached max turns (6)"
      exit 1
    fi
    echo "CLEAN"
    exit 0
    ;;
  always-nontransient-failure)
    echo "Error: Not logged in"
    exit 1
    ;;
  always-transient-failure)
    echo "Error: Reached max turns (6)"
    exit 1
    ;;
esac
STUB
chmod +x "$STUB_DIR/claude"

# T1: transient-then-success — retry recovers, final result is not ERROR
COUNTER_T1=$(mktemp -u)
export FAKE_CLAUDE_COUNTER_FILE="$COUNTER_T1"
export FAKE_CLAUDE_MODE="transient-then-success"
output_t1=$(PATH="$STUB_DIR:$PATH" bash "$RUN_AGENT_EVALS" --filter "$CASE_ID" --no-judge 2>&1) || true
rm -f "$COUNTER_T1"
if printf '%s\n' "$output_t1" | grep -qE "^\s*NOJUDGE\s+${CASE_ID}"; then
  pass "T1a: transient-then-success — retry recovers, result is not ERROR"
else
  fail "T1a: expected NOJUDGE result for $CASE_ID, got: $output_t1"
fi
if printf '%s\n' "$output_t1" | grep -qE "^\s*ERROR\s+${CASE_ID}"; then
  fail "T1b: transient-then-success — result should not be ERROR"
else
  pass "T1b: transient-then-success — result correctly not ERROR"
fi

# T2: always-nontransient-failure — not retried, single attempt, still ERROR
COUNTER_T2=$(mktemp -u)
export FAKE_CLAUDE_COUNTER_FILE="$COUNTER_T2"
export FAKE_CLAUDE_MODE="always-nontransient-failure"
output_t2=$(PATH="$STUB_DIR:$PATH" timeout 60 bash "$RUN_AGENT_EVALS" --filter "$CASE_ID" --no-judge 2>&1) || true
call_count_t2=0
[[ -f "$COUNTER_T2" ]] && call_count_t2=$(cat "$COUNTER_T2")
rm -f "$COUNTER_T2"
if printf '%s\n' "$output_t2" | grep -qE "^\s*ERROR\s+${CASE_ID}"; then
  pass "T2a: always-nontransient-failure — correctly reported as ERROR, not retried into a false pass"
else
  fail "T2a: expected ERROR result for a non-transient failure, got: $output_t2"
fi
if [[ "$call_count_t2" -eq 1 ]]; then
  pass "T2b: always-nontransient-failure — invoked exactly once, no retry"
else
  fail "T2b: expected exactly 1 stub invocation, got $call_count_t2"
fi

# T3: always-transient-failure — exhausts the shared MAX_EVAL_RETRIES bound
# (1 initial + 2 retries = 3 total), same bound run-evals.sh uses (T16 in
# eval-core.test.sh), sourced from the same lib/eval-core.sh constant.
COUNTER_T3=$(mktemp -u)
export FAKE_CLAUDE_COUNTER_FILE="$COUNTER_T3"
export FAKE_CLAUDE_MODE="always-transient-failure"
output_t3=$(PATH="$STUB_DIR:$PATH" timeout 60 bash "$RUN_AGENT_EVALS" --filter "$CASE_ID" --no-judge 2>&1) || true
call_count_t3=0
[[ -f "$COUNTER_T3" ]] && call_count_t3=$(cat "$COUNTER_T3")
rm -f "$COUNTER_T3"
if printf '%s\n' "$output_t3" | grep -qE "^\s*ERROR\s+${CASE_ID}"; then
  pass "T3a: always-transient-failure — exhausts retries and reports ERROR (not a false pass)"
else
  fail "T3a: expected ERROR result for an always-transient failure, got: $output_t3"
fi
if [[ "$call_count_t3" -eq 3 ]]; then
  pass "T3b: always-transient-failure — invoked exactly 3 times (1 initial + 2 retries)"
else
  fail "T3b: expected exactly 3 stub invocations (1 initial + MAX_EVAL_RETRIES=2 retries), got $call_count_t3"
fi

unset FAKE_CLAUDE_COUNTER_FILE FAKE_CLAUDE_MODE

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
