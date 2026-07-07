#!/bin/bash
# Tests for rule-scope-parity-check.sh (sug_RULEPARITY1)
# Run with: bash hooks/rule-scope-parity-check.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/rule-scope-parity-check.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

echo ""
echo "=== rule-scope-parity-check.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# Fixture helpers.
# ---------------------------------------------------------------------------

# write_rule <root> <id> <scope_agents_yaml>
# <scope_agents_yaml> is inserted verbatim under `scope:` (may be empty to omit).
write_rule() {
  local root="$1" id="$2" scope_block="$3"
  mkdir -p "$root/rules"
  {
    printf -- '---\nid: %s\ntitle: %s\nseverity: rule\n' "$id" "$id"
    if [[ -n "$scope_block" ]]; then
      printf -- 'scope:\n%s\n' "$scope_block"
    fi
    printf -- 'tags: [x]\n---\n\nbody\n'
  } > "$root/rules/$id.md"
}

# write_agent <root> <name> <rules_csv>
# rules_csv = comma-separated rule ids to place in the agent's rules: list.
write_agent() {
  local root="$1" name="$2" rules_csv="$3"
  mkdir -p "$root/agents"
  {
    printf -- '---\nname: %s\nmodel: sonnet\nrules:\n' "$name"
    if [[ -n "$rules_csv" ]]; then
      local IFS=','
      for r in $rules_csv; do printf -- '  - %s\n' "$r"; done
    fi
    printf -- '---\n\nbody\n'
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

echo "-- (a) scope-all rule wired to every agent -> exit 0 --"
{
  FIX=$(mktemp -d)
  write_rule "$FIX" agent-context-check "  agents: all"
  write_agent "$FIX" architect "agent-context-check"
  write_agent "$FIX" engineer "agent-context-check"
  write_agent "$FIX" evaluator "agent-context-check"
  run_gate 0 "scope-all fully wired -> exit 0" "$FIX"
  rm -rf "$FIX"
}

echo "-- (b) scope-all rule missing from one agent -> exit 2 naming it --"
{
  FIX=$(mktemp -d)
  write_rule "$FIX" agent-context-check "  agents: all"
  write_agent "$FIX" architect "agent-context-check"
  write_agent "$FIX" engineer "agent-context-check"
  write_agent "$FIX" evaluator ""   # missing the rule
  run_gate_out 2 "agent-context-check" "missing scope-all wiring -> exit 2 names rule" "$FIX"
  run_gate_out 2 "evaluator" "missing scope-all wiring -> exit 2 names agent" "$FIX"
  rm -rf "$FIX"
}

echo "-- (c) rule with no scope.agents (dispatch rule) -> ignored, exit 0 --"
{
  FIX=$(mktemp -d)
  # No scope block at all — the orphaned-dispatch-rule shape.
  write_rule "$FIX" agent-compound-task-decomposition ""
  write_agent "$FIX" architect ""
  write_agent "$FIX" engineer ""
  run_gate 0 "rule without scope.agents is ignored -> exit 0" "$FIX"
  rm -rf "$FIX"
}

echo "-- (d) explicit-list scope -> only named agents required --"
{
  FIX=$(mktemp -d)
  # Rule required only for architect + engineer, NOT evaluator.
  write_rule "$FIX" agent-batch-tools "  agents: [architect, engineer]"
  write_agent "$FIX" architect "agent-batch-tools"
  write_agent "$FIX" engineer "agent-batch-tools"
  write_agent "$FIX" evaluator ""   # NOT in the list -> not required -> OK
  run_gate 0 "explicit-list satisfied by named agents only -> exit 0" "$FIX"

  # Now break it: architect (named) is missing the rule.
  FIX2=$(mktemp -d)
  write_rule "$FIX2" agent-batch-tools "  agents: [architect, engineer]"
  write_agent "$FIX2" architect ""   # named but missing
  write_agent "$FIX2" engineer "agent-batch-tools"
  write_agent "$FIX2" evaluator ""
  run_gate_out 2 "architect" "explicit-list missing from named agent -> exit 2" "$FIX2"
  rm -rf "$FIX" "$FIX2"
}

echo "-- (e) multi-line scope.agents list is parsed -> exit 2 on gap --"
{
  FIX=$(mktemp -d)
  write_rule "$FIX" agent-batch-tools "  agents:
    - architect
    - engineer"
  write_agent "$FIX" architect "agent-batch-tools"
  write_agent "$FIX" engineer ""   # missing
  run_gate_out 2 "engineer" "multi-line list parsed, gap flagged -> exit 2" "$FIX"
  rm -rf "$FIX"
}

echo "-- (f) README.md / non-frontmatter name: is NOT treated as an agent -> exit 0 --"
{
  FIX=$(mktemp -d)
  write_rule "$FIX" agent-context-check "  agents: all"
  write_agent "$FIX" architect "agent-context-check"
  # A README with a `name:` line OUTSIDE frontmatter must be excluded from the
  # agent set (else scope:all would demand it carry the rule).
  mkdir -p "$FIX/agents"
  printf -- '# Canon Agents\n\nProse.\n\n```yaml\nname: canon-{role}\n```\n' \
    > "$FIX/agents/README.md"
  run_gate 0 "README name: outside frontmatter excluded -> exit 0" "$FIX"
  rm -rf "$FIX"
}

echo "-- (g) non-directory worktree_path -> fail-closed exit 2 --"
{
  run_gate_out 2 "not a directory" "non-directory arg -> fail-closed exit 2" "/nonexistent/worktree/path"
}

echo "-- (h) scope-all with inline exclude: excluded agent exempt; non-excluded still required --"
{
  # Excluded agent (evaluator) legitimately lacks the rule -> exit 0.
  FIX=$(mktemp -d)
  write_rule "$FIX" agent-metrics-before-return "  agents: all
  exclude: [evaluator]"
  write_agent "$FIX" architect "agent-metrics-before-return"
  write_agent "$FIX" engineer "agent-metrics-before-return"
  write_agent "$FIX" evaluator ""   # excluded -> legitimately exempt
  run_gate 0 "inline exclude: excluded agent exempt -> exit 0" "$FIX"

  # A NON-excluded agent still missing the rule -> exit 2 naming it.
  FIX2=$(mktemp -d)
  write_rule "$FIX2" agent-metrics-before-return "  agents: all
  exclude: [evaluator]"
  write_agent "$FIX2" architect ""   # NOT excluded, missing -> violation
  write_agent "$FIX2" engineer "agent-metrics-before-return"
  write_agent "$FIX2" evaluator ""   # excluded -> exempt
  run_gate_out 2 "architect" "inline exclude: non-excluded missing -> exit 2 names it" "$FIX2"
  rm -rf "$FIX" "$FIX2"
}

echo "-- (i) scope-all with multi-line exclude list is parsed -> excluded agent exempt --"
{
  FIX=$(mktemp -d)
  write_rule "$FIX" agent-context-check "  agents: all
  exclude:
    - evaluator"
  write_agent "$FIX" architect "agent-context-check"
  write_agent "$FIX" engineer "agent-context-check"
  write_agent "$FIX" evaluator ""   # excluded via multi-line list -> exempt
  run_gate 0 "multi-line exclude: excluded agent exempt -> exit 0" "$FIX"
  rm -rf "$FIX"
}

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
