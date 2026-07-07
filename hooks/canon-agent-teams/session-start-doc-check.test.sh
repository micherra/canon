#!/usr/bin/env bash
# Tests for session-start-doc-check.sh
# Run with: bash hooks/canon-agent-teams/session-start-doc-check.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/session-start-doc-check.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/../test-helpers.sh"

PASS=0
FAIL=0

# Build a minimal git repo with a linear commit history for fixtures.
# Usage: init_repo <dir>
init_repo() {
  local dir="$1"
  git -C "$dir" init -q
  git -C "$dir" config user.email "test@example.com"
  git -C "$dir" config user.name "Test User"
  git -C "$dir" config commit.gpgsign false
  echo "init" > "$dir/README.md"
  git -C "$dir" add README.md
  git -C "$dir" commit -q -m "chore: init"
}

echo ""
echo "=== session-start-doc-check.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# No .canon directory: exits 0 silently
# ---------------------------------------------------------------------------
echo "-- No .canon directory (should pass silently) --"

DIR0=$(mktemp -d)

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR0" bash "$HOOK" 2>&1) || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]] && [[ -z "$OUTPUT" ]]; then
  echo "  PASS: no .canon dir exits 0 silently"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected silent exit 0, got exit=$EXIT_CODE output=$OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR0"

# ---------------------------------------------------------------------------
# (a) Derives reference commit from a docs(context-sync) subject commit
# ---------------------------------------------------------------------------
echo ""
echo "-- Derives ref from docs(context-sync) subject commit --"

DIR1=$(mktemp -d)
mkdir -p "$DIR1/.canon"
init_repo "$DIR1"
echo "sync" > "$DIR1/CLAUDE.md"
git -C "$DIR1" add CLAUDE.md
git -C "$DIR1" commit -q -m "docs(context-sync): initial sync"
echo "feature" > "$DIR1/feature.txt"
git -C "$DIR1" add feature.txt
git -C "$DIR1" commit -q -m "feat: add feature"
echo "fix" > "$DIR1/fix.txt"
git -C "$DIR1" add fix.txt
git -C "$DIR1" commit -q -m "fix: bug fix"

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR1" bash "$HOOK" 2>&1) || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]] && echo "$OUTPUT" | grep -q "Commits since last scribe: 2"; then
  echo "  PASS: derived ref from docs(context-sync) subject, count=2"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected 'Commits since last scribe: 2', got exit=$EXIT_CODE output: $OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR1"

# ---------------------------------------------------------------------------
# (b) Derives reference commit from a Canon-Agent: scribe trailer commit
# ---------------------------------------------------------------------------
echo ""
echo "-- Derives ref from Canon-Agent: scribe trailer commit --"

DIR2=$(mktemp -d)
mkdir -p "$DIR2/.canon"
init_repo "$DIR2"
echo "sync" > "$DIR2/CLAUDE.md"
git -C "$DIR2" add CLAUDE.md
git -C "$DIR2" commit -q -m "chore(context-sync): reconcile docs" -m "Canon-Workflow: test
Canon-Agent: scribe
Canon-State: context-sync"
echo "feature" > "$DIR2/feature.txt"
git -C "$DIR2" add feature.txt
git -C "$DIR2" commit -q -m "feat: add feature"

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR2" bash "$HOOK" 2>&1) || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]] && echo "$OUTPUT" | grep -q "Commits since last scribe: 1"; then
  echo "  PASS: derived ref from Canon-Agent: scribe trailer, count=1"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected 'Commits since last scribe: 1', got exit=$EXIT_CODE output: $OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR2"

# ---------------------------------------------------------------------------
# (c) No such commit -> falls back to marker file, then to "no checkpoint" note
# ---------------------------------------------------------------------------
echo ""
echo "-- No scribe commit found: falls back to marker file --"

DIR3=$(mktemp -d)
mkdir -p "$DIR3/.canon"
init_repo "$DIR3"
FIRST_SHA=$(git -C "$DIR3" rev-parse HEAD)
echo "feature" > "$DIR3/feature.txt"
git -C "$DIR3" add feature.txt
git -C "$DIR3" commit -q -m "feat: add feature"
echo "$FIRST_SHA" > "$DIR3/.canon/last-scribe-commit"

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR3" bash "$HOOK" 2>&1) || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]] && echo "$OUTPUT" | grep -q "Commits since last scribe: 1"; then
  echo "  PASS: fell back to marker file, count=1"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected fallback to marker file with count=1, got exit=$EXIT_CODE output: $OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR3"

echo ""
echo "-- No scribe commit found, no marker file: 'no checkpoint' note --"

DIR4=$(mktemp -d)
mkdir -p "$DIR4/.canon"
init_repo "$DIR4"
echo "feature" > "$DIR4/feature.txt"
git -C "$DIR4" add feature.txt
git -C "$DIR4" commit -q -m "feat: add feature"

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR4" bash "$HOOK" 2>&1) || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]] && echo "$OUTPUT" | grep -q "No scribe checkpoint recorded yet"; then
  echo "  PASS: no checkpoint note emitted"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected 'No scribe checkpoint recorded yet', got exit=$EXIT_CODE output: $OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR4"

# ---------------------------------------------------------------------------
# (d) Derived ref == HEAD -> silent, exit 0
# ---------------------------------------------------------------------------
echo ""
echo "-- Derived ref == HEAD (should pass silently) --"

DIR5=$(mktemp -d)
mkdir -p "$DIR5/.canon"
init_repo "$DIR5"
echo "sync" > "$DIR5/CLAUDE.md"
git -C "$DIR5" add CLAUDE.md
git -C "$DIR5" commit -q -m "docs(context-sync): sync at HEAD"

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR5" bash "$HOOK" 2>&1) || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]] && [[ -z "$OUTPUT" ]]; then
  echo "  PASS: derived ref == HEAD is silent"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected silent exit 0, got exit=$EXIT_CODE output=$OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR5"

# ---------------------------------------------------------------------------
# (e) Always exits 0, even when git itself fails (not a git repo)
# ---------------------------------------------------------------------------
echo ""
echo "-- Not a git repo: never blocks (exit 0) --"

DIR6=$(mktemp -d)
mkdir -p "$DIR6/.canon"

EXIT_CODE=0
OUTPUT=$(CANON_PROJECT_DIR="$DIR6" bash "$HOOK" 2>&1) || EXIT_CODE=$?
if [[ "$EXIT_CODE" -eq 0 ]]; then
  echo "  PASS: non-git directory exits 0 (advisory never blocks)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: expected exit 0 on git failure, got $EXIT_CODE output: $OUTPUT"
  FAIL=$((FAIL + 1))
fi
rm -rf "$DIR6"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi

exit 0
