#!/usr/bin/env bash
# Canon Eval Core — shared judge/vote/parallel-slot machinery for eval runners.
# Sourced by skills/canon/evals/run-evals.sh and agents/reviewer/evals/run-agent-evals.sh.
# No top-level `set -e` here — entry scripts own `set -euo pipefail`.

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

# Parse a single raw judge response into PASS or FAIL. Reads $STRUCTURED_JUDGE from the
# caller's environment (a global the entry script sets before sourcing this lib) — promoted
# here from run-evals.sh's formerly-nested definition; behavior is unchanged.
# Outputs "PASS" or "FAIL" to stdout.
parse_single_verdict() {
  local raw="$1"
  if $STRUCTURED_JUDGE; then
    local vt
    vt=$(printf '%s\n' "$raw" | jq -r '.verdict // empty' 2>/dev/null || true)
    if [[ -z "$vt" ]]; then
      local firstline
      firstline=$(printf '%s\n' "$raw" | head -n 1)
      vt=$(printf '%s\n' "$firstline" | jq -r '.verdict // empty' 2>/dev/null || true)
    fi
    if [[ "$vt" == "PASS" ]]; then
      echo "PASS"
    elif [[ "$vt" == "FAIL" ]]; then
      echo "FAIL"
    else
      if judge_first_token_is_pass "$raw"; then echo "PASS"; else echo "FAIL"; fi
    fi
  else
    if judge_first_token_is_pass "$raw"; then echo "PASS"; else echo "FAIL"; fi
  fi
}

# Collect N judge votes for a prompt and apply majority (tie -> FAIL, fail-closed).
# Bash 3.2 compatible: no associative arrays; integer counters via globals the caller reads.
# Sets: VOTE_PASSES, VOTE_FAILS, LAST_RAW_VERDICT.
collect_judge_votes() {
  local judge_prompt="$1"
  local votes="$2"
  VOTE_PASSES=0
  VOTE_FAILS=0
  LAST_RAW_VERDICT=""
  local vote_num=0
  while (( vote_num < votes )); do
    local raw_v=""
    raw_v=$(cd /tmp && claude -p "$judge_prompt" \
      --model haiku \
      --output-format text \
      --no-session-persistence \
      --disable-slash-commands \
      --max-turns 1 \
      --max-budget-usd 0.05 \
      2>&1) || true
    LAST_RAW_VERDICT="$raw_v"
    local single
    single=$(parse_single_verdict "$raw_v")
    if [[ "$single" == "PASS" ]]; then
      VOTE_PASSES=$((VOTE_PASSES + 1))
    else
      VOTE_FAILS=$((VOTE_FAILS + 1))
    fi
    vote_num=$((vote_num + 1))
  done
}

# True (0) iff case_split matches split_filter, or split_filter is empty (no filter active).
case_passes_split_filter() {
  local case_split="$1" split_filter="$2"
  [[ -z "$split_filter" || "$case_split" == "$split_filter" ]]
}
