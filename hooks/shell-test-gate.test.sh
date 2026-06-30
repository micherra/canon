#!/bin/bash
# Tests for shell-test-gate.sh
# Run with: bash hooks/shell-test-gate.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures
#
# All tests use isolated temp git repos. No hard-coded paths; safe for CI.
#
# ANTI-RECURSION INVARIANT: shell-test-gate.sh enumerates `find hooks -type f
# -name '*.test.sh'` relative to CWD. Every invocation of the gate in this
# suite MUST `cd` into a temp fixture repo — NEVER run the gate against the
# real repo root. Fixture repos contain only tiny stub *.test.sh files, so the
# gate's find scopes to stubs only, terminating at recursion depth 2
# (real gate → this test → fixture gate → fixture stub). See DESIGN §Anti-recursion.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/shell-test-gate.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

MASTER_TMP=$(mktemp -d)
trap 'rm -rf "$MASTER_TMP"' EXIT

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

# init_fixture_repo <dir>
# Creates a minimal git repo with a README initial commit.
init_fixture_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" config user.email "test@example.com"
  git -C "$dir" config user.name "Test User"
  git -C "$dir" config commit.gpgsign false
  echo "placeholder" > "$dir/README.md"
  git -C "$dir" add README.md
  git -C "$dir" commit -q -m "init"
}

