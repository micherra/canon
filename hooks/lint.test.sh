#!/usr/bin/env bash
# hooks/lint.test.sh — Tests for hooks/lint.sh
#
# Run: bash hooks/lint.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LINT_SCRIPT="$SCRIPT_DIR/lint.sh"
PASS=0
FAIL=0

assert_exit() {
  local desc="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" -eq "$expected" ]]; then
    echo "PASS: $desc"
    PASS=$(( PASS + 1 ))
  else
    echo "FAIL: $desc (expected exit $expected, got $actual)"
    FAIL=$(( FAIL + 1 ))
  fi
}

assert_stderr_contains() {
  local desc="$1"
  local expected_pattern="$2"
  local actual_stderr="$3"
  if echo "$actual_stderr" | grep -q "$expected_pattern"; then
    echo "PASS: $desc"
    PASS=$(( PASS + 1 ))
  else
    echo "FAIL: $desc (expected stderr to contain: $expected_pattern)"
    echo "  actual stderr: $actual_stderr"
    FAIL=$(( FAIL + 1 ))
  fi
}

# ── Test setup ──────────────────────────────────────────────────────────────

# Create a temp directory that lint.sh will scan instead of the real hooks dir
TMPDIR_WORK=$(mktemp -d)
trap 'rm -rf "$TMPDIR_WORK"' EXIT

# Copy lint.sh into the temp dir so SCRIPT_DIR points there
cp "$LINT_SCRIPT" "$TMPDIR_WORK/lint.sh"
chmod +x "$TMPDIR_WORK/lint.sh"

# ── Test 1: passes on a clean file ──────────────────────────────────────────

cat > "$TMPDIR_WORK/clean.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "hello world"
EOF

actual=0
bash "$TMPDIR_WORK/lint.sh" > /dev/null 2>&1 || actual=$?
assert_exit "passes on a clean file" 0 "$actual"

# ── Test 2: detects a known shellcheck error ────────────────────────────────
# SC2066: for loop over double-quoted string (runs only once, likely unintended)

cat > "$TMPDIR_WORK/bad.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
FILES="/tmp/a.txt"
for f in "$FILES"; do
  echo "$f"
done
EOF

actual=0
bash "$TMPDIR_WORK/lint.sh" > /dev/null 2>&1 || actual=$?
assert_exit "detects a known shellcheck error (SC2066)" 1 "$actual"

# ── Test 3: skips .test.sh files ────────────────────────────────────────────
# Remove the bad.sh, add a bad .test.sh — lint should pass (tests skipped)

rm "$TMPDIR_WORK/bad.sh"

cat > "$TMPDIR_WORK/bad.test.sh" <<'EOF'
#!/usr/bin/env bash
FILES="/tmp/a.txt"
for f in "$FILES"; do
  echo "$f"
done
EOF

actual=0
bash "$TMPDIR_WORK/lint.sh" > /dev/null 2>&1 || actual=$?
assert_exit "skips .test.sh files" 0 "$actual"

# ── Test 4: skips test-helpers.sh ───────────────────────────────────────────
# test-helpers.sh with a violation should be skipped

rm "$TMPDIR_WORK/bad.test.sh"

cat > "$TMPDIR_WORK/test-helpers.sh" <<'EOF'
#!/usr/bin/env bash
FILES="/tmp/a.txt"
for f in "$FILES"; do
  echo "$f"
done
EOF

actual=0
bash "$TMPDIR_WORK/lint.sh" > /dev/null 2>&1 || actual=$?
assert_exit "skips test-helpers.sh" 0 "$actual"

# ── Test 5: fails closed when shellcheck is not in PATH ─────────────────────
# Build a minimal PATH: symlinks to every tool lint.sh needs (find, sort,
# bash, dirname, echo, cat, pwd) but NOT shellcheck.
# This is portable regardless of where shellcheck is installed (homebrew
# /opt/homebrew/bin, apt /usr/bin/shellcheck, custom path, etc.) because we
# scope PATH to a temp dir we control entirely.
# Pattern mirrors the truly-no-jq tests in destructive-guard.test.sh.

_LINT_TMPBIN=$(mktemp -d)
trap 'rm -rf "$TMPDIR_WORK" "$_LINT_TMPBIN"' EXIT

for _tool in find sort bash dirname echo cat pwd; do
  _tp=$(/usr/bin/which "$_tool" 2>/dev/null || true)
  if [[ -n "$_tp" ]]; then
    ln -sf "$_tp" "$_LINT_TMPBIN/$_tool" 2>/dev/null || true
  fi
done
# NOTE: shellcheck is intentionally NOT linked — that is the scenario under test.

actual=0
stderr_output=""
stderr_output=$(PATH="$_LINT_TMPBIN" bash "$TMPDIR_WORK/lint.sh" 2>&1 >/dev/null) || actual=$?
assert_exit "fails closed when shellcheck is not installed" 1 "$actual"
assert_stderr_contains "fail-closed stderr contains expected message" "shellcheck is not installed" "$stderr_output"

# ── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
