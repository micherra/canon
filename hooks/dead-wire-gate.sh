#!/bin/bash
# dead-wire-gate.sh — Standing dead-wire reachability gate.
#
# Invoked by the verify contract (not as a hooks.json PreToolUse hook).
# Signature: bash hooks/dead-wire-gate.sh <base_commit>
# Run from the worktree root.
#
# Exit 0: all new exports are wired (or suppressed)
# Exit 2: one or more newly-exported symbols/tools are DEAD (no real references)
# Exit non-zero: internal error (fail-closed)
#
# Suppression: add an inline comment on the export line or the line directly above:
#   // canon:allow-unwired: <non-empty reason>
# Audit all suppressions: grep -rn 'canon:allow-unwired' mcp-server/src
#
# Merge-aware scoping
# -------------------
# The gate computes an effective diff base to avoid flagging exports that were
# introduced by a mid-build merge of origin/main (not by this build's commits).
#
# effective_base = git merge-base origin/main HEAD
#   → after merging origin/main, this equals origin/main, so the diff range
#     excludes main's commits and covers only commits unique to this branch.
#   → with no merge and origin/main at or behind HEAD, merge-base ≤ <base_commit>,
#     which is further guarded by the max() below.
#
# Fallback (fail-safe, NOT fail-open):
#   If origin/main does not exist (offline, fresh clone, no remote), the gate
#   falls back to <base_commit>. Detection is preserved; only base selection
#   changes. Internal errors (failed grep, malformed diff) still fail closed.

set -euo pipefail

BASE_COMMIT="${1:-}"

if [[ -z "$BASE_COMMIT" ]]; then
  echo "CANON: dead-wire-gate failed-closed — missing required argument: <base_commit>" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Validate base commit exists
# ---------------------------------------------------------------------------
if ! git rev-parse --verify "$BASE_COMMIT" >/dev/null 2>&1; then
  echo "CANON: dead-wire-gate failed-closed — invalid base commit: $BASE_COMMIT" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Compute effective diff base (merge-aware scoping)
#
# Use git merge-base(origin/main, HEAD) so that exports merged in from
# origin/main (e.g. during a mid-build doc-file pre-check merge) are not
# in the diff range and cannot be flagged as this-build dead wires.
#
# If origin/main is unavailable, fall back to BASE_COMMIT (passed arg).
# The effective base must not be older than BASE_COMMIT — take the more
# recent of the two so we never scope earlier than the caller intended.
# ---------------------------------------------------------------------------
EFFECTIVE_BASE="$BASE_COMMIT"
if git rev-parse --verify "origin/main" >/dev/null 2>&1; then
  MERGE_BASE=""
  if MERGE_BASE=$(git merge-base "origin/main" HEAD 2>/dev/null); then
    # Guard: effective_base must be at least as recent as BASE_COMMIT.
    # If merge-base is an ancestor of BASE_COMMIT, BASE_COMMIT is more recent — keep it.
    if git merge-base --is-ancestor "$MERGE_BASE" "$BASE_COMMIT" 2>/dev/null; then
      # merge-base ≤ BASE_COMMIT; use BASE_COMMIT (more restrictive diff)
      EFFECTIVE_BASE="$BASE_COMMIT"
    else
      # merge-base is more recent than BASE_COMMIT; use merge-base
      EFFECTIVE_BASE="$MERGE_BASE"
    fi
  fi
  # If git merge-base itself fails (unusual), EFFECTIVE_BASE stays as BASE_COMMIT
fi

# ---------------------------------------------------------------------------
# Collect new TS export symbols from the diff
# Pattern: export (async function|function|const|let|var|class|type|interface|enum) <NAME>
# Exclude: export { ... } from (re-exports are wiring, not candidates)
# ---------------------------------------------------------------------------
TS_DIFF=""
if ! TS_DIFF=$(git diff "${EFFECTIVE_BASE}..HEAD" -- 'mcp-server/src/**/*.ts' 'mcp-server/src/*.ts' 2>&1); then
  echo "CANON: dead-wire-gate failed-closed — git diff failed for TS files: $TS_DIFF" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Collect new MCP tool registrations from register-*.ts diff
# ---------------------------------------------------------------------------
REG_DIFF=""
if ! REG_DIFF=$(git diff "${EFFECTIVE_BASE}..HEAD" -- 'mcp-server/src/app/register-*.ts' 2>&1); then
  echo "CANON: dead-wire-gate failed-closed — git diff failed for register files: $REG_DIFF" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Extract newly-exported TS symbol names
