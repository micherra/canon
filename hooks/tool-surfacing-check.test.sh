#!/bin/bash
# Tests for tool-surfacing-check.sh (ADR-0046, dc-05)
# Run with: bash hooks/tool-surfacing-check.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/tool-surfacing-check.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

echo ""
echo "=== tool-surfacing-check.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# Fixture helpers.
# ---------------------------------------------------------------------------

# init_fixture <root>
# Creates the minimal directory scaffold the gate requires (mcp-server/src/app,
# agents/, hooks/lib/) with an empty allowlist file.
init_fixture() {
  local root="$1"
  mkdir -p "$root/mcp-server/src/app" "$root/agents" "$root/hooks/lib"
  : > "$root/hooks/lib/orchestrator-only-tools.txt"
}

# write_register_single <root> <file> <tool_name> [marker]
# `registerTool("<tool_name>", ...)` — name on the SAME line as the opener.
write_register_single() {
  local root="$1" file="$2" name="$3" marker="${4:-}"
  local trailer=""
  [[ -n "$marker" ]] && trailer="  // canon:allow-unsurfaced: $marker"
  {
    printf 'function registerX(server) {\n'
    printf '  server.registerTool(\n'
    printf '    "%s",%s\n' "$name" "$trailer"
    printf '    { description: "x", inputSchema: {} },\n'
    printf '    async () => ({}),\n'
    printf '  );\n'
    printf '}\n'
  } > "$root/mcp-server/src/app/$file"
}

# write_register_multiline <root> <file> <tool_name>
# `registerTool(\n  "<tool_name>",` — name on the line AFTER the opener,
# opener line carries nothing else (case g).
write_register_multiline() {
  local root="$1" file="$2" name="$3"
  {
    printf 'function registerX(server) {\n'
    printf '  server.registerTool(\n'
    printf '    "%s",\n' "$name"
    printf '    { description: "x", inputSchema: {} },\n'
    printf '    async () => ({}),\n'
    printf '  );\n'
    printf '}\n'
  } > "$root/mcp-server/src/app/$file"
}

# write_register_ui <root> <file> <tool_name>
# `registerToolWithUi(server, "<tool_name>", ...)` — the UI registration idiom
# (case f).
write_register_ui() {
  local root="$1" file="$2" name="$3"
  {
    printf 'function registerY(server) {\n'
    printf '  registerToolWithUi(server, "%s", {\n' "$name"
    printf '    description: "x",\n'
    printf '  });\n'
    printf '}\n'
  } > "$root/mcp-server/src/app/$file"
}

# write_agent <root> <name> <granted_tools_csv> [body_prose]
# <granted_tools_csv> = comma-separated bare tool names placed in the
# frontmatter tools: block as mcp__canon__<name>. <body_prose>, if given, is
# appended verbatim to the file body (OUTSIDE frontmatter) — used by case (e)
# to plant a false-positive mcp__canon__ mention.
write_agent() {
  local root="$1" name="$2" tools_csv="$3" body="${4:-}"
  mkdir -p "$root/agents"
  {
    printf -- '---\nname: %s\nmodel: sonnet\ntools:\n  - Read\n' "$name"
    if [[ -n "$tools_csv" ]]; then
      local IFS=','
      for t in $tools_csv; do printf -- '  - mcp__canon__%s\n' "$t"; done
    fi
    printf -- '---\n\nbody\n'
    if [[ -n "$body" ]]; then
      printf -- '%s\n' "$body"
    fi
  } > "$root/agents/$name.md"
}

# write_allowlist <root> <tools_csv>
write_allowlist() {
  local root="$1" tools_csv="$2"
  mkdir -p "$root/hooks/lib"
  {
    printf '# Orchestrator-only tools\n'
    printf '\n'
    if [[ -n "$tools_csv" ]]; then
      local IFS=','
      for t in $tools_csv; do printf '%s\n' "$t"; done
    fi
  } > "$root/hooks/lib/orchestrator-only-tools.txt"
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

echo "-- (a) tool granted in an agent tools: block -> exit 0 --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_single "$FIX" register-a.ts granted_tool
  write_agent "$FIX" engineer "granted_tool"
  run_gate 0 "granted tool -> exit 0" "$FIX"
  rm -rf "$FIX"
}

