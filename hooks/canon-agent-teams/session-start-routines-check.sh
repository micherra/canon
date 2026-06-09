#!/usr/bin/env bash
# session-start-routines-check.sh — SessionStart hook that nudges the lead
# when enabled routines have missing live bindings (drift detected).
#
# Reads routines from:
#   ${CANON_PROJECT_DIR}/.canon/routines/     (project-local)
#   ${CLAUDE_PLUGIN_ROOT}/routines/           (plugin, if present)
#
# For each enabled routine:
#   - desktop-task:  check ${HOME}/.claude/scheduled-tasks/<name>/SKILL.md
#   - cloud-routine: no live-binding check (cloud state is external)
#
# If any enabled desktop-task routine has no SKILL.md, emits an advisory
# CANON NOTE: nudge to run /canon:routines sync.
#
# NEVER writes any file — this hook is strictly read-only.
# Always exits 0 — advisory only.

set -euo pipefail

CANON_DIR="${CANON_PROJECT_DIR:-.}/.canon"
ROUTINES_DIR="${CANON_DIR}/routines"
PLUGIN_ROUTINES_DIR="${CLAUDE_PLUGIN_ROOT:-}/routines"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Extract a top-level YAML frontmatter field value from a markdown file.
# Usage: get_fm_field <file> <field>
# Returns the trimmed value, or empty string on any failure (fail-open).
get_fm_field() {
  local file="$1"
  local field="$2"
  # Print lines between first and second --- (YAML frontmatter).
  awk '/^---$/{found++; next} found==1{print} found>=2{exit}' "$file" 2>/dev/null \
    | grep "^${field}:" \
    | head -1 \
    | sed "s/^[^:]*:[[:space:]]*//" \
    | tr -d "\"'" \
    || true  # DOCUMENTED FAIL-OPEN -- parse failure yields empty; caller skips entry
}

# Resolve binding target for a routine file.
# Usage: resolve_binding <file>
# Prints "cloud-routine" or "desktop-task".
#
# Canonical binding rule: mcp-server/src/features/routines/services/resolve-binding.ts
# This bash re-implementation mirrors that TS function — keep in sync.
resolve_binding() {
  local file="$1"

  local binding_target
  binding_target="$(get_fm_field "$file" "binding_target")"

  # Treat YAML null (~), empty, or whitespace-only binding_target as UNSET.
  # The TS loader (gray-matter) parses `binding_target: ~` as null → undefined
  # (treated as not set). The bash parser strips quotes but leaves the literal
  # string "~". We must match the TS behavior: fall through to needs-based
  # derivation rather than returning "~" verbatim.
  # Mirrors: mcp-server/src/features/routines/services/resolve-binding.ts
  if [[ -n "$binding_target" && "$binding_target" != "~" ]]; then
    echo "$binding_target"
    return
  fi

  # Infer from needs: block under "needs:" key in frontmatter.
  local needs_state needs_daemon
  needs_state="$(
    awk '/^---$/{found++; next} found==1 && /^needs:/{in_needs=1; next}
         found==1 && in_needs && /^[^ \t]/{exit}
         found==1 && in_needs{print}
         found>=2{exit}' "$file" 2>/dev/null \
    | grep "state:" | head -1 \
    | sed "s/.*state:[[:space:]]*//" \
    | tr -d "\"'" \
    || true  # DOCUMENTED FAIL-OPEN -- awk/sed failure returns empty; defaults to git-native below
  )"

  needs_daemon="$(
    awk '/^---$/{found++; next} found==1 && /^needs:/{in_needs=1; next}
         found==1 && in_needs && /^[^ \t]/{exit}
         found==1 && in_needs{print}
         found>=2{exit}' "$file" 2>/dev/null \
    | grep "daemon:" | head -1 \
    | sed "s/.*daemon:[[:space:]]*//" \
    | tr -d "\"'" \
    || true  # DOCUMENTED FAIL-OPEN -- awk/sed failure returns empty; defaults to false below
  )"

  if [[ "$needs_state" == "git-native" && "$needs_daemon" != "true" ]]; then
    echo "cloud-routine"
  else
    echo "desktop-task"
  fi
}

