#!/bin/bash
# Tests for tool-surfacing-check.sh (ADR-0048, dc-05)
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

# write_register_ui_multiline <root> <file> <tool_name>
# `registerToolWithUi(server,\n  "<tool_name>", ...)` — name on the line AFTER
# the opener (case l).
write_register_ui_multiline() {
  local root="$1" file="$2" name="$3"
  {
    printf 'function registerY(server) {\n'
    printf '  registerToolWithUi(server,\n'
    printf '    "%s", {\n' "$name"
    printf '    description: "x",\n'
    printf '  });\n'
    printf '}\n'
  } > "$root/mcp-server/src/app/$file"
}

# write_register_ui_split_before_server <root> <file> <tool_name> [other_name]
# `registerToolWithUi(\n  server,\n  "<tool_name>", ...)` — opener split
# BEFORE `server` (the Codex P2 repro: neither the `registerTool(` branch nor
# the same-line `registerToolWithUi(server,` branch matches the opener line).
# When [other_name] is given, a second, normally-parsed `registerTool(` sits
# ahead of it in the same file so the total extraction is non-zero and the
# vacuous-pass tripwire alone cannot catch the miss (case p).
write_register_ui_split_before_server() {
  local root="$1" file="$2" name="$3" other="${4:-}"
  {
    if [[ -n "$other" ]]; then
      printf 'function registerX(server) {\n'
      printf '  server.registerTool(\n'
      printf '    "%s",\n' "$other"
      printf '    { description: "x", inputSchema: {} },\n'
      printf '    async () => ({}),\n'
      printf '  );\n'
      printf '}\n'
    fi
    printf 'function registerY(server) {\n'
    printf '  registerToolWithUi(\n'
    printf '    server,\n'
    printf '    "%s", {\n' "$name"
    printf '    description: "x",\n'
    printf '  });\n'
    printf '}\n'
  } > "$root/mcp-server/src/app/$file"
}

# write_register_packed_same_line <root> <file> <name_a> <name_b>
# Two `registerTool(` openers on the SAME source line. The AST extractor
# walks every CallExpression independent of line packing, so both openers
# resolve correctly on their own (case q, root-fix — this used to require
# the now-removed opener-accounting tripwire as a textual backstop).
write_register_packed_same_line() {
  local root="$1" file="$2" name_a="$3" name_b="$4"
  {
    printf 'function registerX(server) {\n'
    printf '  server.registerTool("%s", h1); server.registerTool("%s", h2);\n' "$name_a" "$name_b"
    printf '}\n'
  } > "$root/mcp-server/src/app/$file"
}

# write_register_commented <root> <file> <commented_name> <real_name>
# `// server.registerTool("<commented_name>", {})` — the name text appears
# ONLY inside a line comment, alongside one real registration. Comments are
# not CallExpression nodes, so the AST extractor must NOT emit
# <commented_name> (root-fix for the line-parser's fail-CLOSED over-match on
# comment text — case r).
write_register_commented() {
  local root="$1" file="$2" commented_name="$3" real_name="$4"
  {
    printf 'function registerX(server) {\n'
    printf '  // server.registerTool("%s", {})\n' "$commented_name"
    printf '  server.registerTool("%s", { description: "x" }, h);\n' "$real_name"
    printf '}\n'
  } > "$root/mcp-server/src/app/$file"
}

# write_register_string_mention <root> <file> <mentioned_name> <real_name>
# `const doc = "... registerToolWithUi(\"<mentioned_name>\") ...";` — the
# registerToolWithUi( token appears ONLY inside a string literal, alongside
# one real registration. A string literal is not a CallExpression, so the
# AST extractor must NOT emit <mentioned_name> (root-fix for the
# line-parser's fail-CLOSED over-match on string-literal text — case s).
write_register_string_mention() {
  local root="$1" file="$2" mentioned_name="$3" real_name="$4"
  {
    printf 'function registerX(server) {\n'
    printf '  const doc = "... registerToolWithUi(\\"%s\\") ...";\n' "$mentioned_name"
    printf '  server.registerTool("%s", { description: "x" }, h);\n' "$real_name"
    printf '}\n'
  } > "$root/mcp-server/src/app/$file"
}

