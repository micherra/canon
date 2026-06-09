#!/usr/bin/env bash
# hooks/lint.sh — Run shellcheck on all hook shell scripts.
#
# Skips:
#   - *.test.sh   (test files may use patterns shellcheck flags)
#   - test-helpers.sh  (shared test helper)
#
# Suppressions applied to all files:
#   SC1091 — not following sourced files (hooks source from relative paths)
#   SC2001 — see if you can use ${var//...} (sed used for regex patterns)
#   SC2016 — expressions in single quotes (false positive for embedded JS)
#
# NOTE for new hook authors: these global suppressions mean the above checks
# will NOT fire in your script, even if your code legitimately violates them.
# Review each suppression for your specific script. If the suppressed check
# would catch a real issue in your code, use an inline disable only where
# needed (# shellcheck disable=SCXXXX) instead of relying on this global list.
#
# Per-file inline suppressions (# shellcheck disable=...) are also honored.
#
# Usage: bash hooks/lint.sh
# Exit 0: all files pass. Exit 1: any file fails or shellcheck not installed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v shellcheck >/dev/null 2>&1; then
  echo "ERROR: shellcheck is not installed." >&2
  echo "Install it with: brew install shellcheck  (macOS)" >&2
  echo "  or: apt-get install shellcheck  (Debian/Ubuntu)" >&2
  exit 1
fi

FAILED=0
FILE_COUNT=0

while IFS= read -r file; do
  FILE_COUNT=$(( FILE_COUNT + 1 ))
  if ! shellcheck -e SC1091,SC2001,SC2016 "$file"; then
    FAILED=$(( FAILED + 1 ))
  fi
done < <(find "$SCRIPT_DIR" -name "*.sh" ! -name "*.test.sh" ! -name "test-helpers.sh" | sort) # sort: deterministic order for reproducible output across runs

# ── Install-faithfulness checks ──────────────────────────────────────────────
# These checks flag tracked files that silently change an install's runtime
# behaviour on a non-maintainer machine. They run after shellcheck so a single
# invocation of lint.sh covers both shell-lint and install safety.
#
# REPO_ROOT: resolve from SCRIPT_DIR so the checks target the correct repo
# regardless of the caller's cwd. SCRIPT_DIR is hooks/ → parent is repo root.
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Check 1 — shipped toolchain pins (#361)
# Any tracked .tool-versions, .nvmrc, .node-version, or *mise*.toml ships into
# plugin installs and can override the ambient Node version via asdf/mise.
# Drive off git ls-files (gitignored paths do not ship and must not be flagged).
check_toolchain_pins() {
  local pin_found=0
  while IFS= read -r tracked; do
    [[ -z "$tracked" ]] && continue
    echo "ERROR: $tracked: toolchain pin ships into plugin installs and overrides ambient Node via asdf/mise (exit 126 class — #361). Pin the Node version in CI (.github setup-node) only; do not track this file." >&2
    pin_found=$(( pin_found + 1 ))
  done < <(git -C "$REPO_ROOT" ls-files '.tool-versions' '.nvmrc' '.node-version' '*mise*.toml' 2>/dev/null)
  return "$pin_found"
}

# Check 2 — ${CLAUDE_PLUGIN_ROOT} in .mcp.json args (#356)
# Claude Code does NOT perform variable substitution inside the args array when
# loading .mcp.json as a project config — the token resolves to a literal string
# or the ':-.'-default value ('.'), booting from the user's cwd.
# command and env positions are explicitly ALLOWED (substitution works there).
# Requires jq; if absent, print a skip notice and do not hard-fail.
check_mcp_json_args_token() {
  local mcp_json="$REPO_ROOT/.mcp.json"
  if [[ ! -f "$mcp_json" ]]; then
    return 0
  fi
  if ! command -v jq >/dev/null 2>&1; then
    echo "NOTICE: hooks/lint.sh: jq not found — skipping .mcp.json args token check (Check 2, #356). Install jq to enable this gate." >&2
    return 0
  fi
  # Extract all args[] elements from all mcpServers and check for the token.
  # We match ${CLAUDE_PLUGIN_ROOT and ${CLAUDE_PLUGIN_DATA to catch the :-.
  # default form too. env and command keys are NOT checked (they are safe).
  local bad_count
  bad_count=$(jq -r '
    .mcpServers // {} |
    to_entries[].value.args // [] |
    .[] |
    select(contains("${CLAUDE_PLUGIN_ROOT") or contains("${CLAUDE_PLUGIN_DATA"))
  ' "$mcp_json" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$bad_count" -gt 0 ]]; then
    echo 'ERROR: .mcp.json: ${CLAUDE_PLUGIN_ROOT} is not substituted inside the args array when this file loads as a project config — it resolves to a literal token / the '"'"'.'"'"' default, booting from the user'"'"'s cwd (#356). Use the BASH_SOURCE self-resolving launcher; keep plugin-root tokens in command/env only.' >&2
    return 1
  fi
  return 0
}

if ! check_toolchain_pins; then
  FAILED=$(( FAILED + 1 ))
fi

if ! check_mcp_json_args_token; then
  FAILED=$(( FAILED + 1 ))
fi

if [[ $FAILED -gt 0 ]]; then
  echo ""
  echo "shellcheck: $FAILED of $FILE_COUNT file(s) failed." >&2
  exit 1
fi

echo "shellcheck: $FILE_COUNT file(s) passed."
exit 0
