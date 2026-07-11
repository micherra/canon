#!/bin/bash
# tool-surfacing-check.sh — Deterministic fail-closed tool-surfacing
# "dead-affordance" gate. (ADR-0048)
#
# Invoked by the verify contract (not as a hooks.json PreToolUse hook).
# Signature: bash hooks/tool-surfacing-check.sh [worktree_path]
#
# Like context-manifest-gate.sh / rule-scope-parity-check.sh, this gate takes
# NO <base_commit> — tool surfacing is a WHOLE-TREE property (is every
# registered MCP tool either granted to some agent or explicitly classified as
# orchestrator-only/internal). It recomputes over the current corpus; it never
# reads a git diff. The GRANTED/ALLOWLIST/VIOLATIONS stages run OFFLINE (pure
# awk/grep over agent frontmatter — no MCP daemon, no JSON extraction /
# git-token work, so canon-hook-lib.sh is deliberately NOT sourced — noted as
# a deliberate non-use, not an omission); the REGISTERED extraction stage
# delegates to a TypeScript-compiler-API helper
# (mcp-server/scripts/tool-surfacing-extract.mjs, ADR-0048 rethink) — see
# PROBE-PARSER.md for the empirical validation.
#
# Run from the worktree root, OR pass the worktree as the optional trailing
# worktree_path arg (watch_CCCCCCCCCCCC2) — the gate resolves its source tree
# from that arg (or CWD when absent), not from git.
#
# Classification model (DEC-01, ADR-0048) — a registered tool `t` is
# surfaced/legitimate if ANY of:
#   1. `t` appears as `mcp__canon__<t>` in some agents/*.md frontmatter
#      `tools:` block (granted) — body/prose mentions do NOT count
#      (agents/reviewer.md body literally contains `mcp__canon__<tool_name>`
#      placeholder text; this must not be mistaken for a grant).
#   2. `t` is listed in hooks/lib/orchestrator-only-tools.txt (explicit
#      orchestrator-only/internal classification).
#   3. `t`'s registerTool(/registerToolWithUi( name-literal line carries an
#      inline `// canon:allow-unsurfaced: <reason>` marker (one-off,
#      not-yet-wired exception).
#
# Negative scope: this gate is ONE-DIRECTIONAL (registered -> surfaced). The
# reverse class (an agent grants a tool that is not registered) is out of
# scope for this gate (empty today per PROBE-FINDINGS.md Result 2).
#
# Exit 0: every registered tool is granted, allowlisted, or marker-suppressed.
# Exit 2: one or more registered tools are unclassified, OR a matched
#         registerTool(/registerToolWithUi( call's name argument is not a
#         resolvable string literal (unresolvable -> fail closed, never
#         guessed — the AST helper's own fail-closed contract), OR node is
#         unavailable, OR the extractor helper itself errors, OR registration
#         files were present but zero tool names were extracted at all
#         (vacuous-pass tripwire, defense-in-depth — the AST should make this
#         unreachable but it stays fail-closed), OR the gate's own arg
#         prerequisites failed (non-directory worktree_path, missing
#         mcp-server/src/app) — fail-closed (hooks-fail-closed). Emits a
#         CANON: diagnostic on stderr for every failing path
#         (hooks-observable-failures).
#
# Because the extraction is an AST walk over CallExpression nodes rather than
# line-oriented text matching, comment (`// server.registerTool(...)`) and
# string-literal (`"...server.registerTool(...)..."`) mentions of a
# registration opener are never matched (they are not CallExpression nodes),
# and every real opener resolves correctly regardless of line-packing or
# multiline splits (e.g. `registerToolWithUi(\n  server,\n  "name",` — the
# Codex P2 finding the prior line-parser required bespoke state-machine
# handling for) — no opener-accounting backstop is needed.

set -euo pipefail

WORKTREE_PATH="${1:-}"

if [[ -n "$WORKTREE_PATH" ]] && [[ ! -d "$WORKTREE_PATH" ]]; then
  echo "CANON: tool-surfacing-check failed-closed — worktree_path not a directory: $WORKTREE_PATH" >&2
  exit 2
fi

ROOT="${WORKTREE_PATH:-$(pwd)}"

if [[ ! -d "$ROOT/mcp-server/src/app" ]]; then
  echo "CANON: tool-surfacing-check failed-closed — mcp-server/src/app not found under: $ROOT" >&2
  exit 2
fi

REG_RAW="$(mktemp)"
GRANTED_RAW="$(mktemp)"
ALLOWLIST_RAW="$(mktemp)"
REGISTERED_FILE="$(mktemp)"
GRANTED_FILE="$(mktemp)"
ALLOWLIST_FILE="$(mktemp)"
MARKER_FILE="$(mktemp)"
STEP1_FILE="$(mktemp)"
STEP2_FILE="$(mktemp)"
VIOL_FILE="$(mktemp)"
HELPER_ERR="$(mktemp)"
trap 'rm -f "$REG_RAW" "$GRANTED_RAW" "$ALLOWLIST_RAW" "$REGISTERED_FILE" "$GRANTED_FILE" "$ALLOWLIST_FILE" "$MARKER_FILE" "$STEP1_FILE" "$STEP2_FILE" "$VIOL_FILE" "$HELPER_ERR"' EXIT

