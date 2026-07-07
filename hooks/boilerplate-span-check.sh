#!/bin/bash
# boilerplate-span-check.sh — Deterministic byte-identical-scaffold-span gate.
# (sug_BLOAT1)
#
# Invoked by the verify contract (not as a hooks.json PreToolUse hook).
# Signature: bash hooks/boilerplate-span-check.sh [worktree_path] [start_heading] [end_heading_prefix]
#
# Like context-manifest-gate.sh (and unlike dead-wire-gate.sh /
# shell-test-gate.sh), this gate takes NO <base_commit> — duplication is a
# WHOLE-TREE property (does any pair of principle files carry a byte-identical
# scaffold span), not a diff-scoped one. It recomputes over the current
# principles corpus; it never reads a git diff.
#
# Run from the worktree root, OR pass the worktree as the optional trailing
# worktree_path arg (watch_CCCCCCCCCCCC2) — the gate resolves its source tree
# from that arg (or CWD when absent), not from git. Optional [start_heading]
# and [end_heading_prefix] override the default span boundaries so the gate
# generalises to other scaffold classes later.
#
# Scope (hardcoded): the BUILT-IN principles tree only —
#   principles/rules/*.md principles/strong-opinions/*.md principles/conventions/*.md
# EXCLUDES .canon/principles/** (untrusted project-local overlay, ADR-0027) and
# any **/.claude/CLAUDE.md (generated index). The scoped tree is byte-clean
# today, so fail-closed here blocks only NEWLY-introduced duplication.
#
# Exit 0: no two in-scope files share an identical span (or nothing to compare).
# Exit 2: two or more files share a byte-identical span, OR the gate's own
#         arg/tool prerequisites failed (non-directory worktree_path, no hasher)
#         — fail-closed (hooks-fail-closed). Emits a CANON: diagnostic on stderr
#         for every failing path (hooks-observable-failures).
#
# Inline opt-out: a file (or its span) carrying `<!-- canon:allow-shared-span:
# <reason> -->` is excluded from duplicate consideration.

set -euo pipefail

WORKTREE_PATH="${1:-}"
START_HEADING="${2:-## Anti-Rationalization}"
END_PREFIX="${3:-## }"

if [[ -n "$WORKTREE_PATH" ]] && [[ ! -d "$WORKTREE_PATH" ]]; then
  echo "CANON: boilerplate-span-check failed-closed — worktree_path not a directory: $WORKTREE_PATH" >&2
  exit 2
fi

ROOT="${WORKTREE_PATH:-$(pwd)}"

# Resolve a SHA hasher (shasum on macOS, sha1sum on most Linux). Fail closed if
# neither is present — we cannot verify duplication without one.
if command -v shasum >/dev/null 2>&1; then
  HASHER="shasum"
elif command -v sha1sum >/dev/null 2>&1; then
  HASHER="sha1sum"
else
  echo "CANON: boilerplate-span-check failed-closed — no SHA hasher (shasum/sha1sum) available." >&2
  exit 2
fi

OPT_OUT_MARKER="canon:allow-shared-span:"

# Accumulate "<hash><TAB><relpath>" rows for non-opted-out spans.
ROWS_FILE="$(mktemp)"
trap 'rm -f "$ROWS_FILE"' EXIT

# Enumerate the in-scope built-in principle files (nullglob so an absent
# subdir contributes nothing rather than a literal glob token).
shopt -s nullglob
FILES=(
  "$ROOT"/principles/rules/*.md
  "$ROOT"/principles/strong-opinions/*.md
  "$ROOT"/principles/conventions/*.md
)
shopt -u nullglob

for f in "${FILES[@]}"; do
  # Extract the span: from the first line starting with START_HEADING through
  # (but excluding) the next line starting with END_PREFIX, or EOF. Files with
  # no such heading contribute an empty span and are skipped.
  span="$(awk -v sh="$START_HEADING" -v ep="$END_PREFIX" '
    !started && index($0, sh) == 1 { started = 1; print; next }
    started && index($0, ep) == 1 { exit }
    started { print }
  ' "$f")"

  [[ -z "$span" ]] && continue

  # Inline opt-out: marker anywhere in the file (covers span-embedded markers too).
  if grep -qF "$OPT_OUT_MARKER" "$f"; then
    continue
  fi

  h="$(printf '%s' "$span" | "$HASHER" | awk '{print $1}')"
  rel="${f#"$ROOT"/}"
  printf '%s\t%s\n' "$h" "$rel" >> "$ROWS_FILE"
done

# Group by hash; any hash shared by >=2 files is a duplicate scaffold span.
# Emit one "hash: file file ..." line per duplicate group. awk over the rows
# file (no pipefail-sensitive pipeline).
DUP_GROUPS="$(awk -F'\t' '
  { files[$1] = files[$1] " " $2; count[$1]++ }
  END { for (k in count) if (count[k] > 1) print files[k] }
' "$ROWS_FILE" | sed 's/^ *//')"

if [[ -n "$DUP_GROUPS" ]]; then
  DUP_COUNT="$(printf '%s\n' "$DUP_GROUPS" | grep -c . || true)"
  echo "CANON: boilerplate-span-check — $DUP_COUNT duplicate-group(s) share an identical '$START_HEADING' span:" >&2
  printf '%s\n' "$DUP_GROUPS" | while IFS= read -r group; do
    [[ -n "$group" ]] && echo "  $group" >&2
  done
  exit 2
fi

echo "boilerplate-span-check: no duplicate scaffold spans."
exit 0
