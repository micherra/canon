#!/bin/bash
# Tests for context-manifest-gate.sh
# Run with: bash hooks/context-manifest-gate.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/context-manifest-gate.sh"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

echo ""
echo "=== context-manifest-gate.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# Drift-matrix helpers — drive the real builder/checker (--root script)
# directly rather than the shell wrapper, per PLAN §4: prefer the --root
# script for the drift matrix, reserve the end-to-end wrapper invocation for
# the arg-handling + fresh cases against the real repo worktree (below).
# ---------------------------------------------------------------------------

# check_script <expected_exit> <root> [description]
check_script() {
  local expected_exit="$1"
  local root="$2"
  local description="${3:-check}"

  local actual_exit=0
  (cd "$REPO_ROOT/mcp-server" && npx tsx scripts/regen-context-manifest.ts --root "$root" --check) \
    >/dev/null 2>&1 </dev/null || actual_exit=$?

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

# check_script_with_output <expected_exit> <expected_pattern> <root> [description]
check_script_with_output() {
  local expected_exit="$1"
  local expected_pattern="$2"
  local root="$3"
  local description="${4:-check output}"

  local actual_exit=0
  local output
  output=$(cd "$REPO_ROOT/mcp-server" && npx tsx scripts/regen-context-manifest.ts --root "$root" --check 2>&1 </dev/null) \
    || actual_exit=$?

  local exit_ok=true
  local output_ok=true
  [[ "$actual_exit" -eq "$expected_exit" ]] || exit_ok=false
  echo "$output" | grep -qF "$expected_pattern" || output_ok=false

  if [[ "$exit_ok" == "true" ]] && [[ "$output_ok" == "true" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    if [[ "$exit_ok" == "false" ]]; then
      echo "        expected exit=$expected_exit, got exit=$actual_exit"
    fi
    if [[ "$output_ok" == "false" ]]; then
      echo "        expected output containing: $expected_pattern"
      echo "        actual output: $output"
    fi
    FAIL=$((FAIL + 1))
  fi
}

# make_fixture_corpus <dir>
# Builds a minimal fixture corpus + plugin.json, then generates its manifest
# via the REAL builder (write mode) — no second hashing implementation.
make_fixture_corpus() {
  local dir="$1"
  mkdir -p "$dir/agents" "$dir/templates" "$dir/.claude-plugin"
  printf '{"version":"1.0.0"}\n' > "$dir/.claude-plugin/plugin.json"
  printf '# Agent\ncontent\n' > "$dir/agents/agent.md"
  printf '# Template\ncontent\n' > "$dir/templates/template.md"
  (cd "$REPO_ROOT/mcp-server" && npx tsx scripts/regen-context-manifest.ts --root "$dir") >/dev/null </dev/null
}

echo "-- Drift matrix (--root script; dc-01, dc-02, dc-03, dc-06) --"

echo "-- fresh: right after generating --"
{
  FIX=$(mktemp -d)
  make_fixture_corpus "$FIX"
  check_script 0 "$FIX" "fresh manifest -> exit 0"
  rm -rf "$FIX"
}

echo "-- stale-added: new corpus file --"
{
  FIX=$(mktemp -d)
  make_fixture_corpus "$FIX"
  printf '# New\ncontent\n' > "$FIX/templates/new.md"
  check_script_with_output 1 "new.md" "$FIX" "added file -> non-zero, names new.md"
  check_script_with_output 1 "cd mcp-server && npm run regen:context-manifest" "$FIX" "added file -> message includes fix command"
  rm -rf "$FIX"
}

echo "-- stale-removed: deleted corpus file --"
{
  FIX=$(mktemp -d)
  make_fixture_corpus "$FIX"
  rm "$FIX/agents/agent.md"
  check_script_with_output 1 "agents/agent.md" "$FIX" "removed file -> non-zero, names agent.md"
  rm -rf "$FIX"
}

echo "-- stale-edited: edited corpus file --"
{
  FIX=$(mktemp -d)
  make_fixture_corpus "$FIX"
  printf 'edited\n' >> "$FIX/agents/agent.md"
  check_script_with_output 1 "agents/agent.md" "$FIX" "edited file -> non-zero, names agent.md"
  rm -rf "$FIX"
}

echo ""
echo "-- Wrapper end-to-end: hooks/context-manifest-gate.sh (dc-04, dc-05, dc-07) --"

echo "-- fresh (real repo worktree) --"
{
  actual_exit=0
  (cd "$REPO_ROOT" && bash "$GATE" "$REPO_ROOT") >/dev/null 2>&1 </dev/null || actual_exit=$?
  if [[ "$actual_exit" -eq 0 ]]; then
    echo "  PASS: wrapper on real repo worktree -> exit 0 (fresh)"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: wrapper on real repo worktree"
    echo "        expected exit=0, got exit=$actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

echo "-- uncommitted context-manifest.json -> fail-closed exit 2 with message --"
{
  MANIFEST="$REPO_ROOT/context-manifest.json"
  BACKUP=$(mktemp)
  cp "$MANIFEST" "$BACKUP"
  trap 'cp "$BACKUP" "$MANIFEST"; rm -f "$BACKUP"' EXIT
  printf '\n' >> "$MANIFEST"

  actual_exit=0
  output=$(cd "$REPO_ROOT" && bash "$GATE" "$REPO_ROOT" 2>&1 </dev/null) || actual_exit=$?

  cp "$BACKUP" "$MANIFEST"
  rm -f "$BACKUP"
  trap - EXIT

  if [[ "$actual_exit" -eq 2 ]] && echo "$output" | grep -qF "uncommitted changes"; then
    echo "  PASS: uncommitted context-manifest.json -> fail-closed exit 2 with message"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: uncommitted context-manifest.json handling"
    echo "        expected exit=2 with uncommitted-changes message, got exit=$actual_exit"
    echo "        output: $output"
    FAIL=$((FAIL + 1))
  fi
}

echo "-- arg handling: non-directory worktree_path -> fail-closed exit 2 --"
{
  actual_exit=0
  output=$(bash "$GATE" "/nonexistent/worktree/path" 2>&1 </dev/null) || actual_exit=$?
  if [[ "$actual_exit" -eq 2 ]] && echo "$output" | grep -qF "worktree_path not a directory"; then
    echo "  PASS: non-directory worktree_path -> fail-closed exit 2 with message"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: non-directory worktree_path handling"
    echo "        expected exit=2 with failed-closed message, got exit=$actual_exit"
    echo "        output: $output"
    FAIL=$((FAIL + 1))
  fi
}

echo "-- arg handling: dir lacking mcp-server/ -> fail-closed exit 2 --"
{
  BARE=$(mktemp -d)
  actual_exit=0
  output=$(bash "$GATE" "$BARE" 2>&1 </dev/null) || actual_exit=$?
  if [[ "$actual_exit" -eq 2 ]] && echo "$output" | grep -qF "mcp-server not found"; then
    echo "  PASS: dir without mcp-server/ -> fail-closed exit 2 with message"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: dir without mcp-server/ handling"
    echo "        expected exit=2 with failed-closed message, got exit=$actual_exit"
    echo "        output: $output"
    FAIL=$((FAIL + 1))
  fi
  rm -rf "$BARE"
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