# ---------------------------------------------------------------------------
# REGISTERED + MARKER — scan register-*.ts + create-server.ts via the
# TypeScript-compiler-API extractor (mcp-server/scripts/tool-surfacing-extract.mjs,
# ADR-0048 rethink). The AST walk naturally excludes comment and
# string-literal text (they are not CallExpression nodes) and correctly
# resolves every opener form regardless of line-packing or multiline splits
# -- the root-fix for both the prior line-parser's fail-CLOSED comment/
# string over-match classes and its fail-OPEN split/packed-opener classes.
# Emits "<name>\t<0|1>" rows (1 = marker present on the name-literal's
# physical source line) -- same REG_RAW format the rest of this gate
# consumes.
# ---------------------------------------------------------------------------
shopt -s nullglob
REG_FILES=("$ROOT"/mcp-server/src/app/register-*.ts)
shopt -u nullglob
[[ -f "$ROOT/mcp-server/src/app/create-server.ts" ]] && REG_FILES+=("$ROOT/mcp-server/src/app/create-server.ts")

if [[ "${#REG_FILES[@]}" -eq 0 ]]; then
  echo "CANON: tool-surfacing-check — no MCP registration files found under mcp-server/src/app (wrong CWD?)" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "CANON: tool-surfacing-check failed-closed -- node unavailable, cannot run the TS-AST tool-surfacing extractor" >&2
  exit 2
fi

_gate_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Allow TOOL_SURFACING_HELPER_PATH override for testing (stub-helper scenarios).
_extract_helper="${TOOL_SURFACING_HELPER_PATH:-${_gate_dir}/../mcp-server/scripts/tool-surfacing-extract.mjs}"

_helper_exit=0
_helper_out=$(node "$_extract_helper" "${REG_FILES[@]}" 2>"$HELPER_ERR") || _helper_exit=$?

if [[ "$_helper_exit" -ne 0 ]]; then
  echo "CANON: tool-surfacing-check failed-closed -- tool-surfacing-extract.mjs failed (exit ${_helper_exit}):" >&2
  cat "$HELPER_ERR" >&2
  exit 2
fi

: > "$REG_RAW"
if [[ -n "$_helper_out" ]]; then
  printf '%s\n' "$_helper_out" >> "$REG_RAW"
fi

cut -f1 "$REG_RAW" | sort -u > "$REGISTERED_FILE"
awk -F'\t' '$2 == "1" { print $1 }' "$REG_RAW" | sort -u > "$MARKER_FILE"

# ---------------------------------------------------------------------------
# Vacuous-pass tripwire: registration files were present, but zero tool names
# were extracted from any of them. This is defense-in-depth against a parser
# gap or unexpected registration form on a whole-tree basis -- the AST
# extraction should make this unreachable, but silently passing here would be
# the canonical PR #270 hooks-fail-closed incident shape (extraction silently
# yields empty -> "all surfaced").
# ---------------------------------------------------------------------------
if [[ ! -s "$REGISTERED_FILE" ]]; then
  echo "CANON: tool-surfacing-check -- registration files present but zero tool names extracted (parser gap or unexpected registration form)" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# GRANTED — for each agents/*.md, extract mcp__canon__<name> tokens ONLY
# within the leading-frontmatter tools: block. Block-scoped: enter on
# ^tools:, exit on the next column-0 key or the closing frontmatter ---.
# Body/prose mentions of mcp__canon__... outside frontmatter MUST NOT count.
# ---------------------------------------------------------------------------
shopt -s nullglob
AGENT_FILES=("$ROOT"/agents/*.md)
shopt -u nullglob

if [[ "${#AGENT_FILES[@]}" -eq 0 ]]; then
  echo "CANON: tool-surfacing-check — no agents/*.md files found under agents (wrong CWD?)" >&2
  exit 2
fi

for f in "${AGENT_FILES[@]+"${AGENT_FILES[@]}"}"; do
  awk '
    NR == 1 { if ($0 != "---") exit; next }
    $0 == "---" { exit }
    /^tools:/ { intools = 1; next }
    intools && /^[^[:space:]]/ { intools = 0 }
    intools {
      rest = $0
      while (match(rest, /mcp__canon__[a-z0-9_]+/)) {
        print substr(rest, RSTART, RLENGTH)
        rest = substr(rest, RSTART + RLENGTH)
      }
    }
  ' "$f" >> "$GRANTED_RAW"
done

sed 's/^mcp__canon__//' "$GRANTED_RAW" | sort -u > "$GRANTED_FILE"

# ---------------------------------------------------------------------------
# ALLOWLIST — hooks/lib/orchestrator-only-tools.txt: skip blank + #-comment
# lines, trim to a bare token.
# ---------------------------------------------------------------------------
ALLOWLIST_SRC="$ROOT/hooks/lib/orchestrator-only-tools.txt"
if [[ -f "$ALLOWLIST_SRC" ]]; then
  awk '
    { line = $0; sub(/^[[:space:]]+/, "", line); sub(/[[:space:]]+$/, "", line) }
    line == "" { next }
    line ~ /^#/ { next }
    { print line }
  ' "$ALLOWLIST_SRC" > "$ALLOWLIST_RAW"
fi
sort -u "$ALLOWLIST_RAW" > "$ALLOWLIST_FILE"

# ---------------------------------------------------------------------------
# VIOLATIONS = REGISTERED - GRANTED - ALLOWLIST - MARKER.
# ---------------------------------------------------------------------------
comm -23 "$REGISTERED_FILE" "$GRANTED_FILE" > "$STEP1_FILE"
comm -23 "$STEP1_FILE" "$ALLOWLIST_FILE" > "$STEP2_FILE"
comm -23 "$STEP2_FILE" "$MARKER_FILE" > "$VIOL_FILE"

if [[ -s "$VIOL_FILE" ]]; then
  echo "CANON: tool-surfacing-check — registered tool(s) surfaced in no agent grant and not classified:" >&2
  while IFS= read -r v; do
    [[ -n "$v" ]] && echo "  $v registered but surfaced in no agent grant and not classified" >&2
  done < "$VIOL_FILE"
  exit 2
fi

echo "tool-surfacing-check: all registered tools surfaced or classified."
exit 0