# From added lines only (^+ excluding +++ header)
# Match: export (async function|function|const|class|type|interface|enum) NAME
# Exclude: export { ... } from ... (re-exports)
# Output format: "<filename>:<lineno>:<symbolname>"
# ---------------------------------------------------------------------------
extract_ts_symbols() {
  local diff_text="$1"
  local current_file=""
  local current_line=0

  while IFS= read -r line; do
    # Track current file from diff header
    if [[ "$line" =~ ^\+\+\+\ b/(.*)$ ]]; then
      current_file="${BASH_REMATCH[1]}"
      current_line=0
      continue
    fi
    if [[ "$line" =~ ^---\ a/ ]]; then
      continue
    fi
    # Track line numbers from hunk headers: @@ -a,b +c,d @@
    if [[ "$line" =~ ^@@.*\+([0-9]+) ]]; then
      current_line="${BASH_REMATCH[1]}"
      # Subtract 1 since we increment before processing
      current_line=$((current_line - 1))
      continue
    fi

    # Only process added lines
    if [[ "$line" =~ ^\+ ]]; then
      current_line=$((current_line + 1))
      # Strip the leading + for content analysis
      content="${line:1}"

      # Exclude re-export lines: export { ... } from
      if echo "$content" | grep -qE '^[[:space:]]*export[[:space:]]*\{'; then
        continue
      fi

      # Match export patterns and extract symbol name
      # Handles: export function, export async function, export const, export class,
      #          export type, export interface, export enum, export let, export var
      local symbol=""
      if echo "$content" | grep -qE '^[[:space:]]*export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*'; then
        symbol=$(echo "$content" | sed -E 's/^[[:space:]]*export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+([A-Za-z_$][A-Za-z0-9_$]*).*/\2/')
      elif echo "$content" | grep -qE '^[[:space:]]*export[[:space:]]+(const|let|var)[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*'; then
        symbol=$(echo "$content" | sed -E 's/^[[:space:]]*export[[:space:]]+(const|let|var)[[:space:]]+([A-Za-z_$][A-Za-z0-9_$]*).*/\2/')
      elif echo "$content" | grep -qE '^[[:space:]]*export[[:space:]]+class[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*'; then
        symbol=$(echo "$content" | sed -E 's/^[[:space:]]*export[[:space:]]+class[[:space:]]+([A-Za-z_$][A-Za-z0-9_$]*).*/\1/')
      elif echo "$content" | grep -qE '^[[:space:]]*export[[:space:]]+type[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*'; then
        symbol=$(echo "$content" | sed -E 's/^[[:space:]]*export[[:space:]]+type[[:space:]]+([A-Za-z_$][A-Za-z0-9_$]*).*/\1/')
      elif echo "$content" | grep -qE '^[[:space:]]*export[[:space:]]+interface[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*'; then
        symbol=$(echo "$content" | sed -E 's/^[[:space:]]*export[[:space:]]+interface[[:space:]]+([A-Za-z_$][A-Za-z0-9_$]*).*/\1/')
      elif echo "$content" | grep -qE '^[[:space:]]*export[[:space:]]+enum[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*'; then
        symbol=$(echo "$content" | sed -E 's/^[[:space:]]*export[[:space:]]+enum[[:space:]]+([A-Za-z_$][A-Za-z0-9_$]*).*/\1/')
      fi

      if [[ -n "$symbol" ]] && [[ -n "$current_file" ]]; then
        echo "${current_file}:${current_line}:${symbol}"
      fi
    elif [[ ! "$line" =~ ^- ]]; then
      # Context lines (not removed lines) still increment line counter
      current_line=$((current_line + 1))
    fi
  done <<< "$diff_text"
}

# ---------------------------------------------------------------------------
# Extract newly-registered MCP tool names from register-*.ts diff
# Match added lines containing: registerTool("<name>"
# Output format: "<toolname>"
# ---------------------------------------------------------------------------
extract_mcp_tools() {
  local diff_text="$1"

  while IFS= read -r line; do
    # Only process added lines
    if [[ "$line" =~ ^\+ ]] && [[ ! "$line" =~ ^\+\+\+ ]]; then
      content="${line:1}"
      # Match registerTool("<name>" — quoted tool name
      if echo "$content" | grep -qE 'registerTool\("[^"]+'; then
        local tool_name
        tool_name=$(echo "$content" | sed -E 's/.*registerTool\("([^"]+)".*/\1/')
        if [[ -n "$tool_name" ]]; then
          echo "$tool_name"
        fi
      fi
    fi
  done <<< "$diff_text"
}

