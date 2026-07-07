#!/bin/bash
# principle-id-citation-check.sh — Deterministic phantom-principle-id gate.
# (sug_PHANTOMID1)
#
# Invoked by the verify contract (not as a hooks.json PreToolUse hook).
# Signature: bash hooks/principle-id-citation-check.sh [worktree_path]
#
# Like context-manifest-gate.sh, this gate takes NO <base_commit> — a phantom
# citation is a WHOLE-TREE property (does any agent/rule file cite, in a
# principle-conditional "loaded" clause, an id that no principle ships). It
# recomputes over the current corpus; it never reads a git diff.
#
# Run from the worktree root, OR pass the worktree as the optional trailing
# worktree_path arg (watch_CCCCCCCCCCCC2) — the gate resolves its source tree
# from that arg (or CWD when absent), not from git. Runs OFFLINE (no Canon
# daemon): id resolution is pure filesystem/awk, not the list_principles MCP.
#
# Resolution set (shipped ids): first `id:` frontmatter line of every file under
#   principles/{rules,strong-opinions,conventions}/*.md
#   .canon/principles/{rules,conventions}/*.md
#   rules/*.md
#
# Scan (citation sites): agents/*.md + rules/*.md. NARROW idiom (near-zero false
# positive — P5c): a backtick-wrapped principle-shaped token (^[a-z]+(-[a-z]+)+$)
# that appears BEFORE the word `loaded` (case-insensitive) on the same line —
# the reviewer principle-conditional "If `<id>` is loaded" / "`<id>` is loaded"
# form. Backtick tokens that are NOT in a "loaded" clause (e.g. `ts-ignore` in a
# convention sentence) are deliberately NOT scanned. The broad `(e.g., …)` list
# scan is DEFERRED (54+ FPs) per the learner's "start narrow" guidance.
#
# Inline opt-out: a line carrying `<!-- canon:allow-unshipped-principle-id:
# <reason> -->` is skipped (legitimate downstream-conditional references).
#
# Exit 0: every cited id in a "loaded" clause resolves to a shipped id.
# Exit 2: one or more cited ids do not resolve, OR the gate's own arg
#         prerequisites failed (non-directory worktree_path) — fail-closed
#         (hooks-fail-closed). Emits a CANON: diagnostic on stderr for every
#         failing path (hooks-observable-failures).

set -euo pipefail

WORKTREE_PATH="${1:-}"

if [[ -n "$WORKTREE_PATH" ]] && [[ ! -d "$WORKTREE_PATH" ]]; then
  echo "CANON: principle-id-citation-check failed-closed — worktree_path not a directory: $WORKTREE_PATH" >&2
  exit 2
fi

ROOT="${WORKTREE_PATH:-$(pwd)}"

OPT_OUT_MARKER="canon:allow-unshipped-principle-id:"

# ---------------------------------------------------------------------------
# Build the resolution set (shipped ids) into a sorted file.
# ---------------------------------------------------------------------------
SET_FILE="$(mktemp)"
VIOL_FILE="$(mktemp)"
trap 'rm -f "$SET_FILE" "$VIOL_FILE"' EXIT

shopt -s nullglob
RES_FILES=(
  "$ROOT"/principles/rules/*.md
  "$ROOT"/principles/strong-opinions/*.md
  "$ROOT"/principles/conventions/*.md
  "$ROOT"/.canon/principles/rules/*.md
  "$ROOT"/.canon/principles/conventions/*.md
  "$ROOT"/rules/*.md
)
shopt -u nullglob

for f in "${RES_FILES[@]}"; do
  # First `id:` frontmatter line only; trim surrounding whitespace + quotes.
  awk '
    /^id:/ {
      line = $0
      sub(/^id:[[:space:]]*/, "", line)
      gsub(/["'"'"']/, "", line)
      sub(/[[:space:]]+$/, "", line)
      if (line != "") print line
      exit
    }
  ' "$f" >> "$SET_FILE"
done

sort -u "$SET_FILE" -o "$SET_FILE"

# ---------------------------------------------------------------------------
# Scan citation sites: agents/*.md + rules/*.md.
# For each line: skip opt-out lines; require the word 'loaded' (case-insensitive);
# extract backtick tokens appearing before 'loaded'; flag principle-shaped tokens
# not present in the resolution set.
# ---------------------------------------------------------------------------
shopt -s nullglob
SCAN_FILES=(
  "$ROOT"/agents/*.md
  "$ROOT"/rules/*.md
)
shopt -u nullglob

for f in "${SCAN_FILES[@]}"; do
  rel="${f#"$ROOT"/}"
  awk -v setfile="$SET_FILE" -v optout="$OPT_OUT_MARKER" -v relpath="$rel" '
    BEGIN {
      while ((getline id < setfile) > 0) { shipped[id] = 1 }
    }
    {
      if (index($0, optout) > 0) next
      lc = tolower($0)
      p = index(lc, "loaded")
      if (p == 0) next
      prefix = substr($0, 1, p - 1)
      n = split(prefix, parts, "`")
      # Even-indexed parts (2,4,6,…) are the inside-backtick tokens.
      for (i = 2; i <= n; i += 2) {
        tok = parts[i]
        if (tok ~ /^[a-z]+(-[a-z]+)+$/) {
          if (!(tok in shipped)) {
            print relpath ":" FNR ": " tok
          }
        }
      }
    }
  ' "$f" >> "$VIOL_FILE"
done

if [[ -s "$VIOL_FILE" ]]; then
  echo "CANON: principle-id-citation-check — unshipped principle id(s) cited as loaded:" >&2
  while IFS= read -r v; do
    [[ -n "$v" ]] && echo "  $v" >&2
  done < "$VIOL_FILE"
  exit 2
fi

echo "principle-id-citation-check: all cited ids resolve."
exit 0