# Check one routines directory for drifted desktop-task routines.
# Appends unbound routine names to the DRIFTED_NAMES array (global).
# Usage: scan_dir <dir>
scan_dir() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0

  local f basename_f status name binding skill_path
  for f in "$dir"/*.md; do
    [[ -f "$f" ]] || continue

    basename_f="$(basename "$f")"
    [[ "$basename_f" == "README.md" ]] && continue
    [[ "$basename_f" == .* ]] && continue

    status="$(get_fm_field "$f" "status")"
    [[ "$status" == "enabled" ]] || continue

    name="$(get_fm_field "$f" "name")"
    [[ -n "$name" ]] || continue

    binding="$(resolve_binding "$f")"
    [[ "$binding" == "desktop-task" ]] || continue

    skill_path="${HOME}/.claude/scheduled-tasks/${name}/SKILL.md"
    if [[ ! -f "$skill_path" ]]; then
      DRIFTED_NAMES+=("$name")
    fi
  done
}

# Check whether a name is already present in DRIFTED_NAMES or was already
# seen in the project-local scan (project-local wins on name conflict).
# Usage: already_seen <name>  → returns 0 (true) if seen, 1 (false) if not
already_seen() {
  local target="$1"
  local n
  for n in "${SEEN_NAMES[@]+"${SEEN_NAMES[@]}"}"; do
    [[ "$n" == "$target" ]] && return 0
  done
  return 1
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

DRIFTED_NAMES=()
SEEN_NAMES=()

# 1. Scan project-local routines
scan_dir "$ROUTINES_DIR"

# Record which names came from the project-local scan (for precedence dedup).
for _n in "${DRIFTED_NAMES[@]+"${DRIFTED_NAMES[@]}"}"; do
  SEEN_NAMES+=("$_n")
done

# Also record all project-local routine names (not just drifted ones) so that
# cloud-routine names are excluded from the plugin scan dedup check too.
if [[ -d "$ROUTINES_DIR" ]]; then
  _f=""
  for _f in "$ROUTINES_DIR"/*.md; do
    [[ -f "$_f" ]] || continue
    _bn="$(basename "$_f")"
    [[ "$_bn" == "README.md" ]] && continue
    [[ "$_bn" == .* ]] && continue
    _pn="$(get_fm_field "$_f" "name")"
    [[ -n "$_pn" ]] || continue
    if ! already_seen "$_pn"; then
      SEEN_NAMES+=("$_pn")
    fi
  done
fi

# 2. Scan plugin routines, skipping any names already seen from project-local
if [[ -d "$PLUGIN_ROUTINES_DIR" ]]; then
  _pf=""
  for _pf in "$PLUGIN_ROUTINES_DIR"/*.md; do
    [[ -f "$_pf" ]] || continue

    _pfbn="$(basename "$_pf")"
    [[ "$_pfbn" == "README.md" ]] && continue
    [[ "$_pfbn" == .* ]] && continue

    _pfstatus="$(get_fm_field "$_pf" "status")"
    [[ "$_pfstatus" == "enabled" ]] || continue

    _pfname="$(get_fm_field "$_pf" "name")"
    [[ -n "$_pfname" ]] || continue

    already_seen "$_pfname" && continue

    _pfbinding="$(resolve_binding "$_pf")"
    [[ "$_pfbinding" == "desktop-task" ]] || continue

    _pfskill="${HOME}/.claude/scheduled-tasks/${_pfname}/SKILL.md"
    if [[ ! -f "$_pfskill" ]]; then
      DRIFTED_NAMES+=("$_pfname")
    fi
  done
fi

# ---------------------------------------------------------------------------
# Emit nudge if any enabled desktop-task routines are unbound
# ---------------------------------------------------------------------------

if [[ "${#DRIFTED_NAMES[@]}" -gt 0 ]]; then
  NAMES_LIST="${DRIFTED_NAMES[*]}"
  cat <<EOF
CANON NOTE: ${#DRIFTED_NAMES[@]} enabled routine(s) have no live binding:
  ${NAMES_LIST// /, }

Run /canon:routines sync to write the missing SKILL.md file(s).
EOF
fi

exit 0