# write_register_dynamic <root> <file>
# Registration is entirely dynamic — no `registerTool(` / `registerToolWithUi(`
# idiom appears anywhere in the file, so zero tool names can be extracted from
# it (case m: vacuous-pass tripwire).
write_register_dynamic() {
  local root="$1" file="$2"
  {
    printf 'function registerX(server) {\n'
    printf '  const TOOLS = buildDynamicToolSet();\n'
    printf '  TOOLS.forEach((t) => registerDynamicTool(server, t));\n'
    printf '}\n'
  } > "$root/mcp-server/src/app/$file"
}

# write_register_bad_arg <root> <file>
# `registerTool(camelCaseName, { description: "foo" })` — the name arg is an
# unquoted identifier; a later quoted token ("foo") must NOT be mistaken for
# the tool name (case n).
write_register_bad_arg() {
  local root="$1" file="$2"
  {
    printf 'function registerX(server) {\n'
    printf '  server.registerTool(camelCaseName, { description: "foo" });\n'
    printf '}\n'
  } > "$root/mcp-server/src/app/$file"
}

# write_register_sneaky <root> <file>
# `registerTool(\n  sneakyTool,\n  "get_context",\n)` — an unquoted name
# argument followed a few lines later by a quoted, already-granted tool name.
# The unbounded forward-scan bug would mis-capture "get_context" and let
# sneakyTool evade the gate entirely (case o).
write_register_sneaky() {
  local root="$1" file="$2"
  {
    printf 'function registerSneaky(server) {\n'
    printf '  server.registerTool(\n'
    printf '    sneakyTool,\n'
    printf '    "get_context",\n'
    printf '  );\n'
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

echo "-- (l) registerToolWithUi multiline name-on-next-line is captured --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_ui_multiline "$FIX" register-l.ts ui_multiline_tool
  write_agent "$FIX" engineer ""
  run_gate_out 2 "ui_multiline_tool" "registerToolWithUi multiline captured -> exit 2 names it" "$FIX"

  FIX2=$(mktemp -d)
  init_fixture "$FIX2"
  write_register_ui_multiline "$FIX2" register-l.ts ui_multiline_tool
  write_agent "$FIX2" engineer "ui_multiline_tool"
  run_gate 0 "registerToolWithUi multiline granted -> exit 0" "$FIX2"
  rm -rf "$FIX" "$FIX2"
}

echo "-- (m) only dynamic/non-literal registration -> exit 2 (vacuous-pass tripwire) --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_dynamic "$FIX" register-m.ts
  write_agent "$FIX" engineer ""
  run_gate_out 2 "zero tool names extracted" "dynamic-only registration -> exit 2 vacuous-pass tripwire" "$FIX"
  rm -rf "$FIX"
}

echo "-- (n) registerTool(camelCaseName, { description: \"foo\" }) -> exit 2 unresolvable, not a spurious 'foo' tool --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_bad_arg "$FIX" register-n.ts
  write_agent "$FIX" engineer ""
  run_gate_out 2 "unresolvable registration" "unquoted name arg -> exit 2 unresolvable" "$FIX"
  rm -rf "$FIX"
}

echo "-- (o) registerTool(sneakyTool, ... \"get_context\" ...) does not evade via mis-captured get_context --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_sneaky "$FIX" register-o.ts
  write_agent "$FIX" engineer "get_context"
  run_gate_out 2 "unresolvable registration" "sneaky unquoted name does not evade via later quoted token" "$FIX"
  rm -rf "$FIX"
}

echo "-- (p) registerToolWithUi( split BEFORE server (Codex P2 repro) is captured, not silently skipped --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_ui_split_before_server "$FIX" register-p.ts split_tool granted_tool
  write_agent "$FIX" engineer "granted_tool"
  run_gate 2 "split-before-server ui tool unsurfaced + other tool granted -> exit 2 (not silent 0)" "$FIX"
  rm -rf "$FIX"
}

