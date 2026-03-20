#!/usr/bin/env bash
# Canon Skill Eval Runner
# Runs eval cases from eval-set.json using the claude CLI in print mode.
# Usage: bash skills/canon/evals/run-evals.sh [--filter <id-substring>] [--model <model>] [--parallel]
#
# Examples:
#   bash skills/canon/evals/run-evals.sh                    # Run all evals
#   bash skills/canon/evals/run-evals.sh --filter trigger   # Run only trigger evals
#   bash skills/canon/evals/run-evals.sh --model sonnet     # Use sonnet model
#   bash skills/canon/evals/run-evals.sh --parallel         # Run cases in parallel

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVAL_FILE="$SCRIPT_DIR/eval-set.json"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

MODEL="sonnet"
FILTER=""
VERBOSE=false
PARALLEL=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --filter) FILTER="$2"; shift 2 ;;
    --model) MODEL="$2"; shift 2 ;;
    --verbose) VERBOSE=true; shift ;;
    --parallel) PARALLEL=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not installed." >&2
  exit 1
fi

if ! command -v claude &>/dev/null; then
  echo "Error: claude CLI is required but not found." >&2
  exit 1
fi

TMPDIR_EVALS=$(mktemp -d)
trap 'rm -rf "$TMPDIR_EVALS"' EXIT

run_eval_case() {
  local id="$1"
  local type="$2"
  local prompt="$3"
  local expected="$4"
  local should_trigger="$5"
  local files_json="$6"
  local result_file="$TMPDIR_EVALS/$id.result"

  # Build the prompt with fixture file contents if specified
  local full_prompt="$prompt"
  if [[ "$files_json" != "null" && "$files_json" != "[]" ]]; then
    local file_count
    file_count=$(echo "$files_json" | jq -r 'length')
    for ((i = 0; i < file_count; i++)); do
      local file_ref
      file_ref=$(echo "$files_json" | jq -r ".[$i]")
      local file_path="$SCRIPT_DIR/$file_ref"
      if [[ -f "$file_path" ]]; then
        local file_content
        file_content=$(cat "$file_path")
        full_prompt="$full_prompt

\`\`\`typescript
$file_content
\`\`\`"
      else
        echo "  WARNING: fixture file not found: $file_path" >&2
      fi
    done
  fi

  local output=""
  local exit_code=0
  local eval_budget="0.25"
  local eval_model="$MODEL"
  local max_turns="3"

  if [[ "$type" == "trigger" ]]; then
    # Trigger evals need less budget and can use haiku for speed
    eval_budget="0.15"
    max_turns="2"
    if [[ "$should_trigger" == "false" ]]; then
      # For should_trigger=false, run outside the Canon project (in /tmp)
      output=$(cd /tmp && claude -p "$full_prompt" \
        --model "$eval_model" \
        --output-format text \
        --no-session-persistence \
        --allowedTools "Read Grep Glob" \
        --max-turns "$max_turns" \
        --max-budget-usd "$eval_budget" \
        2>&1) || exit_code=$?
    else
      # For should_trigger=true, run inside the Canon project
      output=$(cd "$PROJECT_DIR" && claude -p "$full_prompt" \
        --model "$eval_model" \
        --output-format text \
        --no-session-persistence \
        --allowedTools "Read Grep Glob" \
        --max-turns "$max_turns" \
        --max-budget-usd "$eval_budget" \
        2>&1) || exit_code=$?
    fi
  else
    # Quality evals always run inside the Canon project
    output=$(cd "$PROJECT_DIR" && claude -p "$full_prompt" \
      --model "$eval_model" \
      --output-format text \
      --no-session-persistence \
      --allowedTools "Read Grep Glob" \
      --max-turns "$max_turns" \
      --max-budget-usd "$eval_budget" \
      2>&1) || exit_code=$?
  fi

  if [[ $exit_code -ne 0 ]]; then
    echo "ERROR  $id  (exit code $exit_code)" > "$result_file"
    if $VERBOSE; then
      echo "  OUTPUT: ${output:0:500}" >&2
    fi
    return
  fi

  # Judge the output against expected behavior using claude as judge
  local judge_prompt="You are an eval judge. Given the following eval case and actual output, determine if the output satisfies the expected behavior.

Eval ID: $id
Eval Type: $type
Prompt: $prompt
Expected: $expected
Actual Output:
---
${output:0:3000}
---

Does the actual output satisfy the expected behavior? Reply with ONLY 'PASS' or 'FAIL' on the first line, followed by a one-sentence explanation."

  local verdict=""
  verdict=$(cd /tmp && claude -p "$judge_prompt" \
    --model haiku \
    --output-format text \
    --no-session-persistence \
    --disable-slash-commands \
    --max-turns 1 \
    --max-budget-usd 0.05 \
    2>&1) || true

  local first_line
  first_line=$(echo "$verdict" | head -1 | tr -d '[:space:]')

  if [[ "$first_line" == "PASS" ]]; then
    echo "PASS   $id" > "$result_file"
  else
    local explanation
    explanation=$(echo "$verdict" | tail -n +2 | head -1)
    echo "FAIL   $id  ($explanation)" > "$result_file"
  fi

  if $VERBOSE; then
    echo "  JUDGE ($id): $verdict" >&2
    echo "" >&2
  fi
}

echo "Canon Skill Evals"
echo "=================="
echo "Model: $MODEL"
echo "Eval file: $EVAL_FILE"
[[ -n "$FILTER" ]] && echo "Filter: $FILTER"
$PARALLEL && echo "Mode: parallel"
echo ""

# Read and iterate eval cases
eval_count=$(jq '.evals | length' "$EVAL_FILE")
pids=()
case_ids=()

for ((i = 0; i < eval_count; i++)); do
  id=$(jq -r ".evals[$i].id" "$EVAL_FILE")
  type=$(jq -r ".evals[$i].type" "$EVAL_FILE")
  prompt=$(jq -r ".evals[$i].prompt" "$EVAL_FILE")
  expected=$(jq -r ".evals[$i].expected_output" "$EVAL_FILE")
  should_trigger=$(jq -r ".evals[$i].should_trigger // \"true\"" "$EVAL_FILE")
  files_json=$(jq -c ".evals[$i].files // []" "$EVAL_FILE")

  # Apply filter
  if [[ -n "$FILTER" ]] && [[ "$id" != *"$FILTER"* ]]; then
    continue
  fi

  echo "Running: $id ($type)..."
  case_ids+=("$id")

  if $PARALLEL; then
    run_eval_case "$id" "$type" "$prompt" "$expected" "$should_trigger" "$files_json" &
    pids+=($!)
  else
    run_eval_case "$id" "$type" "$prompt" "$expected" "$should_trigger" "$files_json"
  fi
done

# Wait for parallel jobs
if $PARALLEL && [[ ${#pids[@]} -gt 0 ]]; then
  echo ""
  echo "Waiting for ${#pids[@]} parallel eval(s)..."
  for pid in "${pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
fi

# Collect results from files
TOTAL=0
PASSED=0
FAILED=0
ERRORS=0
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
echo "Total: $TOTAL | Passed: $PASSED | Failed: $FAILED | Errors: $ERRORS"

if [[ $FAILED -gt 0 || $ERRORS -gt 0 ]]; then
  exit 1
fi