# run_gate <description> <expected_exit> <repo> <base>
# Runs the gate in <repo> with <base> as the base commit.
# ANTI-RECURSION: always cds into the fixture repo, never the real repo root.
run_gate() {
  local description="$1"
  local expected_exit="$2"
  local repo="$3"
  local base="$4"

  local actual_exit=0
  (cd "$repo" && bash "$GATE" "$base" </dev/null >/dev/null 2>&1) || actual_exit=$?

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

# run_gate_with_output <description> <expected_pattern> <repo> <base>
# Runs the gate and checks exit 0 AND stdout+stderr contains expected_pattern.
run_gate_with_output() {
  local description="$1"
  local expected_pattern="$2"
  local repo="$3"
  local base="$4"

  local output
  local actual_exit=0
  output=$(cd "$repo" && bash "$GATE" "$base" </dev/null 2>&1) || actual_exit=$?

  local exit_ok=true
  local output_ok=true

  if [[ "$actual_exit" -ne 0 ]]; then
    exit_ok=false
  fi
  if ! echo "$output" | grep -qF "$expected_pattern"; then
    output_ok=false
  fi

  if [[ "$exit_ok" == "true" ]] && [[ "$output_ok" == "true" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    if [[ "$exit_ok" == "false" ]]; then
      echo "        expected exit=0, got exit=$actual_exit"
    fi
    if [[ "$output_ok" == "false" ]]; then
      echo "        expected output containing: $expected_pattern"
      echo "        actual output: $output"
    fi
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "=== shell-test-gate.sh tests ==="
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Argument validation — fail-closed cases (AC#4)
# ─────────────────────────────────────────────────────────────────────────────
echo "-- Argument validation --"

# Need a real git repo for arg-validation tests so git commands inside the gate
# don't fail for environmental reasons before reaching the validation check.
ARGVAL_REPO="$MASTER_TMP/argval"
init_fixture_repo "$ARGVAL_REPO"
ARGVAL_BASE=$(git -C "$ARGVAL_REPO" rev-parse HEAD)

# Case a: missing base_commit → non-zero (fail-closed)
CASE_A_EXIT=0
(cd "$ARGVAL_REPO" && bash "$GATE" </dev/null >/dev/null 2>&1) || CASE_A_EXIT=$?
if [[ "$CASE_A_EXIT" -ne 0 ]]; then
  echo "  PASS: missing base_commit → non-zero (exit $CASE_A_EXIT)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: missing base_commit → non-zero (got exit 0)"
  FAIL=$((FAIL + 1))
fi

# Case b: invalid/nonexistent base commit → non-zero (fail-closed)
CASE_B_EXIT=0
(cd "$ARGVAL_REPO" && bash "$GATE" "deadbeef12345678deadbeef12345678deadbeef" </dev/null >/dev/null 2>&1) || CASE_B_EXIT=$?
if [[ "$CASE_B_EXIT" -ne 0 ]]; then
  echo "  PASS: invalid base_commit → non-zero (exit $CASE_B_EXIT)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: invalid base_commit → non-zero (got exit 0)"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────────────────────────
# Case c: in-scope hook .sh changed, all fixture suites pass → exit 0
# Also verify "=== hooks/stub-pass.test.sh ===" line appears (AC#1,2)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case c: in-scope .sh change, all suites pass → exit 0 + === line --"

CASEC_REPO="$MASTER_TMP/casec"
init_fixture_repo "$CASEC_REPO"

mkdir -p "$CASEC_REPO/hooks"
printf '#!/bin/bash\nexit 0\n' > "$CASEC_REPO/hooks/stub-pass.test.sh"
git -C "$CASEC_REPO" add hooks/stub-pass.test.sh
git -C "$CASEC_REPO" commit -q -m "add passing stub suite"
CASEC_BASE=$(git -C "$CASEC_REPO" rev-parse HEAD)

# In-scope change: add a hooks/ .sh file
printf '#!/bin/bash\n# no-op\n' > "$CASEC_REPO/hooks/foo.sh"
git -C "$CASEC_REPO" add hooks/foo.sh
git -C "$CASEC_REPO" commit -q -m "add foo.sh (in-scope change)"

run_gate_with_output \
  "in-scope .sh change, all suites pass → exit 0 + === banner" \
  "=== hooks/stub-pass.test.sh ===" \
  "$CASEC_REPO" "$CASEC_BASE"

# ─────────────────────────────────────────────────────────────────────────────
# Case d: in-scope change, one fixture suite exits 1 → exit 2 (AC#4)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case d: in-scope change + failing suite → exit 2 --"

CASED_REPO="$MASTER_TMP/cased"
init_fixture_repo "$CASED_REPO"

mkdir -p "$CASED_REPO/hooks"
printf '#!/bin/bash\nexit 1\n' > "$CASED_REPO/hooks/stub-fail.test.sh"
git -C "$CASED_REPO" add hooks/stub-fail.test.sh
git -C "$CASED_REPO" commit -q -m "add failing stub suite"
CASED_BASE=$(git -C "$CASED_REPO" rev-parse HEAD)

printf '#!/bin/bash\n# no-op\n' > "$CASED_REPO/hooks/bar.sh"
git -C "$CASED_REPO" add hooks/bar.sh
git -C "$CASED_REPO" commit -q -m "add bar.sh (in-scope change)"

run_gate "in-scope .sh change + failing suite → exit 2" 2 "$CASED_REPO" "$CASED_BASE"

# ─────────────────────────────────────────────────────────────────────────────
# Case e: no hook change (only src/app.ts changed) → exit 0 no-op (AC#6)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case e: no in-scope hook change (src/app.ts only) → exit 0 no-op --"

CASEE_REPO="$MASTER_TMP/casee"
init_fixture_repo "$CASEE_REPO"

# Add a stub suite so gate has something to enumerate if scope detection breaks
mkdir -p "$CASEE_REPO/hooks"
printf '#!/bin/bash\nexit 0\n' > "$CASEE_REPO/hooks/stub-pass.test.sh"
git -C "$CASEE_REPO" add hooks/stub-pass.test.sh
git -C "$CASEE_REPO" commit -q -m "add stub suite"
CASEE_BASE=$(git -C "$CASEE_REPO" rev-parse HEAD)

# Out-of-scope change: src/app.ts
mkdir -p "$CASEE_REPO/src"
echo "// app" > "$CASEE_REPO/src/app.ts"
git -C "$CASEE_REPO" add src/app.ts
git -C "$CASEE_REPO" commit -q -m "add src/app.ts (out-of-scope)"

run_gate "no in-scope hook change → exit 0 no-op" 0 "$CASEE_REPO" "$CASEE_BASE"

# ─────────────────────────────────────────────────────────────────────────────
# Case f: doc-only under hooks (hooks/notes.md) → exit 0 no-op (AC#6)
# Filter ^hooks/.*\.(sh|mjs)$ excludes .md files
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case f: hooks/notes.md only → exit 0 no-op (filter excludes .md) --"

CASEF_REPO="$MASTER_TMP/casef"
init_fixture_repo "$CASEF_REPO"

mkdir -p "$CASEF_REPO/hooks"
printf '#!/bin/bash\nexit 0\n' > "$CASEF_REPO/hooks/stub-pass.test.sh"
git -C "$CASEF_REPO" add hooks/stub-pass.test.sh
git -C "$CASEF_REPO" commit -q -m "add stub suite"
CASEF_BASE=$(git -C "$CASEF_REPO" rev-parse HEAD)

# Change: add a .md file under hooks/ (excluded by .sh|.mjs filter)
echo "# hook notes" > "$CASEF_REPO/hooks/notes.md"
git -C "$CASEF_REPO" add hooks/notes.md
git -C "$CASEF_REPO" commit -q -m "add hooks/notes.md (doc-only, excluded)"

run_gate "hooks/notes.md change → exit 0 no-op (non-.sh/.mjs excluded)" 0 "$CASEF_REPO" "$CASEF_BASE"

# ─────────────────────────────────────────────────────────────────────────────
# Case g: NESTED suite hooks/sub/deep.test.sh failing + in-scope change → exit 2
# Proves find-depth parity with CI's globstar (AC#8): find locates nested suites
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case g: nested failing suite (hooks/sub/deep.test.sh) → exit 2 (find-depth parity) --"

CASEG_REPO="$MASTER_TMP/caseg"
init_fixture_repo "$CASEG_REPO"

# Nested failing suite at hooks/sub/deep.test.sh
mkdir -p "$CASEG_REPO/hooks/sub"
printf '#!/bin/bash\nexit 1\n' > "$CASEG_REPO/hooks/sub/deep.test.sh"
git -C "$CASEG_REPO" add hooks/sub/deep.test.sh
git -C "$CASEG_REPO" commit -q -m "add nested failing suite"
CASEG_BASE=$(git -C "$CASEG_REPO" rev-parse HEAD)

printf '#!/bin/bash\n# no-op\n' > "$CASEG_REPO/hooks/baz.sh"
git -C "$CASEG_REPO" add hooks/baz.sh
git -C "$CASEG_REPO" commit -q -m "add baz.sh (in-scope change)"

run_gate \
  "nested suite hooks/sub/deep.test.sh failing → exit 2 (find-depth parity)" \
  2 "$CASEG_REPO" "$CASEG_BASE"

# ─────────────────────────────────────────────────────────────────────────────
# Case h: suite exits non-zero (exit 3) → exit 2 fail-closed (AC#4)
# Any non-zero suite RC fails closed; not skipped silently
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case h: suite exits 3 (non-zero) → exit 2 fail-closed --"

CASEH_REPO="$MASTER_TMP/caseh"
init_fixture_repo "$CASEH_REPO"

mkdir -p "$CASEH_REPO/hooks"
printf '#!/bin/bash\nexit 3\n' > "$CASEH_REPO/hooks/bad.test.sh"
git -C "$CASEH_REPO" add hooks/bad.test.sh
git -C "$CASEH_REPO" commit -q -m "add suite exiting 3"
CASEH_BASE=$(git -C "$CASEH_REPO" rev-parse HEAD)

printf '#!/bin/bash\n# no-op\n' > "$CASEH_REPO/hooks/qux.sh"
git -C "$CASEH_REPO" add hooks/qux.sh
git -C "$CASEH_REPO" commit -q -m "add qux.sh (in-scope change)"

run_gate "suite exits 3 (non-zero) → exit 2 fail-closed" 2 "$CASEH_REPO" "$CASEH_BASE"

# ─────────────────────────────────────────────────────────────────────────────
# Case i: in-scope .mjs-only change → gate fires (AC#1,2)
# Case c proves .sh triggers the gate; this case proves .mjs also triggers.
# The scope filter is `^hooks/.*\.(sh|mjs)$` — both extensions must fire.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case i: in-scope .mjs-only change → gate fires (filter includes .mjs) --"

CASEI_REPO="$MASTER_TMP/casei"
init_fixture_repo "$CASEI_REPO"

mkdir -p "$CASEI_REPO/hooks"
printf '#!/bin/bash\nexit 0\n' > "$CASEI_REPO/hooks/stub-pass.test.sh"
git -C "$CASEI_REPO" add hooks/stub-pass.test.sh
git -C "$CASEI_REPO" commit -q -m "add passing stub suite"
CASEI_BASE=$(git -C "$CASEI_REPO" rev-parse HEAD)

# In-scope change: a hooks/*.mjs file only — no .sh change
printf '// no-op\n' > "$CASEI_REPO/hooks/tool.mjs"
git -C "$CASEI_REPO" add hooks/tool.mjs
git -C "$CASEI_REPO" commit -q -m "add tool.mjs (in-scope .mjs-only change)"

run_gate_with_output \
  "in-scope .mjs-only change → gate fires, runs suite, exit 0 + === banner" \
  "=== hooks/stub-pass.test.sh ===" \
  "$CASEI_REPO" "$CASEI_BASE"

# ─────────────────────────────────────────────────────────────────────────────
# Case j: stdin non-hang — suite doing `read x` completes via </dev/null
# PROBE §3a showed a stdin-reading suite hangs the gate when stdin is a tty.
# The gate passes </dev/null to every suite; confirm a read-stdin suite
# completes immediately (read gets EOF → exits 1; || true makes suite exit 0).
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case j: stdin non-hang — read-stdin suite exits 0 via </dev/null --"

CASEJ_REPO="$MASTER_TMP/casej"
init_fixture_repo "$CASEJ_REPO"

mkdir -p "$CASEJ_REPO/hooks"
# `read x` returns 1 on EOF (stdin=/dev/null); || true makes suite exit 0
printf '#!/bin/bash\nread x || true\nexit 0\n' > "$CASEJ_REPO/hooks/read-stdin.test.sh"
git -C "$CASEJ_REPO" add hooks/read-stdin.test.sh
git -C "$CASEJ_REPO" commit -q -m "add read-stdin suite"
CASEJ_BASE=$(git -C "$CASEJ_REPO" rev-parse HEAD)

printf '#!/bin/bash\n# trigger\n' > "$CASEJ_REPO/hooks/trigger.sh"
git -C "$CASEJ_REPO" add hooks/trigger.sh
git -C "$CASEJ_REPO" commit -q -m "add trigger.sh (in-scope change)"

CASEJ_RC=0
export GATE CASEJ_REPO CASEJ_BASE
if command -v timeout >/dev/null 2>&1; then
  timeout 10 bash -c '(cd "$CASEJ_REPO" && bash "$GATE" "$CASEJ_BASE" </dev/null >/dev/null 2>&1)' || CASEJ_RC=$?
else
  (cd "$CASEJ_REPO" && bash "$GATE" "$CASEJ_BASE" </dev/null >/dev/null 2>&1) || CASEJ_RC=$?
fi

if [[ "$CASEJ_RC" -eq 0 ]]; then
  echo "  PASS: stdin non-hang — read-stdin suite completed without hanging (exit 0)"
  PASS=$((PASS + 1))
elif [[ "$CASEJ_RC" -eq 124 ]]; then
  echo "  FAIL: stdin non-hang — gate timed out (</dev/null not passed to suite)"
  FAIL=$((FAIL + 1))
else
  echo "  FAIL: stdin non-hang — unexpected exit $CASEJ_RC"
  FAIL=$((FAIL + 1))
fi

# ─────────────────────────────────────────────────────────────────────────────
# Case k: unrunnable suite (bash syntax error) → exit 2 fail-closed (AC#4d)
# Confirms the gate does NOT silently skip a suite bash cannot parse.
# bash "$t" on a syntax-error file exits non-zero → SUITE_RC captured → exit 2.
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Case k: unrunnable suite (bash syntax error) → exit 2 fail-closed (AC#4d) --"

CASEK_REPO="$MASTER_TMP/casek"
init_fixture_repo "$CASEK_REPO"

mkdir -p "$CASEK_REPO/hooks"
# Intentional bash syntax error: unmatched open paren; bash exits 2, not silently skipped
printf '#!/bin/bash\n(\n' > "$CASEK_REPO/hooks/syntax-err.test.sh"
git -C "$CASEK_REPO" add hooks/syntax-err.test.sh
git -C "$CASEK_REPO" commit -q -m "add syntax-error stub suite"
CASEK_BASE=$(git -C "$CASEK_REPO" rev-parse HEAD)

printf '#!/bin/bash\n# trigger\n' > "$CASEK_REPO/hooks/foo.sh"
git -C "$CASEK_REPO" add hooks/foo.sh
git -C "$CASEK_REPO" commit -q -m "add foo.sh (in-scope change)"

run_gate "unrunnable suite (bash syntax error) → exit 2 fail-closed" 2 "$CASEK_REPO" "$CASEK_BASE"

# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi

exit 0
