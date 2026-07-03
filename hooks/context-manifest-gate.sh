#!/bin/bash
# context-manifest-gate.sh — Deterministic context-manifest-freshness gate.
#
# Invoked by the verify contract (not as a hooks.json PreToolUse hook).
# Signature: bash hooks/context-manifest-gate.sh [worktree_path]
#
# Unlike dead-wire-gate.sh / shell-test-gate.sh, this gate takes ONLY an
# optional [worktree_path] — no <base_commit>. Freshness is a WHOLE-TREE
# property (does committed context-manifest.json match the current corpus),
# not a diff-scoped one: it recomputes from the worktree source and compares
# to the worktree's own committed manifest; it never reads a git diff.
#
# Run from the worktree root, OR pass the worktree as the optional trailing
# worktree_path arg (watch_CCCCCCCCCCCC2) — this gate resolves its source
# tree + committed manifest from that arg (or CWD when absent), not from
# git, so it must be invoked with the worktree as CWD or the worktree passed
# as the arg. Invoking from the gitignored WORKSPACE dir fails closed (no
# mcp-server/ there).
#
# Exit 0: committed context-manifest.json matches a freshly-built manifest
#         of the corpus.
# Exit 2: manifest is stale (added/removed/edited artifact or version drift),
#         or the check could not be run (bad arg, absent mcp-server, node/tsx
#         failure) — fail-closed.
#
# All drift semantics (what changed, the fix command) live in the tested TS
# (`scripts/regen-context-manifest.ts --check`, `context-manifest.ts`). This
# shell layer only handles arg validation, CWD, and exit-code relay — it does
# NOT source canon-hook-lib.sh (no git-token parsing needed) and does NOT
# read the git diff.

set -euo pipefail

WORKTREE_PATH="${1:-}"

if [[ -n "$WORKTREE_PATH" ]] && [[ ! -d "$WORKTREE_PATH" ]]; then
  echo "CANON: context-manifest-gate failed-closed — worktree_path not a directory: $WORKTREE_PATH" >&2
  exit 2
fi

ROOT="${WORKTREE_PATH:-$(pwd)}"

if [[ ! -d "$ROOT/mcp-server" ]]; then
  echo "CANON: context-manifest-gate failed-closed — mcp-server not found under: $ROOT" >&2
  exit 2
fi

OUT=""
RC=0
OUT=$( cd "$ROOT/mcp-server" && npm run --silent regen:context-manifest -- --check 2>&1 ) || RC=$?

if [[ "$RC" -eq 0 ]]; then
  echo "context-manifest-gate: manifest fresh."
  exit 0
fi

echo "$OUT" >&2
echo "CANON: context-manifest-gate — committed context-manifest.json is stale or uncheckable (rc=$RC)." >&2
exit 2
