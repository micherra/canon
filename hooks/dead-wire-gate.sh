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
# Collect new TS export symbols from the diff
# Pattern: export (async function|function|const|class|type|interface|enum) <NAME>
# Exclude: export { ... } from (re-exports are wiring, not candidates)
# ---------------------------------------------------------------------------
TS_DIFF=""
if ! TS_DIFF=$(git diff "${BASE_COMMIT}..HEAD" -- 'mcp-server/src/**/*.ts' 2>&1); then
  echo "CANON: dead-wire-gate failed-closed — git diff failed for TS files: $TS_DIFF" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Collect new MCP tool registrations from register-*.ts diff
# ---------------------------------------------------------------------------
REG_DIFF=""
if ! REG_DIFF=$(git diff "${BASE_COMMIT}..HEAD" -- 'mcp-server/src/app/register-*.ts' 2>&1); then
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
      #          export type, export interface, export enum
      local symbol=""
      if echo "$content" | grep -qE '^[[:space:]]*export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*'; then
        symbol=$(echo "$content" | sed -E 's/^[[:space:]]*export[[:space:]]+(async[[:space:]]+)?function[[:space:]]+([A-Za-z_$][A-Za-z0-9_$]*).*/\2/')
      elif echo "$content" | grep -qE '^[[:space:]]*export[[:space:]]+const[[:space:]]+[A-Za-z_$][A-Za-z0-9_$]*'; then
        symbol=$(echo "$content" | sed -E 's/^[[:space:]]*export[[:space:]]+const[[:space:]]+([A-Za-z_$][A-Za-z0-9_$]*).*/\1/')
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
    # Symbol is wired
    continue
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
