#!/bin/bash
# shell-test-gate.sh — Shell-CI parity gate.
#
# Invoked by the verify contract (not as a hooks.json PreToolUse hook).
# Signature: bash hooks/shell-test-gate.sh <base_commit> [worktree_path]
# Run from the worktree root, OR pass the worktree as the optional trailing
# worktree_path arg — the git diff scope check resolves via `git -C
# "$worktree_path"`, and the hooks/**/*.test.sh enumeration resolves under it
# too, making CWD irrelevant (watch_CCCCCCCCCCCC2). Absent → current
# CWD-relative behavior (backward-compatible).
#
# When any hooks/**/*.sh or *.mjs file changed in base..HEAD, executes the
# full hooks/**/*.test.sh suite set that CI's `shell` job runs, aggregating
# failures without aborting mid-loop (mirrors CI behavior). Clean no-op
# (exit 0) when no in-scope file changed.
#
# Exit semantics:
#   Exit 0: all suites passed — or no in-scope hook script changed (no-op)
#   Exit 2: one or more suites returned non-zero (fail-closed)
#   Exit non-zero (other): internal error — fail-closed
#
# D1 GLOBSTAR-PARITY RATIONALE (see DESIGN Decision D1, PROBE-FINDINGS §2):
# CI (ci.yml job `shell`, lines 26–38) uses:
#   shopt -s globstar nullglob
#   for t in hooks/**/*.test.sh; do bash "$t" || failed=1; done
#
# macOS / local bash 3.2.57 has NO globstar support:
#   bash -c 'shopt -s globstar' → "bash: shopt: globstar: invalid shell option name"
# Without globstar, hooks/**/*.test.sh silently degrades to one-level-deep only
# (12 of 30 files), missing top-level hooks/*.test.sh and subdirectory suites.
#
# We mirror CI's file SET (all depths), not CI's glob syntax, via:
#   find hooks -type f -name '*.test.sh' | sort
# Probe-verified: `find` and globstar return the identical 30-file set at all
# depths (PROBE-FINDINGS.md §2-3). `sort` ensures deterministic execution order.

set -euo pipefail

BASE_COMMIT="${1:-}"
WORKTREE_PATH="${2:-}"

# ---------------------------------------------------------------------------
# Argument validation (fail-closed)
# ---------------------------------------------------------------------------
if [[ -z "$BASE_COMMIT" ]]; then
  echo "CANON: shell-test-gate failed-closed — usage: shell-test-gate.sh <base_commit> [worktree_path]" >&2
  exit 2
fi

if [[ -n "$WORKTREE_PATH" ]] && [[ ! -d "$WORKTREE_PATH" ]]; then
  echo "CANON: shell-test-gate failed-closed — worktree_path not a directory: $WORKTREE_PATH" >&2
  exit 2
fi

# GIT_C prefixes every internal git call with -C "$WORKTREE_PATH" when set,
# making CWD irrelevant; empty (CWD-relative) when unset. Bash 3.2-safe empty
# array expansion (house idiom — see push-to-main-guard.sh contract).
# WORKTREE_PREFIX resolves the hooks/**/*.test.sh enumeration under the same
# worktree — `git -C` only repoints git's own commands, not `find`.
GIT_C=()
WORKTREE_PREFIX=""
if [[ -n "$WORKTREE_PATH" ]]; then
  GIT_C=(-C "$WORKTREE_PATH")
  WORKTREE_PREFIX="${WORKTREE_PATH%/}/"
fi

if ! git "${GIT_C[@]+"${GIT_C[@]}"}" rev-parse --verify "$BASE_COMMIT" >/dev/null 2>&1; then
  echo "CANON: shell-test-gate failed-closed — invalid base commit: $BASE_COMMIT" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Scope detection: any hooks/**/*.sh or *.mjs changed in base..HEAD?
# ---------------------------------------------------------------------------
DIFF_OUTPUT=""
# --no-renames: disable git's rename detection so a `git mv hooks/foo.sh
# hooks/foo.txt` shows BOTH the deleted source path (hooks/foo.sh — which
# matches the .sh filter and correctly fires the gate) AND the added
# destination path.  With default rename detection ON, only the destination
# path is reported, causing a false no-op when a hook .sh is moved/renamed.
if ! DIFF_OUTPUT=$(git "${GIT_C[@]+"${GIT_C[@]}"}" diff --name-only --no-renames "${BASE_COMMIT}..HEAD" 2>&1); then
  echo "CANON: shell-test-gate failed-closed — git diff failed: $DIFF_OUTPUT" >&2
  exit 2
fi

