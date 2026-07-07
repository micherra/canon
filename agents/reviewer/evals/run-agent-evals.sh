#!/usr/bin/env bash
# Canon Reviewer Agent Eval Runner
# Runs per-agent eval cases (agents/reviewer/evals/eval-set.json by default) using the
# claude CLI in print mode. Shares its judge/vote/parallel-slot core with
# skills/canon/evals/run-evals.sh via lib/eval-core.sh (DRY — one judge, both runners).
#
# Usage: bash agents/reviewer/evals/run-agent-evals.sh [--eval-root <dir>] [--filter <id-substring>]
#          [--split <name>] [--model <model>] [--parallel] [--jobs <n>] [--dry-run]
#          [--no-judge] [--structured-judge] [--judge-votes <N>] [--emit-baseline <path>]
#
# Examples:
#   bash agents/reviewer/evals/run-agent-evals.sh                    # Run all reviewer evals
#   bash agents/reviewer/evals/run-agent-evals.sh --split holdout     # Run only holdout-split cases
#   bash agents/reviewer/evals/run-agent-evals.sh --judge-votes 3     # Majority-of-3 judging (tie → FAIL)
#   bash agents/reviewer/evals/run-agent-evals.sh --eval-root agents/reviewer/evals/holistic

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# shellcheck source=../../../skills/canon/evals/lib/eval-core.sh
source "$PROJECT_DIR/skills/canon/evals/lib/eval-core.sh"

EVAL_ROOT="$SCRIPT_DIR"
MODEL="sonnet"
FILTER=""
SPLIT_FILTER=""
VERBOSE=false
PARALLEL=false
MAX_PARALLEL_JOBS=4
DRY_RUN=false
NO_JUDGE=false
STRUCTURED_JUDGE=false
JUDGE_VOTES=1
EMIT_BASELINE=""

# Guardrail injection mode (ADR-0025): when EVAL_PLUGIN_DIR is set (by eval-runner.ts),
# pass --plugin-dir <dir> --setting-sources project to the activating claude -p run so it
# loads the rewritten guardrail artifact from the sandbox instead of the marketplace plugin.
# Default unset = current eval-surface behavior — no plugin flags added.
EVAL_PLUGIN_DIR="${EVAL_PLUGIN_DIR:-}"
if [[ -n "$EVAL_PLUGIN_DIR" ]]; then
  PLUGIN_FLAGS=(--plugin-dir "$EVAL_PLUGIN_DIR" --setting-sources project)
else
  PLUGIN_FLAGS=()
fi

while [[ $# -gt 0 ]]; do
  case $1 in
    --eval-root) EVAL_ROOT="$2"; shift 2 ;;
    --filter) FILTER="$2"; shift 2 ;;
    --split) SPLIT_FILTER="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --verbose) VERBOSE=true; shift ;;
    --parallel) PARALLEL=true; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --no-judge) NO_JUDGE=true; shift ;;
    --structured-judge) STRUCTURED_JUDGE=true; shift ;;
    --jobs)
      MAX_PARALLEL_JOBS="$2"
      if ! [[ "$MAX_PARALLEL_JOBS" =~ ^[1-9][0-9]*$ ]]; then
        echo "Error: --jobs must be a positive integer" >&2
        exit 1
      fi
      shift 2
      ;;
    --judge-votes)
      JUDGE_VOTES="$2"
      if ! [[ "$JUDGE_VOTES" =~ ^[1-9][0-9]*$ ]]; then
        echo "Error: --judge-votes must be a positive integer" >&2
        exit 1
      fi
      shift 2
      ;;
    --emit-baseline) EMIT_BASELINE="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# Resolve EVAL_ROOT relative to PROJECT_DIR when a relative path was passed.
