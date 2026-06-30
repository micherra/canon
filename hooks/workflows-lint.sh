#!/usr/bin/env bash
# hooks/workflows-lint.sh — Fail-closed shell gate for the workflows/ CI lint.
#
# Mirrors hooks/dead-wire-gate.sh: resolves repo root from BASH_SOURCE (not cwd),
# fails closed (exit 1) when node or the typescript dep is absent, then delegates
# to the node lint helper and propagates its exit code.
#
# hooks-fail-closed: this gate NEVER silently passes when it cannot run the check.
# Any missing dependency causes a loud ERROR to stderr and a non-zero exit.
#
# Usage: bash hooks/workflows-lint.sh
# Exit 0: all workflows/*.js files pass the lint (or no files to lint).
# Exit 1: one or more violations found, or the check cannot run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

LINT_HELPER="$REPO_ROOT/mcp-server/scripts/workflows-lint.mjs"
WORKFLOWS_DIR="$REPO_ROOT/workflows"
TS_DEP="$REPO_ROOT/mcp-server/node_modules/typescript"

# ── Fail-closed dependency checks (hooks-fail-closed) ───────────────────────
# node absent → cannot run the check → non-zero exit (never silent pass)
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: [workflows-lint] 'node' is not on PATH — cannot run workflows lint (hooks-fail-closed)." >&2
  exit 1
fi

# typescript dep absent → cannot import → non-zero exit
if [[ ! -d "$TS_DEP" ]]; then
  echo "ERROR: [workflows-lint] typescript dependency not found at $TS_DEP — cannot run workflows lint (hooks-fail-closed)." >&2
  exit 1
fi

# ── Delegate to node helper and propagate its exit code ─────────────────────
node "$LINT_HELPER" "$WORKFLOWS_DIR"
