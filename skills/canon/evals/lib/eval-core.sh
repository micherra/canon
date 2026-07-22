#!/usr/bin/env bash
# Canon Eval Core — shared judge/vote/parallel-slot machinery for eval runners.
# Sourced by skills/canon/evals/run-evals.sh and agents/reviewer/evals/run-agent-evals.sh.
# No top-level `set -e` here — entry scripts own `set -euo pipefail`.

# Shared bound for is_transient_eval_failure retries, used by both eval
# runners' SUT-invocation retry loops — 1 initial attempt + up to this many
# retries, matching root CLAUDE.md's own "retry up to 3 times" convention for
# transient claude-CLI failures. A single source of truth (rather than each
# runner declaring its own copy) avoids the two retry loops drifting to
# different bounds. A sourcing script may override by reassigning after
# `source`, before the retry loop runs.
MAX_EVAL_RETRIES=2

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

# Strip a markdown code fence (```json ... ``` or bare ``` ... ```) from judge output,
# discarding any prose before/after the fenced block. The judge fences its JSON verdict
# by default; an unstripped fence made every fenced-JSON verdict unparseable by jq,
# silently falling through to judge_first_token_is_pass's first-token check (which sees
# the fence marker "```json" as the first token, not the verdict) — a false FAIL even
# when the judge returned "verdict": "PASS". No-op (modulo CRLF normalization) when the
# text contains no fence, so unfenced verdicts are unaffected.
strip_markdown_fences() {
  local text="$1"
  text="${text//$'\r'/}"
  if printf '%s\n' "$text" | grep -qE '^[[:space:]]*```'; then
    printf '%s\n' "$text" | sed -n '/^[[:space:]]*```/,/^[[:space:]]*```/p' | sed '1d;$d'
  else
    printf '%s\n' "$text"
  fi
}

# Parse a single raw judge response into PASS or FAIL. Reads $STRUCTURED_JUDGE from the
# caller's environment (a global the entry script sets before sourcing this lib) — promoted
# here from run-evals.sh's formerly-nested definition; behavior is unchanged.
# Outputs "PASS" or "FAIL" to stdout.
parse_single_verdict() {
  local raw="$1"
  local candidate
  candidate=$(strip_markdown_fences "$raw")
  if $STRUCTURED_JUDGE; then
    local vt
    vt=$(printf '%s\n' "$candidate" | jq -r '.verdict // empty' 2>/dev/null || true)
    if [[ -z "$vt" ]]; then
      local firstline
      firstline=$(printf '%s\n' "$candidate" | head -n 1)
      vt=$(printf '%s\n' "$firstline" | jq -r '.verdict // empty' 2>/dev/null || true)
    fi
    if [[ "$vt" == "PASS" ]]; then
      echo "PASS"
    elif [[ "$vt" == "FAIL" ]]; then
      echo "FAIL"
    else
      if judge_first_token_is_pass "$candidate"; then echo "PASS"; else echo "FAIL"; fi
    fi
  else
    if judge_first_token_is_pass "$candidate"; then echo "PASS"; else echo "FAIL"; fi
  fi
}

# True (0) iff the given claude-CLI error output represents a transient,
# resource-contention failure worth retrying, rather than a genuine crash,
# auth failure, or config error. Scoped narrowly to the exact signature
# empirically reproduced under parallel eval load (see implementation summary):
# running several `claude -p` invocations concurrently increases the odds any
# one of them needs more turns than usual to reach the same answer, so it hits
# --max-turns and exits 1 even though the identical prompt reliably finishes
# within budget when run without contention. Deliberately does NOT match
# "Exceeded USD budget" — that failure is deterministic (retrying would fail
# identically) and retrying it would just burn budget again for nothing.
is_transient_eval_failure() {
  local output="$1"
  [[ "$output" == *"Error: Reached max turns"* ]]
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