if [[ "$EVAL_ROOT" != /* ]]; then
  EVAL_ROOT="$PROJECT_DIR/$EVAL_ROOT"
fi
EVAL_FILE="$EVAL_ROOT/eval-set.json"

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not installed." >&2
  exit 1
fi

if ! $DRY_RUN && ! command -v claude &>/dev/null; then
  echo "Error: claude CLI is required but not found." >&2
  exit 1
fi

if [[ ! -f "$EVAL_FILE" ]]; then
  echo "Error: eval file not found: $EVAL_FILE" >&2
  exit 1
fi

TMPDIR_EVALS=$(mktemp -d)
trap 'rm -rf "$TMPDIR_EVALS"' EXIT

run_agent_eval_case() {
  local id="$1"
  local stage="$2"
  local kind="$3"
  local expected="$4"
  local fixture="$5"
  local result_file="$TMPDIR_EVALS/$id.result"

  if $DRY_RUN; then
    echo "DRYRUN  $id" > "$result_file"
    return
  fi

  # Assemble the review prompt, inlining the fixture's diff + principles (mirrors
  # run-evals.sh's files_json fixture-append loop, adapted to the per-case `fixture` field).
  local full_prompt
  full_prompt=$(printf '%s\n' \
    "You are performing a Canon code review. Apply Stage 1 (Principle Compliance — using ONLY the principles provided below), Stage 1.5 (Principle-Independent Correctness Scan — reachable-input logic defects regardless of loaded principles), and Stage 2 (Code Quality, including Severity-Vocabulary Consistency) to the diff below." \
    "" \
    "For each finding, cite its principle id (or 'correctness-scan' for a Stage 1.5 finding) and severity, and name which stage it belongs to. If there are no findings, say so explicitly. End with a one-line aggregate verdict: CLEAN, WARNING, or BLOCKING." )

  if [[ -n "$fixture" && "$fixture" != "null" ]]; then
    local fixture_dir="$EVAL_ROOT/fixtures/$fixture"
    local principles_path="$fixture_dir/principles.json"
    local diff_path="$fixture_dir/diff.patch"

    if [[ -f "$principles_path" ]]; then
      local principles_content
      principles_content=$(cat "$principles_path")
      full_prompt="$full_prompt

## Principles (loaded for Stage 1)
\`\`\`json
$principles_content
\`\`\`"
    else
      echo "  WARNING: fixture file not found: $principles_path" >&2
    fi

    if [[ -f "$diff_path" ]]; then
      local diff_content
      diff_content=$(cat "$diff_path")
      full_prompt="$full_prompt

## Diff under review
\`\`\`diff
$diff_content
\`\`\`"
    else
      echo "  WARNING: fixture file not found: $diff_path" >&2
    fi
  fi

  local output=""
  local exit_code=0
  local eval_budget="1.00"
  local eval_model="$MODEL"
  local max_turns="6"

  output=$(cd "$PROJECT_DIR" && claude -p "$full_prompt" \
    --model "$eval_model" \
    --output-format text \
    --no-session-persistence \
    --allowedTools "Read Grep Glob" \
    --max-turns "$max_turns" \
    --max-budget-usd "$eval_budget" \
    "${PLUGIN_FLAGS[@]+"${PLUGIN_FLAGS[@]}"}" \
    2>&1) || exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    echo "ERROR  $id  (exit code $exit_code)" > "$result_file"
    if $VERBOSE; then
      echo "  OUTPUT: ${output:0:500}" >&2
    fi
    return
  fi

  # Truncate for judge context (avoid huge argv / prompt limits)
  local output_trunc="${output:0:3000}"

  if $NO_JUDGE; then
    echo "NOJUDGE $id" > "$result_file"
    return
  fi

  # Assemble multiline judge prompt with printf (clearer than one huge quoted string).
  local judge_prompt
  if $STRUCTURED_JUDGE; then
    judge_prompt=$(printf '%s\n' \
      "You are an eval judge. Given the following eval case and actual output, determine if the output satisfies the expected behavior." \
      "" \
      "Eval ID: ${id}" \
      "Eval Type: reviewer-stage-${stage}-${kind}" \
      "Prompt: ${full_prompt:0:1000}" \
      "Expected: ${expected}" \
      "Actual Output:" \
      "---" \
      "${output_trunc}" \
      "---" \
      "" \
      "Does the actual output satisfy the expected behavior?" \
      "Return ONLY valid JSON with keys:" \
      "  verdict: \"PASS\" or \"FAIL\"" \
      "  explanation: one sentence string" )
  else
    judge_prompt=$(printf '%s\n' \
      "You are an eval judge. Given the following eval case and actual output, determine if the output satisfies the expected behavior." \
      "" \
      "Eval ID: ${id}" \
      "Eval Type: reviewer-stage-${stage}-${kind}" \
      "Prompt: ${full_prompt:0:1000}" \
      "Expected: ${expected}" \
      "Actual Output:" \
      "---" \
      "${output_trunc}" \
      "---" \
      "" \
      "Does the actual output satisfy the expected behavior? Reply with ONLY 'PASS' or 'FAIL' on the first line, followed by a one-sentence explanation.")
  fi

  # Collect JUDGE_VOTES votes and apply majority (tie → FAIL, fail-closed).
  # parse_single_verdict, judge_first_token_is_pass, and collect_judge_votes itself are
  # sourced from lib/eval-core.sh — shared with skills/canon/evals/run-evals.sh.
  collect_judge_votes "$judge_prompt" "$JUDGE_VOTES"
  local vote_passes=$VOTE_PASSES
  local vote_fails=$VOTE_FAILS
  local last_raw_verdict="$LAST_RAW_VERDICT"

  # Majority decision (tie → FAIL)
  if (( vote_passes > vote_fails )); then
    echo "PASS   $id" > "$result_file"
  else
    # Extract explanation from the last raw verdict for the result line.
    local explanation_final=""
    if $STRUCTURED_JUDGE; then
      explanation_final=$(printf '%s\n' "$last_raw_verdict" | jq -r '.explanation // empty' 2>/dev/null || true)
      if [[ -z "$explanation_final" ]]; then
        local firstline_f
        firstline_f=$(printf '%s\n' "$last_raw_verdict" | head -n 1)
        explanation_final=$(printf '%s\n' "$firstline_f" | jq -r '.explanation // empty' 2>/dev/null || true)
      fi
    fi
    if [[ -z "$explanation_final" ]]; then
      explanation_final=$(printf '%s\n' "$last_raw_verdict" | tail -n +2 | head -1)
    fi
    echo "FAIL   $id  ($explanation_final)" > "$result_file"
  fi

  if $VERBOSE; then
    echo "  JUDGE ($id): votes=$JUDGE_VOTES passes=$vote_passes fails=$vote_fails last_verdict=${last_raw_verdict:0:200}" >&2
    echo "" >&2
  fi
}

echo "Canon Reviewer Agent Evals"
echo "=========================="
echo "Model: $MODEL"
echo "Eval root: $EVAL_ROOT"
echo "Eval file: $EVAL_FILE"
[[ -n "$FILTER" ]] && echo "Filter: $FILTER"
[[ -n "$SPLIT_FILTER" ]] && echo "Split: $SPLIT_FILTER"
if $PARALLEL; then
  echo "Mode: parallel (max jobs: $MAX_PARALLEL_JOBS)"
fi
if $DRY_RUN; then
  echo "Mode: dry-run (no model calls)"
fi
if $NO_JUDGE; then
  echo "Judge: disabled"
fi
if $STRUCTURED_JUDGE; then
  echo "Judge format: structured JSON"
fi
if [[ $JUDGE_VOTES -gt 1 ]]; then
  echo "Judge votes: $JUDGE_VOTES (majority; tie → FAIL)"
fi
echo ""

PARALLEL_PIDS=()
case_ids=()

while IFS= read -r case_json; do
  [[ -z "$case_json" ]] && continue

  id=$(jq -r '.id' <<<"$case_json")
  stage=$(jq -r '.stage // ""' <<<"$case_json")
  kind=$(jq -r '.kind // ""' <<<"$case_json")
  expected=$(jq -r '.expected_output' <<<"$case_json")
  fixture=$(jq -r '.fixture // ""' <<<"$case_json")
  case_split=$(jq -r '.split // "train"' <<<"$case_json")

  if [[ -n "$FILTER" ]] && [[ "$id" != *"$FILTER"* ]]; then
    continue
  fi

  if ! case_passes_split_filter "$case_split" "$SPLIT_FILTER"; then
    continue
  fi

  echo "Running: $id (stage $stage, $kind)..."
  case_ids+=("$id")

  if $PARALLEL; then
    wait_parallel_slot "$MAX_PARALLEL_JOBS"
    run_agent_eval_case "$id" "$stage" "$kind" "$expected" "$fixture" &
    PARALLEL_PIDS+=($!)
  else
    run_agent_eval_case "$id" "$stage" "$kind" "$expected" "$fixture"
  fi
done < <(jq -c '.evals[]' "$EVAL_FILE")

if $PARALLEL && [[ ${#PARALLEL_PIDS[@]} -gt 0 ]]; then
  echo ""
  echo "Waiting for ${#PARALLEL_PIDS[@]} parallel eval(s)..."
  for pid in "${PARALLEL_PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
fi

TOTAL=0
PASSED=0
FAILED=0
ERRORS=0
SKIPPED=0
results=()

for id in "${case_ids[@]}"; do
  TOTAL=$((TOTAL + 1))
  result_file="$TMPDIR_EVALS/$id.result"
  if [[ -f "$result_file" ]]; then
    result=$(cat "$result_file")
    results+=("$result")
    if [[ "$result" == PASS* ]]; then
      PASSED=$((PASSED + 1))
    elif [[ "$result" == ERROR* ]]; then
      ERRORS=$((ERRORS + 1))
    elif [[ "$result" == DRYRUN* || "$result" == NOJUDGE* ]]; then
      SKIPPED=$((SKIPPED + 1))
    else
      FAILED=$((FAILED + 1))
    fi
  else
    ERRORS=$((ERRORS + 1))
    results+=("ERROR  $id  (no result file)")
  fi
done

echo ""
echo "Results"
echo "======="
for r in "${results[@]}"; do
  echo "  $r"
done
echo ""
echo "Total: $TOTAL | Passed: $PASSED | Failed: $FAILED | Errors: $ERRORS | Skipped: $SKIPPED"

if [[ -n "$EMIT_BASELINE" ]]; then
  local_split_label="${SPLIT_FILTER:-all}"
  jq -n \
    --arg split "$local_split_label" \
    --argjson passed "$PASSED" \
    --argjson failed "$FAILED" \
    --argjson errors "$ERRORS" \
    --argjson skipped "$SKIPPED" \
    --argjson total "$TOTAL" \
    '{split: $split, passed: $passed, failed: $failed, errors: $errors, skipped: $skipped, total: $total}' \
    > "$EMIT_BASELINE"
fi

if [[ $FAILED -gt 0 || $ERRORS -gt 0 ]]; then
  exit 1
fi