echo "-- (p2) registerToolWithUi( split BEFORE server, legitimately granted -> exit 0 (no false positive) --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_ui_split_before_server "$FIX" register-p2.ts split_tool granted_tool
  write_agent "$FIX" engineer "split_tool,granted_tool"
  run_gate 0 "split-before-server ui tool granted -> exit 0" "$FIX"
  rm -rf "$FIX"
}

echo "-- (q) two registerTool( openers packed on one source line -> BOTH resolved by the AST, normal grant semantics apply --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_packed_same_line "$FIX" register-q.ts packed_a packed_b
  write_agent "$FIX" engineer "packed_a,packed_b"
  run_gate 0 "packed same-line openers, both granted -> exit 0 (root-fix, no opener-accounting workaround needed)" "$FIX"
  rm -rf "$FIX"
}

echo "-- (q2) two registerTool( openers packed on one source line, one ungranted -> exit 2 naming it (not a silent miss) --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_packed_same_line "$FIX" register-q2.ts packed_a packed_b
  write_agent "$FIX" engineer "packed_a"
  run_gate_out 2 "packed_b" "packed same-line openers, second ungranted -> exit 2 names it" "$FIX"
  rm -rf "$FIX"
}

echo "-- (r) commented-out registerTool( is NOT counted -> exit 0 when the real tool is granted (fail-CLOSED over-match fix) --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_commented "$FIX" register-r.ts commented_out_tool real_tool_r
  write_agent "$FIX" engineer "real_tool_r"
  run_gate 0 "commented registerTool( not counted -> exit 0" "$FIX"
  rm -rf "$FIX"
}

echo "-- (s) registerToolWithUi( mention inside a string literal is NOT counted -> exit 0 when the real tool is granted (fail-CLOSED over-match fix) --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_string_mention "$FIX" register-s.ts string_mention_tool real_tool_s
  write_agent "$FIX" engineer "real_tool_s"
  run_gate 0 "string-literal mention not counted -> exit 0" "$FIX"
  rm -rf "$FIX"
}

echo "-- (t) node absent from PATH -> fail-closed exit 2 --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_single "$FIX" register-t.ts some_tool
  write_agent "$FIX" engineer "some_tool"

  # Strip node from PATH by keeping only dirs that do NOT contain a "node" binary
  NO_NODE_PATH=""
  IFS=: read -ra path_dirs <<< "$PATH"
  for d in "${path_dirs[@]}"; do
    if [[ ! -x "$d/node" ]]; then
      NO_NODE_PATH="${NO_NODE_PATH:+$NO_NODE_PATH:}$d"
    fi
  done

  _t_exit=0
  PATH="$NO_NODE_PATH" bash "$GATE" "$FIX" >/dev/null 2>&1 || _t_exit=$?
  if [[ "$_t_exit" -eq 2 ]]; then
    echo "  PASS: node absent -> exit 2 (fail-closed)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: node absent -> expected exit 2, got exit $_t_exit"
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$FIX"
}

echo "-- (u) tool-surfacing-extract.mjs helper errors (stub exits 1) -> fail-closed exit 2 --"
{
  FIX=$(mktemp -d)
  init_fixture "$FIX"
  write_register_single "$FIX" register-u.ts some_tool
  write_agent "$FIX" engineer "some_tool"

  STUB_DIR=$(mktemp -d)
  mkdir -p "$STUB_DIR/mcp-server/scripts"
  cat > "$STUB_DIR/mcp-server/scripts/tool-surfacing-extract.mjs" <<'STUB'
#!/usr/bin/env node
process.stderr.write("CANON ERROR [stub]: simulated helper failure\n");
process.exit(1);
STUB

  _u_exit=0
  TOOL_SURFACING_HELPER_PATH="$STUB_DIR/mcp-server/scripts/tool-surfacing-extract.mjs" \
    bash "$GATE" "$FIX" >/dev/null 2>&1 || _u_exit=$?
  if [[ "$_u_exit" -eq 2 ]]; then
    echo "  PASS: helper error -> exit 2 (fail-closed)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: helper error -> expected exit 2, got exit $_u_exit"
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$FIX" "$STUB_DIR"
}

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
