#!/usr/bin/env bash
# Tests for skills/canon/evals/lib/eval-core.sh — the shared judge/vote/parallel-slot
# machinery sourced by run-evals.sh and agents/reviewer/evals/run-agent-evals.sh.
# Bash 3.2 compatible. No live `claude` calls except the retry-loop integration test,
# which stubs `claude` via PATH so it is deterministic and free.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVALS_DIR="$SCRIPT_DIR/.."
RUN_EVALS="$EVALS_DIR/run-evals.sh"

# shellcheck source=../lib/eval-core.sh
source "$EVALS_DIR/lib/eval-core.sh"

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "FAIL: $1" >&2; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# ---------------------------------------------------------------------------
# Defect 1: parse_single_verdict() must strip markdown code fences before
# attempting jq parse — the judge fences its JSON by default, and an unstripped
# fence causes a false FAIL even when the judge returned "verdict": "PASS".
# ---------------------------------------------------------------------------
STRUCTURED_JUDGE=true

# T1: fenced-json with a `json` language tag — the shape the judge actually emits
fenced_json='```json
{"verdict": "PASS", "explanation": "Looks good."}
```'
result=$(parse_single_verdict "$fenced_json")
if [[ "$result" == "PASS" ]]; then
  pass "T1: fenced-json (\`\`\`json ... \`\`\`) with verdict=PASS parses as PASS"
else
  fail "T1: fenced-json with verdict=PASS expected PASS, got $result"
fi

# T2: pretty-multiline (no fence) — regression guard, this already worked pre-fix
pretty_multiline='{
  "verdict": "PASS",
  "explanation": "Multi-line but not fenced."
}'
result=$(parse_single_verdict "$pretty_multiline")
if [[ "$result" == "PASS" ]]; then
  pass "T2: pretty-multiline (unfenced) with verdict=PASS parses as PASS"
else
  fail "T2: pretty-multiline with verdict=PASS expected PASS, got $result"
fi

# T3: bare-one-line (no fence) — regression guard, this already worked pre-fix
bare_one_line='{"verdict": "PASS", "explanation": "One line."}'
result=$(parse_single_verdict "$bare_one_line")
if [[ "$result" == "PASS" ]]; then
  pass "T3: bare-one-line with verdict=PASS parses as PASS"
else
  fail "T3: bare-one-line with verdict=PASS expected PASS, got $result"
fi

# T4: fenced-json without a language tag (bare ``` fence)
fenced_bare='```
{"verdict": "PASS", "explanation": "No language tag."}
```'
result=$(parse_single_verdict "$fenced_bare")
if [[ "$result" == "PASS" ]]; then
  pass "T4: fenced-json (bare \`\`\`, no language tag) with verdict=PASS parses as PASS"
else
  fail "T4: fenced-json (bare fence) with verdict=PASS expected PASS, got $result"
fi

# T5: fenced-json with leading prose before the fence
fenced_leading_prose='Here is my verdict:
```json
{"verdict": "PASS", "explanation": "Prose before the fence."}
```'
result=$(parse_single_verdict "$fenced_leading_prose")
if [[ "$result" == "PASS" ]]; then
  pass "T5: fenced-json with leading prose before the fence parses as PASS"
else
  fail "T5: fenced-json with leading prose expected PASS, got $result"
fi

# T6: fenced-json with trailing prose after the fence
fenced_trailing_prose='```json
{"verdict": "PASS", "explanation": "Prose after the fence."}
```
Let me know if you need anything else.'
result=$(parse_single_verdict "$fenced_trailing_prose")
if [[ "$result" == "PASS" ]]; then
  pass "T6: fenced-json with trailing prose after the fence parses as PASS"
else
  fail "T6: fenced-json with trailing prose expected PASS, got $result"
fi

# T7: fenced-json with CRLF line endings
fenced_crlf=$'```json\r\n{"verdict": "PASS", "explanation": "CRLF."}\r\n```'
result=$(parse_single_verdict "$fenced_crlf")
if [[ "$result" == "PASS" ]]; then
  pass "T7: fenced-json with CRLF line endings parses as PASS"
else
  fail "T7: fenced-json with CRLF expected PASS, got $result"
fi

# T8: fenced-json with verdict=FAIL must still parse as FAIL (fence-stripping
# must not bias the result toward PASS)
fenced_fail='```json
{"verdict": "FAIL", "explanation": "Missing test coverage."}
```'
result=$(parse_single_verdict "$fenced_fail")
if [[ "$result" == "FAIL" ]]; then
  pass "T8: fenced-json with verdict=FAIL parses as FAIL"
else
  fail "T8: fenced-json with verdict=FAIL expected FAIL, got $result"
fi

# T9: unstructured (non-JSON) judge output is unaffected by fence-stripping
STRUCTURED_JUDGE=false
plain_pass=$'PASS\nLooks correct to me.'
result=$(parse_single_verdict "$plain_pass")
if [[ "$result" == "PASS" ]]; then
  pass "T9: unstructured judge output 'PASS\\n...' still parses as PASS"
else
  fail "T9: unstructured judge output expected PASS, got $result"
fi
STRUCTURED_JUDGE=true

# ---------------------------------------------------------------------------
# Defect 2: is_transient_eval_failure() classifies the empirically-reproduced
# turn-budget-exhaustion-under-parallel-load failure signature as retry-worthy,
# and does NOT classify a genuine crash/config error as retry-worthy.
# ---------------------------------------------------------------------------

# T10: the exact signature reproduced under parallel load is transient
if is_transient_eval_failure "Error: Reached max turns (4)"; then
  pass "T10: 'Error: Reached max turns (4)' classified as transient"
else
  fail "T10: 'Error: Reached max turns (4)' should be classified as transient"
fi

# T11: a different max-turns value is still matched (message text varies by --max-turns)
if is_transient_eval_failure "Error: Reached max turns (6)"; then
  pass "T11: 'Error: Reached max turns (6)' classified as transient"
else
  fail "T11: 'Error: Reached max turns (6)' should be classified as transient"
fi

# T12: a genuine non-transient failure (e.g. auth/tool crash) is NOT retried
if is_transient_eval_failure "Error: Not logged in"; then
  fail "T12: 'Error: Not logged in' should NOT be classified as transient"
else
  pass "T12: 'Error: Not logged in' correctly NOT classified as transient"
fi

# T13: budget-exceeded is a separate, deterministic failure mode (would fail
# identically on retry) — must NOT be classified as transient
if is_transient_eval_failure "Error: Exceeded USD budget (1.00)"; then
  fail "T13: 'Error: Exceeded USD budget' should NOT be classified as transient"
else
  pass "T13: 'Error: Exceeded USD budget' correctly NOT classified as transient"
fi

# ---------------------------------------------------------------------------
# T14-T15: integration — run-evals.sh actually retries a transient failure and
# recovers, but does NOT infinite-loop or mask a genuine non-transient failure.
# Uses a stub `claude` on PATH so this is deterministic and makes zero live
# API calls.
# ---------------------------------------------------------------------------
STUB_DIR=$(mktemp -d)
trap 'rm -rf "$STUB_DIR"' EXIT

cat > "$STUB_DIR/claude" <<'STUB'
#!/usr/bin/env bash
# Fake `claude` CLI for eval-core retry integration tests. Behavior selected
# via FAKE_CLAUDE_MODE; call count tracked in FAKE_CLAUDE_COUNTER_FILE (each
# invocation is a fresh process, so state can't live in a shell variable).
count=0
[[ -f "$FAKE_CLAUDE_COUNTER_FILE" ]] && count=$(cat "$FAKE_CLAUDE_COUNTER_FILE")
count=$((count + 1))
echo "$count" > "$FAKE_CLAUDE_COUNTER_FILE"

case "$FAKE_CLAUDE_MODE" in
  transient-then-success)
    if [[ "$count" -lt 2 ]]; then
      echo "Error: Reached max turns (4)"
      exit 1
    fi
    echo "No staged changes found."
    exit 0
    ;;
  always-nontransient-failure)
    echo "Error: Not logged in"
    exit 1
    ;;
  always-transient-failure)
    echo "Error: Reached max turns (4)"
    exit 1
    ;;
esac
STUB
chmod +x "$STUB_DIR/claude"

# T14: transient-then-success — retry recovers, final result is not ERROR
COUNTER_T14=$(mktemp -u)
export FAKE_CLAUDE_COUNTER_FILE="$COUNTER_T14"
export FAKE_CLAUDE_MODE="transient-then-success"
output_t14=$(PATH="$STUB_DIR:$PATH" bash "$RUN_EVALS" --filter trigger-no-canon-project --no-judge 2>&1) || true
rm -f "$COUNTER_T14"
if printf '%s\n' "$output_t14" | grep -qE '^\s*NOJUDGE\s+trigger-no-canon-project'; then
  pass "T14a: transient-then-success — retry recovers, result is not ERROR"
else
  fail "T14a: expected NOJUDGE result for trigger-no-canon-project, got: $output_t14"
fi
if printf '%s\n' "$output_t14" | grep -qE '^\s*ERROR\s+trigger-no-canon-project'; then
  fail "T14b: transient-then-success — result should not be ERROR"
else
  pass "T14b: transient-then-success — result correctly not ERROR"
fi

# T15: always-nontransient-failure — must NOT be retried into a false pass,
# and must not infinite-loop (script terminates and reports ERROR)
COUNTER_T15=$(mktemp -u)
export FAKE_CLAUDE_COUNTER_FILE="$COUNTER_T15"
export FAKE_CLAUDE_MODE="always-nontransient-failure"
output_t15=$(PATH="$STUB_DIR:$PATH" timeout 60 bash "$RUN_EVALS" --filter trigger-no-canon-project --no-judge 2>&1) || true
call_count_t15=0
[[ -f "$COUNTER_T15" ]] && call_count_t15=$(cat "$COUNTER_T15")
rm -f "$COUNTER_T15"
if printf '%s\n' "$output_t15" | grep -qE '^\s*ERROR\s+trigger-no-canon-project'; then
  pass "T15a: always-nontransient-failure — correctly reported as ERROR, not retried into a false pass"
else
  fail "T15a: expected ERROR result for a non-transient failure, got: $output_t15"
fi
if [[ "$call_count_t15" -ge 1 && "$call_count_t15" -le 3 ]]; then
  pass "T15b: always-nontransient-failure — bounded call count ($call_count_t15), no infinite retry"
else
  fail "T15b: expected 1-3 stub invocations, got $call_count_t15"
fi

# T16: always-transient-failure — pins the exact total-attempt bound (1 initial
# + MAX_EVAL_RETRIES retries = 3 total for MAX_EVAL_RETRIES=2). A failure that
# is ALWAYS transient (unlike T15's non-transient case, which correctly stops
# at 1 attempt) is the only way to observe the full retry budget being spent,
# and is what catches an off-by-one in the loop's break condition.
COUNTER_T16=$(mktemp -u)
export FAKE_CLAUDE_COUNTER_FILE="$COUNTER_T16"
export FAKE_CLAUDE_MODE="always-transient-failure"
output_t16=$(PATH="$STUB_DIR:$PATH" timeout 60 bash "$RUN_EVALS" --filter trigger-no-canon-project --no-judge 2>&1) || true
call_count_t16=0
[[ -f "$COUNTER_T16" ]] && call_count_t16=$(cat "$COUNTER_T16")
rm -f "$COUNTER_T16"
if printf '%s\n' "$output_t16" | grep -qE '^\s*ERROR\s+trigger-no-canon-project'; then
  pass "T16a: always-transient-failure — exhausts retries and reports ERROR (not a false pass)"
else
  fail "T16a: expected ERROR result for an always-transient failure, got: $output_t16"
fi
if [[ "$call_count_t16" -eq 3 ]]; then
  pass "T16b: always-transient-failure — invoked exactly 3 times (1 initial + 2 retries)"
else
  fail "T16b: expected exactly 3 stub invocations (1 initial + MAX_EVAL_RETRIES=2 retries), got $call_count_t16"
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
