#!/usr/bin/env bash
# Canon Skill Eval Runner
# Runs eval cases from eval-set.json using the claude CLI in print mode.
# Usage: bash skills/canon/evals/run-evals.sh [--filter <id-substring>] [--model <model>] [--parallel] [--jobs <n>] [--dry-run] [--no-judge] [--structured-judge]
#
# Examples:
#   bash skills/canon/evals/run-evals.sh                    # Run all evals
#   bash skills/canon/evals/run-evals.sh --filter trigger   # Run only trigger evals
#   bash skills/canon/evals/run-evals.sh --model sonnet     # Use sonnet model
#   bash skills/canon/evals/run-evals.sh --parallel         # Run cases in parallel (max 4)
#   bash skills/canon/evals/run-evals.sh --parallel --jobs 8

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EVAL_FILE="$SCRIPT_DIR/eval-set.json"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

MODEL="sonnet"
FILTER=""
VERBOSE=false
PARALLEL=false
MAX_PARALLEL_JOBS=4
DRY_RUN=false
NO_JUDGE=false
STRUCTURED_JUDGE=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --filter) FILTER="$2"; shift 2 ;;
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
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not installed." >&2
  exit 1
fi

if ! $DRY_RUN && ! command -v claude &>/dev/null; then
  echo "Error: claude CLI is required but not found." >&2
  exit 1
fi

TMPDIR_EVALS=$(mktemp -d)
trap 'rm -rf "$TMPDIR_EVALS"' EXIT

# Bash 3.2–compatible: wait for a free parallel slot (pid queue without ${arr[@]:1}).
wait_parallel_slot() {
  local max="$1"
  while (( ${#PARALLEL_PIDS[@]} >= max )); do
    wait "${PARALLEL_PIDS[0]}" || true
    local i new_pids=()
    for ((i = 1; i < ${#PARALLEL_PIDS[@]}; i++)); do
      new_pids+=("${PARALLEL_PIDS[i]}")
    done
    PARALLEL_PIDS=("${new_pids[@]}")
  done
}

# First word of judge line, stripped of markdown/whitespace, uppercased — must be PASS for success.
judge_first_token_is_pass() {
  local line verdict="$1"
  line=$(printf '%s\n' "$verdict" | head -n 1)
  line=$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;s/^\*\*//;s/\*\*$//')
  local token
  token=$(echo "$line" | awk '{print $1}' | tr -cd 'A-Za-z' | tr '[:lower:]' '[:upper:]')
  [[ "$token" == PASS ]]
}

run_eval_case() {
  local id="$1"
  local type="$2"
  local prompt="$3"
  local expected="$4"
  local should_trigger="$5"
  local files_json="$6"
  local result_file="$TMPDIR_EVALS/$id.result"

  if $DRY_RUN; then
    echo "DRYRUN  $id" > "$result_file"
    return
  fi

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
  local eval_budget="1.00"
  local eval_model="$MODEL"
  local max_turns="6"

  if [[ "$type" == "trigger" ]]; then
    max_turns="4"
    if [[ "$should_trigger" == "false" ]]; then
      output=$(cd /tmp && claude -p "$full_prompt" \
        --model "$eval_model" \
        --output-format text \
        --no-session-persistence \
        --allowedTools "Read Grep Glob" \
        --max-turns "$max_turns" \
        --max-budget-usd "$eval_budget" \
        2>&1) || exit_code=$?
    else
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
      "Eval Type: ${type}" \
      "Prompt: ${prompt}" \
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
      "Eval Type: ${type}" \
      "Prompt: ${prompt}" \
      "Expected: ${expected}" \
      "Actual Output:" \
      "---" \
      "${output_trunc}" \
      "---" \
      "" \
      "Does the actual output satisfy the expected behavior? Reply with ONLY 'PASS' or 'FAIL' on the first line, followed by a one-sentence explanation.")
  fi

  local verdict=""
  verdict=$(cd /tmp && claude -p "$judge_prompt" \
    --model haiku \
    --output-format text \
    --no-session-persistence \
    --disable-slash-commands \
    --max-turns 1 \
    --max-budget-usd 0.05 \
    2>&1) || true

  if $STRUCTURED_JUDGE; then
    local verdict_json verdict_token explanation
    verdict_token=""
    explanation=""
    verdict_json=$(printf '%s\n' "$verdict" | head -n 1)

    verdict_token=$(printf '%s\n' "$verdict_json" | jq -r '.verdict // empty' 2>/dev/null || true)
    explanation=$(printf '%s\n' "$verdict_json" | jq -r '.explanation // empty' 2>/dev/null || true)

    if [[ "$verdict_token" == "PASS" ]]; then
      echo "PASS   $id" > "$result_file"
    elif [[ "$verdict_token" == "FAIL" ]]; then
      echo "FAIL   $id  ($explanation)" > "$result_file"
    else
      # Fallback for cases where the judge doesn't return JSON.
      if judge_first_token_is_pass "$verdict"; then
        echo "PASS   $id" > "$result_file"
      else
        local explanation_fallback
        explanation_fallback=$(printf '%s\n' "$verdict" | tail -n +2 | head -1)
        echo "FAIL   $id  ($explanation_fallback)" > "$result_file"
      fi
    fi
  else
    if judge_first_token_is_pass "$verdict"; then
      echo "PASS   $id" > "$result_file"
    else
      local explanation
      explanation=$(printf '%s\n' "$verdict" | tail -n +2 | head -1)
      echo "FAIL   $id  ($explanation)" > "$result_file"
    fi
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
echo ""

PARALLEL_PIDS=()
case_ids=()

while IFS= read -r case_json; do
  [[ -z "$case_json" ]] && continue

  id=$(jq -r '.id' <<<"$case_json")
  type=$(jq -r '.type' <<<"$case_json")
  prompt=$(jq -r '.prompt' <<<"$case_json")
  expected=$(jq -r '.expected_output' <<<"$case_json")
  should_trigger=$(jq -r '.should_trigger // "true"' <<<"$case_json")
  files_json=$(jq -c '.files // []' <<<"$case_json")

  if [[ -n "$FILTER" ]] && [[ "$id" != *"$FILTER"* ]]; then
    continue
  fi

  echo "Running: $id ($type)..."
  case_ids+=("$id")

  if $PARALLEL; then
    wait_parallel_slot "$MAX_PARALLEL_JOBS"
    run_eval_case "$id" "$type" "$prompt" "$expected" "$should_trigger" "$files_json" &
    PARALLEL_PIDS+=($!)
  else
    run_eval_case "$id" "$type" "$prompt" "$expected" "$should_trigger" "$files_json"
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

if [[ $FAILED -gt 0 || $ERRORS -gt 0 ]]; then
  exit 1
fi