# ---------------------------------------------------------------------------
# Check if a TS symbol is suppressed via canon:allow-unwired: marker.
# Checks the export's own line and the line directly above in the worktree.
# Returns: prints suppression reason if valid; exits with status 0 if suppressed, 1 if not.
#
# Assumption: this function reads the working-tree file at the diff-reported line number.
# This is correct under the intended usage where the gate runs against <base_commit>..HEAD
# on the currently checked-out worktree (HEAD == worktree). If the worktree were checked
# out to a different commit than HEAD, reported line numbers could drift from file content.
# ---------------------------------------------------------------------------
check_suppression() {
  local file="$1"
  local lineno="$2"

  if [[ ! -f "$file" ]]; then
    return 1
  fi

  # Check the export's own line and the line directly above
  local check_start=$(( lineno > 1 ? lineno - 1 : 1 ))
  local check_end="$lineno"

  local found_reason=""
  local ln="$check_start"
  while [[ "$ln" -le "$check_end" ]]; do
    local file_line
    # Read specific line from file using sed
    file_line=$(sed -n "${ln}p" "$file" 2>/dev/null || true)
    if echo "$file_line" | grep -q 'canon:allow-unwired:'; then
      # Extract reason after the colon
      local reason
      reason=$(echo "$file_line" | sed -E 's/.*canon:allow-unwired:[[:space:]]*//')
      # Trim trailing whitespace
      reason=$(echo "$reason" | sed -E 's/[[:space:]]*$//')
      if [[ -n "$reason" ]]; then
        found_reason="$reason"
        break
      fi
    fi
    ln=$((ln + 1))
  done

  if [[ -n "$found_reason" ]]; then
    echo "$found_reason"
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Check whether a TS symbol is used inside its OWN production source file
# (same-file internal use ⇒ wired).
#
# A symbol is internally used iff its own defining file contains a whole-word
# occurrence of the symbol on a line that is NOT a pure export-declaration of
# that symbol. We strip // line-comments first so a comment-only mention does
# not legitimize an otherwise-dead export.
#
# The caller guarantees <file> is NOT a test file (test-file early-out at the
# call site), so this function never legitimizes a symbol via a test file —
# R3 (test-only entry points stay flagged) is preserved.
#
# Fail-safe toward flagging: any grep/sed error path returns 1 (not used), so
# the symbol stays a DEAD candidate; the gate never becomes more permissive on
# internal error.
#
# Returns: 0 if internally used, 1 otherwise. Prints nothing.
# ---------------------------------------------------------------------------
is_internally_used() {
  local file="$1"
  local symbol="$2"

  [[ -f "$file" ]] || return 1

  # Strip // line comments, then find whole-word occurrences of the symbol.
  local hits
  # DOCUMENTED FAIL-OPEN -- no-match is the expected path; a sed/grep error leaves
  # hits empty so we fall through to "not used" (fail toward flagging), never more permissive.
  hits=$(sed -E 's://.*$::' "$file" 2>/dev/null | grep -nE "\b${symbol}\b" 2>/dev/null || true)
  [[ -z "$hits" ]] && return 1

  # Drop lines that are an export-declaration of this symbol; any remaining
  # whole-word occurrence is a genuine same-file use.
  local non_decl
  # DOCUMENTED FAIL-OPEN -- grep -v returns non-zero (exit 1) when it filters out every
  # line; that empty result correctly means "no non-declaration occurrence" ⇒ not used.
  non_decl=$(printf '%s\n' "$hits" \
    | grep -vE "export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+${symbol}\b" \
    | grep -vE "export[[:space:]]+(const|let|var|class|type|interface|enum)[[:space:]]+${symbol}\b" \
    || true)

  [[ -n "$non_decl" ]] && return 0
  return 1
}

# ---------------------------------------------------------------------------
# Main gate logic
# ---------------------------------------------------------------------------

DEAD_COUNT=0
SUPPRESSED_COUNT=0
CHECKED_COUNT=0

# Process TS symbols
while IFS= read -r entry; do
  [[ -z "$entry" ]] && continue

  # Parse "file:lineno:symbol"
  local_file=$(echo "$entry" | cut -d: -f1)
  local_line=$(echo "$entry" | cut -d: -f2)
  local_symbol=$(echo "$entry" | cut -d: -f3-)

  CHECKED_COUNT=$((CHECKED_COUNT + 1))

  # Reachability check (verbatim from CLAUDE.md wiring-enrichment logic):
  # grep -rln "\b<NAME>\b" mcp-server/src --include='*.ts'
  # exclude the symbol's own def file and *.test.ts files
  # ≥1 remaining reference ⇒ WIRED, zero ⇒ DEAD

  local_refs=""
  if ! local_refs=$(grep -rln "\b${local_symbol}\b" mcp-server/src --include='*.ts' 2>/dev/null || true); then
    echo "CANON: dead-wire-gate failed-closed — grep failed for symbol: $local_symbol" >&2
    exit 1
  fi

  # Filter out the definition file itself and test files
  local_wired_refs=""
  while IFS= read -r ref_file; do
    [[ -z "$ref_file" ]] && continue
    # Exclude own definition file
    if [[ "$ref_file" == "$local_file" ]]; then
      continue
    fi
    # Exclude test files
    if [[ "$ref_file" == *.test.ts ]]; then
      continue
    fi
    local_wired_refs="$local_wired_refs $ref_file"
  done <<< "$local_refs"

  if [[ -n "${local_wired_refs// /}" ]]; then
    # Symbol is wired (external/non-test reference)
    continue
  fi

  # Same-file production use ⇒ wired (R1), UNLESS the defining file is itself a
  # test file (defensive early-out so a test-helper export cannot self-legitimize;
  # this preserves R3). Candidates are production files in practice.
  if [[ "$local_file" != *.test.ts && "$local_file" != *.spec.ts && "$local_file" != *"/__tests__/"* ]]; then
    if is_internally_used "$local_file" "$local_symbol"; then
      continue
    fi
  fi

  # Symbol appears DEAD — check suppression before flagging
  suppression_reason=""
  if suppression_reason=$(check_suppression "$local_file" "$local_line" 2>/dev/null); then
    echo "SUPPRESSED: ${local_symbol} @ ${local_file}:${local_line} — ${suppression_reason}"
    SUPPRESSED_COUNT=$((SUPPRESSED_COUNT + 1))
  else
    echo "DEAD-WIRE: ${local_symbol} exported in ${local_file} but never referenced/registered." >&2
    DEAD_COUNT=$((DEAD_COUNT + 1))
  fi

done < <(extract_ts_symbols "$TS_DIFF")

# Process MCP tool registrations
while IFS= read -r tool_name; do
  [[ -z "$tool_name" ]] && continue

  CHECKED_COUNT=$((CHECKED_COUNT + 1))

  # Reachability: grep -rn '"<name>"' mcp-server/src/app/register-*.ts
  # ≥1 match ⇒ WIRED, zero ⇒ DEAD
  mcp_refs=""
  if ! mcp_refs=$(grep -rn "\"${tool_name}\"" mcp-server/src/app/register-*.ts 2>/dev/null || true); then
    echo "CANON: dead-wire-gate failed-closed — grep failed for MCP tool: $tool_name" >&2
    exit 1
  fi

  if [[ -n "$mcp_refs" ]]; then
    # Tool is registered
    continue
  fi

  # Structural note: the normal gate workflow (diff BASE..HEAD on a checked-out worktree)
  # cannot produce this DEAD path organically, because extract_mcp_tools reads the diff's
  # '+' lines (what is in HEAD) and the grep also reads HEAD's register-*.ts files — they
  # are the same state. The DEAD path fires only under abnormal conditions: the worktree
  # is checked out to a commit different from HEAD, or register-*.ts files were deleted
  # between when the diff was captured and when the grep runs. The reachability check is
  # retained for defense-in-depth; its test coverage is provided by a unit-style fixture
  # in dead-wire-gate.test.sh (Test 27) that exercises the grep/empty-match logic directly.
  echo "DEAD-WIRE: ${tool_name} exported in register-*.ts but never referenced/registered." >&2
  DEAD_COUNT=$((DEAD_COUNT + 1))

done < <(extract_mcp_tools "$REG_DIFF")

# ---------------------------------------------------------------------------
# Final verdict
# ---------------------------------------------------------------------------
if [[ "$DEAD_COUNT" -gt 0 ]]; then
  exit 2
fi

echo "dead-wire-gate: ${CHECKED_COUNT} new exports checked, 0 unwired, ${SUPPRESSED_COUNT} suppressed."
exit 0
