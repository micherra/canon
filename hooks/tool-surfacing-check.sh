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
# reads a git diff. Runs OFFLINE (pure awk/grep over TS source + agent
# frontmatter — no MCP daemon, no JSON extraction / git-token work, so
# canon-hook-lib.sh is deliberately NOT sourced — noted as a deliberate
# non-use, not an omission).
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
# Exit 2: one or more registered tools are unclassified, OR a registration
#         opener's name literal cannot be resolved on its immediately-
#         following non-blank line (unresolvable -> fail closed, never
#         guessed), OR registration files were present but zero tool names
#         were extracted at all (vacuous-pass tripwire), OR the gate's own
#         arg prerequisites failed (non-directory worktree_path, missing
#         mcp-server/src/app) — fail-closed (hooks-fail-closed). Emits a
#         CANON: diagnostic on stderr for every failing path
#         (hooks-observable-failures).

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

MARKER_TEXT="canon:allow-unsurfaced:"

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
trap 'rm -f "$REG_RAW" "$GRANTED_RAW" "$ALLOWLIST_RAW" "$REGISTERED_FILE" "$GRANTED_FILE" "$ALLOWLIST_FILE" "$MARKER_FILE" "$STEP1_FILE" "$STEP2_FILE" "$VIOL_FILE"' EXIT

# ---------------------------------------------------------------------------
# REGISTERED + MARKER — scan register-*.ts + create-server.ts for both
# registration idioms. Emits "<name>\t<0|1>" rows (1 = marker present on the
# name-literal source line). A per-line state machine tracks "expecting name"
# across lines for the multiline `registerTool(\n  "name",` form.
# ---------------------------------------------------------------------------
shopt -s nullglob
REG_FILES=("$ROOT"/mcp-server/src/app/register-*.ts)
shopt -u nullglob
[[ -f "$ROOT/mcp-server/src/app/create-server.ts" ]] && REG_FILES+=("$ROOT/mcp-server/src/app/create-server.ts")

if [[ "${#REG_FILES[@]}" -eq 0 ]]; then
  echo "CANON: tool-surfacing-check — no MCP registration files found under mcp-server/src/app (wrong CWD?)" >&2
  exit 2
fi

for f in "${REG_FILES[@]+"${REG_FILES[@]}"}"; do
  if ! awk -v marker="$MARKER_TEXT" '
    # try_name(str): a registration name literal must be the FIRST token in
    # str (only leading whitespace allowed before it) — anchored, not
    # "found anywhere" — so a later quoted arg/description token can never be
    # mistaken for the name. Returns the bare name, or "" if str does not
    # open with one.
    function try_name(str,    seg) {
      if (match(str, /^[[:space:]]*"[a-z][a-z0-9_]*"/)) {
        seg = substr(str, RSTART, RLENGTH)
        sub(/^[[:space:]]*/, "", seg)
        return substr(seg, 2, length(seg) - 2)
      }
      return ""
    }
    BEGIN { expecting = 0; unresolved = 0 }
    {
      line = $0
      if (expecting) {
        trimmed = line
        gsub(/^[ \t]+/, "", trimmed)
        gsub(/[ \t]+$/, "", trimmed)
        if (trimmed == "") { next }  # skip blank lines; still waiting for the bounded line
        name = try_name(line)
        if (name != "") {
          hasmarker = (index(line, marker) > 0) ? 1 : 0
          printf "%s\t%d\n", name, hasmarker
        } else {
          printf "CANON: tool-surfacing-check failed-closed -- unresolvable registration in %s at line %d (no name literal on the immediately-following non-blank line)\n", FILENAME, NR > "/dev/stderr"
          unresolved = 1
          exit 1
        }
        expecting = 0
        next
      }
      if (match(line, /registerTool\(/)) {
        rest = substr(line, RSTART + RLENGTH)
        name = try_name(rest)
        if (name != "") {
          hasmarker = (index(line, marker) > 0) ? 1 : 0
          printf "%s\t%d\n", name, hasmarker
        } else {
          expecting = 1
        }
        next
      }
      if (match(line, /registerToolWithUi\(server,[[:space:]]*/)) {
        rest = substr(line, RSTART + RLENGTH)
        name = try_name(rest)
        if (name != "") {
          hasmarker = (index(line, marker) > 0) ? 1 : 0
          printf "%s\t%d\n", name, hasmarker
        } else {
          expecting = 1
        }
        next
      }
    }
    END {
      if (expecting) {
        printf "CANON: tool-surfacing-check failed-closed -- unresolvable registration in %s (opener with no bounded next line before EOF)\n", FILENAME > "/dev/stderr"
        unresolved = 1
      }
      if (unresolved) { exit 1 }
    }
  ' "$f" >> "$REG_RAW"; then
    echo "CANON: tool-surfacing-check failed-closed -- unresolvable tool registration (see diagnostic above)" >&2
    exit 2
  fi
done

cut -f1 "$REG_RAW" | sort -u > "$REGISTERED_FILE"
awk -F'\t' '$2 == "1" { print $1 }' "$REG_RAW" | sort -u > "$MARKER_FILE"

# ---------------------------------------------------------------------------
# Vacuous-pass tripwire: registration files were present, but zero tool names
# were extracted from any of them. This is a parser gap / unexpected
# registration form on a whole-tree basis, NOT a clean pass -- silently
# passing here would be the canonical PR #270 hooks-fail-closed incident
# shape (extraction silently yields empty -> "all surfaced").
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
