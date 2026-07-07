#!/bin/bash
# Tests for principle-id-citation-check.sh (sug_PHANTOMID1)
# Run with: bash hooks/principle-id-citation-check.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/principle-id-citation-check.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

echo ""
echo "=== principle-id-citation-check.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# Fixture helpers — build an ephemeral corpus (resolution set + scan targets).
# ---------------------------------------------------------------------------

# seed_id <root> <subdir-under-principles> <id>
seed_id() {
  local root="$1" sub="$2" id="$3"
  mkdir -p "$root/principles/$sub"
  printf -- '---\nid: %s\ntitle: %s\nseverity: rule\n---\n\nbody\n' "$id" "$id" \
    > "$root/principles/$sub/$id.md"
}

# seed_rule_id <root> <id>  (rules/ ids are part of the resolution set too)
seed_rule_id() {
  local root="$1" id="$2"
  mkdir -p "$root/rules"
  printf -- '---\nid: %s\ntitle: %s\nseverity: rule\n---\n\nbody\n' "$id" "$id" \
    > "$root/rules/$id.md"
}

# write_agent <root> <name> <body>
write_agent() {
  local root="$1" name="$2" body="$3"
  mkdir -p "$root/agents"
  {
    printf -- '---\nname: %s\n---\n\n' "$name"
    printf -- '%s\n' "$body"
  } > "$root/agents/$name.md"
}

run_gate() {
  local expected_exit="$1" description="$2"
  shift 2
  local actual_exit=0
  bash "$GATE" "$@" >/dev/null 2>&1 || actual_exit=$?
  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

run_gate_out() {
  local expected_exit="$1" pattern="$2" description="$3"
  shift 3
  local actual_exit=0 output
  output=$(bash "$GATE" "$@" 2>&1) || actual_exit=$?
  local ok=true
  [[ "$actual_exit" -eq "$expected_exit" ]] || ok=false
  echo "$output" | grep -qF "$pattern" || ok=false
  if [[ "$ok" == "true" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit + pattern '$pattern', got exit=$actual_exit"
    echo "        output: $output"
    FAIL=$((FAIL + 1))
  fi
}

run_gate_no_out() {
  local expected_exit="$1" no_pattern="$2" description="$3"
  shift 3
  local actual_exit=0 output
  output=$(bash "$GATE" "$@" 2>&1) || actual_exit=$?
  local ok=true
  [[ "$actual_exit" -eq "$expected_exit" ]] || ok=false
  if echo "$output" | grep -qF "$no_pattern"; then ok=false; fi
  if [[ "$ok" == "true" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit and NO '$no_pattern', got exit=$actual_exit"
    echo "        output: $output"
    FAIL=$((FAIL + 1))
  fi
}

echo "-- (a) only-resolving loaded citations -> exit 0 --"
{
  FIX=$(mktemp -d)
  seed_id "$FIX" strong-opinions simplicity-first
  seed_id "$FIX" strong-opinions errors-are-values
  write_agent "$FIX" reviewer "- If \`simplicity-first\` is loaded: check for over-engineering
- If \`errors-are-values\` is loaded: check error handling"
  run_gate 0 "all cited ids resolve -> exit 0" "$FIX"
  rm -rf "$FIX"
}

echo "-- (b) seeded unshipped 'foo-bar' loaded citation -> exit 2 --"
{
  FIX=$(mktemp -d)
  seed_id "$FIX" strong-opinions simplicity-first
  write_agent "$FIX" reviewer "- If \`foo-bar\` is loaded: do something"
  run_gate_out 2 "foo-bar" "unshipped foo-bar cited as loaded -> exit 2 naming it" "$FIX"
  rm -rf "$FIX"
}

echo "-- (c) pre-fix shape: BOTH explicit-contracts AND thin-handlers flagged -> exit 2 --"
{
  FIX=$(mktemp -d)
  seed_id "$FIX" strong-opinions simplicity-first
  seed_id "$FIX" strong-opinions naming-reveals-intent
  seed_id "$FIX" strong-opinions errors-are-values
  # Reproduce the pre-fix reviewer.md idioms verbatim in spirit.
  write_agent "$FIX" reviewer "- If \`simplicity-first\` is loaded: check for over-engineering
- If \`naming-reveals-intent\` is loaded: scrutinize naming
- If \`errors-are-values\` is loaded: check error handling
- If \`thin-handlers\` is loaded: check for business logic creeping into handlers

Even though \`explicit-contracts\` is loaded, this is still a generic style issue."
  run_gate_out 2 "thin-handlers" "pre-fix shape flags thin-handlers" "$FIX"
  run_gate_out 2 "explicit-contracts" "pre-fix shape flags explicit-contracts" "$FIX"
  rm -rf "$FIX"
}

echo "-- (d) canon:allow-unshipped-principle-id opt-out -> exit 0 --"
{
  FIX=$(mktemp -d)
  seed_id "$FIX" strong-opinions simplicity-first
  write_agent "$FIX" reviewer "- If \`future-principle\` is loaded: do X <!-- canon:allow-unshipped-principle-id: downstream conditional -->"
  run_gate 0 "opt-out marker suppresses unshipped citation -> exit 0" "$FIX"
  rm -rf "$FIX"
}

echo "-- (e) non-principle backtick token NOT in a loaded clause -> not flagged --"
{
  FIX=$(mktemp -d)
  seed_id "$FIX" strong-opinions simplicity-first
  # \`ts-ignore\` is principle-SHAPED but appears with no 'loaded' word on the line.
  write_agent "$FIX" reviewer "- Any \`ts-ignore\` finding is blocking (project convention).
- If \`simplicity-first\` is loaded: check over-engineering"
  run_gate 0 "ts-ignore outside a loaded clause -> not flagged (exit 0)" "$FIX"
  run_gate_no_out 0 "ts-ignore" "ts-ignore not named in output" "$FIX"
  rm -rf "$FIX"
}

echo "-- (f) resolution set includes rules/ ids -> exit 0 --"
{
  FIX=$(mktemp -d)
  seed_rule_id "$FIX" agent-context-check
  write_agent "$FIX" reviewer "- If \`agent-context-check\` is loaded: verify context"
  run_gate 0 "rules/ id resolves -> exit 0" "$FIX"
  rm -rf "$FIX"
}

echo "-- (g) non-directory worktree_path -> fail-closed exit 2 --"
{
  run_gate_out 2 "not a directory" "non-directory arg -> fail-closed exit 2" "/nonexistent/worktree/path"
}

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