# Filter to in-scope paths: any file under hooks/ matching *.sh or *.mjs
# grep rc1 (no match) means no in-scope change — treat as no-op, NOT an error.
# DOCUMENTED FAIL-OPEN -- grep rc1 = no in-scope change; downstream: exit 0 no-op
INSCOPE=""
INSCOPE=$(echo "$DIFF_OUTPUT" | grep -E '^hooks/.*\.(sh|mjs)$' || true)

if [[ -z "$INSCOPE" ]]; then
  echo "shell-test-gate: no in-scope hook scripts changed in ${BASE_COMMIT}..HEAD — no-op."
  exit 0
fi

# ---------------------------------------------------------------------------
# Enumerate the full hooks/**/*.test.sh suite set (CI-parity via `find`)
#
# D1: `find hooks -type f -name '*.test.sh' | sort` mirrors CI's globstar set
# at all depths (top-level, one-level, __tests__/) on bash 3.2 (no mapfile,
# no shopt -s globstar). Fail-closed if find errors.
#
# Latent under-inclusion: `find -type f` skips hidden directories (e.g.
# hooks/.claude/) and does NOT follow symlinks. There are zero such *.test.sh
# files today; the over-inclusion direction is fail-closed-safe. If a
# hidden-dir or symlinked hook test is ever added, revisit this enumeration
# (add -L for symlinks or explicit hidden-dir paths as needed).
# ---------------------------------------------------------------------------
SUITE_LIST=""
if ! SUITE_LIST=$(find "${WORKTREE_PREFIX}hooks" -type f -name '*.test.sh' 2>&1 | sort); then
  echo "CANON: shell-test-gate failed-closed — find failed: $SUITE_LIST" >&2
  exit 2
fi

# Load into array using while-read (bash 3.2 compatible; mapfile requires bash 4)
SUITES=()
while IFS= read -r line; do
  [[ -n "$line" ]] && SUITES+=("$line")
done <<< "$SUITE_LIST"

SUITE_COUNT="${#SUITES[@]}"

if [[ "$SUITE_COUNT" -eq 0 ]]; then
  echo "shell-test-gate: no *.test.sh suites found under hooks/ — no-op."
  exit 0
fi

# ---------------------------------------------------------------------------
# Run all suites; aggregate exit codes (mirror CI's || failed=1, no abort)
#
# Each suite runs as `bash "$t" </dev/null` — the </dev/null is MANDATORY:
# it matches CI's effective stdin (GitHub Actions sets stdin to /dev/null) and
# prevents the loop-stdin hang where a suite reading stdin blocks on the pipe
# (PROBE-FINDINGS.md §3a — hang disappears entirely with </dev/null).
#
# When WORKTREE_PATH is set, each suite runs with CWD = WORKTREE_PATH (not the
# caller's CWD). $t is already WORKTREE_PREFIX-prefixed, so it still resolves
# correctly after the cd; but a suite that reads repo-root-relative paths
# (e.g. `bash hooks/foo.sh`) needs CWD anchored at the target worktree to
# match CI, which always runs suites from the checkout root (Codex P2 fix —
# WORKTREE_PREFIX alone only fixed suite *discovery*, not suite *execution*).
#
# timeout (coreutils) is applied when available; not guaranteed on stock macOS.
# CAP=180s is generous (slowest passing suite is ~31s; PROBE §3b); a timeout-
# kill (rc 124/137) counts as a failure — fail-closed.
# ---------------------------------------------------------------------------
FAILED_SUITES=()

for t in "${SUITES[@]}"; do
  echo "=== $t ==="
  SUITE_RC=0

  if [[ -n "$WORKTREE_PATH" ]]; then
    if command -v timeout >/dev/null 2>&1; then
      ( cd "$WORKTREE_PATH" && timeout -k 5 180 bash "$t" </dev/null ) || SUITE_RC=$?
    else
      ( cd "$WORKTREE_PATH" && bash "$t" </dev/null ) || SUITE_RC=$?
    fi
  else
    if command -v timeout >/dev/null 2>&1; then
      timeout -k 5 180 bash "$t" </dev/null || SUITE_RC=$?
    else
      bash "$t" </dev/null || SUITE_RC=$?
    fi
  fi

  if [[ "$SUITE_RC" -ne 0 ]]; then
    FAILED_SUITES+=("$t (rc=$SUITE_RC)")
  fi
done

# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------
FAILED_COUNT="${#FAILED_SUITES[@]}"

if [[ "$FAILED_COUNT" -gt 0 ]]; then
  echo "CANON: shell-test-gate — $FAILED_COUNT hook suite(s) failed:" >&2
  for s in "${FAILED_SUITES[@]}"; do
    echo "  $s" >&2
  done
  exit 2
fi

echo "shell-test-gate: $SUITE_COUNT hook test suite(s) passed."
exit 0
