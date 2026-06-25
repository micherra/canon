#!/usr/bin/env bash
# Tests for run-evals.sh split/votes/baseline flags.
# Bash 3.2 compatible. Runs without model calls (--dry-run / --no-judge only).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVALS_DIR="$SCRIPT_DIR/.."
RUN_EVALS="$EVALS_DIR/run-evals.sh"
EVAL_SET="$EVALS_DIR/eval-set.json"

PASS_COUNT=0
FAIL_COUNT=0

pass() { echo "PASS: $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail() { echo "FAIL: $1" >&2; FAIL_COUNT=$((FAIL_COUNT + 1)); }

# ---------------------------------------------------------------------------
# T1: --split holdout --dry-run lists ONLY the 3 holdout ids
# ---------------------------------------------------------------------------
output=$(bash "$RUN_EVALS" --split holdout --dry-run 2>&1)
# Collect DRYRUN lines (may be indented with spaces in Results section)
holdout_ids=$(printf '%s\n' "$output" | grep 'DRYRUN' | awk '{print $2}' | sort || true)
expected_count=$(jq '[.evals[] | select(.split == "holdout")] | length' "$EVAL_SET")
actual_count=0
if [[ -n "$holdout_ids" ]]; then
  actual_count=$(printf '%s\n' "$holdout_ids" | grep -c . || true)
fi

if [[ "$actual_count" -eq "$expected_count" && "$actual_count" -gt 0 ]]; then
  pass "T1: --split holdout lists exactly $expected_count holdout case(s)"
else
  fail "T1: expected $expected_count holdout case(s), got $actual_count. Output: $output"
fi

# Verify every listed id actually has split==holdout in eval-set.json
all_match=true
while IFS= read -r id; do
  [[ -z "$id" ]] && continue
  split_val=$(jq -r --arg id "$id" '.evals[] | select(.id == $id) | .split // "train"' "$EVAL_SET")
  if [[ "$split_val" != "holdout" ]]; then
    fail "T1b: id $id listed under --split holdout but has split='$split_val'"
    all_match=false
  fi
done <<< "$holdout_ids"
if $all_match; then
  pass "T1b: all listed ids have split==holdout in eval-set.json"
fi

# ---------------------------------------------------------------------------
# T2: --split train --dry-run excludes holdout cases
# ---------------------------------------------------------------------------
output_train=$(bash "$RUN_EVALS" --split train --dry-run 2>&1)
train_ids=$(printf '%s\n' "$output_train" | grep 'DRYRUN' | awk '{print $2}' || true)
holdout_in_train=0
while IFS= read -r id; do
  [[ -z "$id" ]] && continue
  split_val=$(jq -r --arg id "$id" '.evals[] | select(.id == $id) | .split // "train"' "$EVAL_SET")
  if [[ "$split_val" == "holdout" ]]; then
    holdout_in_train=$((holdout_in_train + 1))
  fi
done <<< "$train_ids"

if [[ "$holdout_in_train" -eq 0 ]]; then
  pass "T2: --split train excludes holdout cases"
else
  fail "T2: --split train included $holdout_in_train holdout case(s)"
fi

# ---------------------------------------------------------------------------
# T3: no --split runs ALL cases (15 original + 3 holdout = 18)
# ---------------------------------------------------------------------------
output_all=$(bash "$RUN_EVALS" --dry-run 2>&1)
all_count=$(printf '%s\n' "$output_all" | grep 'DRYRUN' | wc -l | tr -d '[:space:]' || echo "0")
total_in_file=$(jq '.evals | length' "$EVAL_SET")

if [[ "$all_count" -eq "$total_in_file" ]]; then
  pass "T3: no --split runs all $total_in_file case(s)"
else
  fail "T3: expected $total_in_file total cases, got $all_count"
fi

# ---------------------------------------------------------------------------
# T4: eval-set.json parses and every .split ∈ {train,val,holdout}
# ---------------------------------------------------------------------------
if jq . "$EVAL_SET" >/dev/null 2>&1; then
  pass "T4a: eval-set.json is valid JSON"
else
  fail "T4a: eval-set.json failed to parse"
fi

bad_splits=$(jq -r '.evals[] | select(.split != null) | select(.split != "train" and .split != "val" and .split != "holdout") | .id + ":" + .split' "$EVAL_SET" || true)
if [[ -z "$bad_splits" ]]; then
  pass "T4b: all split values ∈ {train,val,holdout}"
else
  fail "T4b: invalid split values found: $bad_splits"
fi

# ---------------------------------------------------------------------------
# T5: --emit-baseline writes valid JSON with expected keys
# ---------------------------------------------------------------------------
baseline_tmp=$(mktemp /tmp/ec-baseline-test-XXXXXX.json)
trap 'rm -f "$baseline_tmp"' EXIT

bash "$RUN_EVALS" --emit-baseline "$baseline_tmp" --dry-run >/dev/null 2>&1

if jq . "$baseline_tmp" >/dev/null 2>&1; then
  pass "T5a: --emit-baseline writes valid JSON"
else
  fail "T5a: --emit-baseline output is not valid JSON"
fi

for key in split passed failed errors skipped total; do
  val=$(jq -r --arg k "$key" '.[$k] // "MISSING"' "$baseline_tmp" 2>/dev/null || echo "MISSING")
  if [[ "$val" != "MISSING" ]]; then
    pass "T5b: baseline.json has key '$key' = $val"
  else
    fail "T5b: baseline.json missing key '$key'"
  fi
done

# ---------------------------------------------------------------------------
# T6: --emit-baseline with --split holdout writes split="holdout" in JSON
# ---------------------------------------------------------------------------
baseline_holdout=$(mktemp /tmp/ec-baseline-holdout-XXXXXX.json)
trap 'rm -f "$baseline_holdout"' EXIT

bash "$RUN_EVALS" --split holdout --emit-baseline "$baseline_holdout" --dry-run >/dev/null 2>&1

if jq . "$baseline_holdout" >/dev/null 2>&1; then
  split_field=$(jq -r '.split' "$baseline_holdout")
  if [[ "$split_field" == "holdout" ]]; then
    pass "T6: --emit-baseline with --split holdout sets split=holdout in JSON"
  else
    fail "T6: expected split=holdout, got '$split_field'"
  fi
else
  fail "T6: --emit-baseline holdout output is not valid JSON"
fi

# ---------------------------------------------------------------------------
# T7: majority-vote logic — pure bash unit test (extracted helper)
# ---------------------------------------------------------------------------
# Inline the majority-vote function and test it
majority_verdict() {
  local votes="$1"   # space-separated list of PASS/FAIL
  local passes=0
  local fails=0
  local v
  for v in $votes; do
    if [[ "$v" == "PASS" ]]; then
      passes=$((passes + 1))
    else
      fails=$((fails + 1))
    fi
  done
  if (( passes > fails )); then
    echo "PASS"
  else
    echo "FAIL"
  fi
}

# 2-PASS-1-FAIL → PASS
result=$(majority_verdict "PASS PASS FAIL")
if [[ "$result" == "PASS" ]]; then
  pass "T7a: majority(2-PASS-1-FAIL) = PASS"
else
  fail "T7a: majority(2-PASS-1-FAIL) expected PASS, got $result"
fi

# 1-PASS-2-FAIL → FAIL
result=$(majority_verdict "PASS FAIL FAIL")
if [[ "$result" == "FAIL" ]]; then
  pass "T7b: majority(1-PASS-2-FAIL) = FAIL"
else
  fail "T7b: majority(1-PASS-2-FAIL) expected FAIL, got $result"
fi

# 1-1 tie → FAIL (fail-closed)
result=$(majority_verdict "PASS FAIL")
if [[ "$result" == "FAIL" ]]; then
  pass "T7c: majority(1-1 tie) = FAIL (fail-closed)"
else
  fail "T7c: majority(1-1 tie) expected FAIL, got $result"
fi

# 1 vote PASS → PASS (N=1 backwards-compat)
result=$(majority_verdict "PASS")
if [[ "$result" == "PASS" ]]; then
  pass "T7d: majority(single PASS) = PASS"
else
  fail "T7d: majority(single PASS) expected PASS, got $result"
fi

# 1 vote FAIL → FAIL
result=$(majority_verdict "FAIL")
if [[ "$result" == "FAIL" ]]; then
  pass "T7e: majority(single FAIL) = FAIL"
else
  fail "T7e: majority(single FAIL) expected FAIL, got $result"
fi

# ---------------------------------------------------------------------------
# T8: --judge-votes validation — non-integer value exits 1
# ---------------------------------------------------------------------------
if bash "$RUN_EVALS" --judge-votes 0 --dry-run 2>/dev/null; then
  fail "T8a: --judge-votes 0 should exit 1 but exited 0"
else
  pass "T8a: --judge-votes 0 exits non-zero (invalid)"
fi

if bash "$RUN_EVALS" --judge-votes abc --dry-run 2>/dev/null; then
  fail "T8b: --judge-votes abc should exit 1 but exited 0"
else
  pass "T8b: --judge-votes abc exits non-zero (invalid)"
fi

# Valid value should not cause immediate error (exits 0 on dry-run)
if bash "$RUN_EVALS" --judge-votes 3 --dry-run >/dev/null 2>&1; then
  pass "T8c: --judge-votes 3 is accepted"
else
  fail "T8c: --judge-votes 3 should be accepted but exited non-zero"
fi

# ---------------------------------------------------------------------------
# T9: backward compat — cases without .split default to train
# ---------------------------------------------------------------------------
# Verify no case is silently skipped when no --split is given
no_split_cases=$(jq '[.evals[] | select(.split == null)] | length' "$EVAL_SET")
output_nosplit=$(bash "$RUN_EVALS" --dry-run 2>&1)
nosplit_dryrun=$(printf '%s\n' "$output_nosplit" | grep 'DRYRUN' | wc -l | tr -d '[:space:]' || echo "0")
if [[ "$nosplit_dryrun" -eq "$total_in_file" ]]; then
  pass "T9: backward compat — no --split runs all $total_in_file cases (including $no_split_cases with no split field)"
else
  fail "T9: backward compat failed — got $nosplit_dryrun cases, expected $total_in_file"
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