echo "-- (b) tool listed in the allowlist -> exit 0 --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_single "$FIX" register-b.ts orchestrator_tool
  write_agent "$FIX" engineer ""
  write_allowlist "$FIX" "orchestrator_tool"
  run_gate 0 "allowlisted tool -> exit 0" "$FIX"
  rm -rf "$FIX"
}

echo "-- (c) tool with inline canon:allow-unsurfaced marker -> exit 0 --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_single "$FIX" register-c.ts marked_tool "not yet wired"
  write_agent "$FIX" engineer ""
  run_gate 0 "inline-marker tool -> exit 0" "$FIX"
  rm -rf "$FIX"
}

echo "-- (d) synthetic unsurfaced tool -> exit 2 naming it --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_single "$FIX" register-d.ts orphan_tool
  write_agent "$FIX" engineer ""
  run_gate_out 2 "orphan_tool" "unsurfaced tool -> exit 2 names it" "$FIX"
  rm -rf "$FIX"
}

echo "-- (e) body-prose mcp__canon__ mention outside tools: block does NOT count -> still exit 2 --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_single "$FIX" register-e.ts ghost_tool
  write_agent "$FIX" reviewer "" "See mcp__canon__ghost_tool for the placeholder pattern."
  run_gate_out 2 "ghost_tool" "body-prose mention is not a grant -> exit 2" "$FIX"
  rm -rf "$FIX"
}

echo "-- (f) registerToolWithUi-only tool is captured --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_ui "$FIX" register-f.ts ui_tool
  write_agent "$FIX" engineer ""
  run_gate_out 2 "ui_tool" "registerToolWithUi tool unsurfaced -> exit 2 names it" "$FIX"

  FIX2=$(mktemp -d)
  init_fixture "$FIX2"
  write_register_ui "$FIX2" register-f.ts ui_tool
  write_agent "$FIX2" engineer ""
  write_allowlist "$FIX2" "ui_tool"
  run_gate 0 "registerToolWithUi tool allowlisted -> exit 0" "$FIX2"
  rm -rf "$FIX" "$FIX2"
}

echo "-- (g) multiline registerTool( name-on-next-line is captured --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_multiline "$FIX" register-g.ts multiline_tool
  write_agent "$FIX" engineer ""
  run_gate_out 2 "multiline_tool" "multiline registerTool( captured -> exit 2 names it" "$FIX"

  FIX2=$(mktemp -d)
  init_fixture "$FIX2"
  write_register_multiline "$FIX2" register-g.ts multiline_tool
  write_agent "$FIX2" engineer "multiline_tool"
  run_gate 0 "multiline registerTool( granted -> exit 0" "$FIX2"
  rm -rf "$FIX" "$FIX2"
}

echo "-- (h) non-directory worktree_path -> fail-closed exit 2 --"
{
  run_gate_out 2 "not a directory" "non-directory arg -> fail-closed exit 2" "/nonexistent/worktree/path"
}

echo "-- (i) allowlist comment/blank lines are ignored --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_single "$FIX" register-i.ts commented_tool
  write_agent "$FIX" engineer ""
  {
    printf '# commented_tool\n'
    printf '\n'
    printf '   \n'
  } > "$FIX/hooks/lib/orchestrator-only-tools.txt"
  run_gate_out 2 "commented_tool" "commented allowlist line does not classify -> exit 2" "$FIX"
  rm -rf "$FIX"
}

echo "-- (j) empty REG_FILES (no register-*.ts, no create-server.ts) -> fail-closed exit 2, not bash-3.2 unbound-variable crash --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_agent "$FIX" engineer ""
  run_gate_out 2 "no MCP registration files found" "empty REG_FILES -> exit 2 with CANON diagnostic" "$FIX"
  rm -rf "$FIX"
}

echo "-- (k) empty AGENT_FILES (no agents/*.md) -> fail-closed exit 2, not bash-3.2 unbound-variable crash --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_single "$FIX" register-k.ts some_tool
  run_gate_out 2 "no agents/*.md files found" "empty AGENT_FILES -> exit 2 with CANON diagnostic" "$FIX"
  rm -rf "$FIX"
}

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
