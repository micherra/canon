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

# ── Install-faithfulness check tests ────────────────────────────────────────
#
# Each test creates an isolated git repo, copies lint.sh into hooks/ so that
# SCRIPT_DIR and REPO_ROOT resolve to the fixture repo (not the real worktree).
# Calling `bash "$fixture_repo/hooks/lint.sh"` scopes both the shellcheck scan
# and the install-faithfulness checks to the fixture repo only.

# Fresh tmpdir for install-faithfulness fixtures (separate from shellcheck dir).
IF_TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR_WORK" "$_LINT_TMPBIN" "$IF_TMPDIR"' EXIT

# make_clean_git_repo <dir>
# Creates a minimal git repo with hooks/lint.sh (copy of real) + a clean
# hooks/check.sh so the shellcheck step passes. Returns quickly.
make_clean_git_repo() {
  local dir="$1"
  git -C "$dir" init -q
  git -C "$dir" config user.email "test@example.com"
  git -C "$dir" config user.name "Test"
  mkdir -p "$dir/hooks"
  cp "$LINT_SCRIPT" "$dir/hooks/lint.sh"
  cat > "$dir/hooks/check.sh" <<'SHEOF'
#!/usr/bin/env bash
set -euo pipefail
echo "ok"
SHEOF
  git -C "$dir" add hooks/lint.sh hooks/check.sh
  git -C "$dir" commit -q -m "init"
}

# ── Check 1 positive: tracked .tool-versions → lint FAILS ───────────────────

REPO_C1_POS="$IF_TMPDIR/c1_pos"
mkdir -p "$REPO_C1_POS"
make_clean_git_repo "$REPO_C1_POS"
echo "nodejs 20.0.0" > "$REPO_C1_POS/.tool-versions"
git -C "$REPO_C1_POS" add .tool-versions
git -C "$REPO_C1_POS" commit -q -m "add tool-versions"

actual=0
bash "$REPO_C1_POS/hooks/lint.sh" > /dev/null 2>&1 || actual=$?
assert_exit "Check 1 positive: tracked .tool-versions is caught (exit≠0)" 1 "$actual"

# ── Check 1 positive: tracked .nvmrc → lint FAILS ───────────────────────────

REPO_C1_NVMRC="$IF_TMPDIR/c1_nvmrc"
mkdir -p "$REPO_C1_NVMRC"
make_clean_git_repo "$REPO_C1_NVMRC"
echo "v20.0.0" > "$REPO_C1_NVMRC/.nvmrc"
git -C "$REPO_C1_NVMRC" add .nvmrc
git -C "$REPO_C1_NVMRC" commit -q -m "add nvmrc"

actual=0
bash "$REPO_C1_NVMRC/hooks/lint.sh" > /dev/null 2>&1 || actual=$?
assert_exit "Check 1 positive: tracked .nvmrc is caught (exit≠0)" 1 "$actual"

# ── Check 1 positive: error message contains #361 ────────────────────────────

result_str=""
result_str=$(bash "$REPO_C1_POS/hooks/lint.sh" 2>&1) || true
assert_stderr_contains "Check 1 error mentions #361" "#361" "$result_str"

# ── Check 1 negative: no toolchain pin → lint PASSES ────────────────────────

REPO_C1_NEG="$IF_TMPDIR/c1_neg"
mkdir -p "$REPO_C1_NEG"
make_clean_git_repo "$REPO_C1_NEG"

actual=0
bash "$REPO_C1_NEG/hooks/lint.sh" > /dev/null 2>&1 || actual=$?
assert_exit "Check 1 negative: no toolchain pin → passes" 0 "$actual"

# ── Check 1 negative: gitignored .tool-versions is NOT caught ────────────────

REPO_C1_IGNORED="$IF_TMPDIR/c1_ignored"
mkdir -p "$REPO_C1_IGNORED"
make_clean_git_repo "$REPO_C1_IGNORED"
# Add .tool-versions to .gitignore (tracked); do NOT track the file itself
echo ".tool-versions" > "$REPO_C1_IGNORED/.gitignore"
git -C "$REPO_C1_IGNORED" add .gitignore
git -C "$REPO_C1_IGNORED" commit -q -m "add gitignore"
# Create the file as untracked/ignored — must NOT be flagged
echo "nodejs 20.0.0" > "$REPO_C1_IGNORED/.tool-versions"

actual=0
bash "$REPO_C1_IGNORED/hooks/lint.sh" > /dev/null 2>&1 || actual=$?
assert_exit "Check 1 negative: gitignored .tool-versions is NOT caught" 0 "$actual"

# ── Check 2 positive: .mcp.json with token in args → lint FAILS ──────────────

REPO_C2_POS="$IF_TMPDIR/c2_pos"
mkdir -p "$REPO_C2_POS"
make_clean_git_repo "$REPO_C2_POS"
# The pre-#356 dangerous form: ${CLAUDE_PLUGIN_ROOT:-.} inside args
cat > "$REPO_C2_POS/.mcp.json" <<'JSONEOF'
{
  "mcpServers": {
    "canon": {
      "command": "bash",
      "args": ["${CLAUDE_PLUGIN_ROOT:-.}/mcp-server/boot.sh"],
      "env": {
        "CANON_PROJECT_DIR": "${CLAUDE_PROJECT_DIR:-.}"
      }
    }
  }
}
JSONEOF
git -C "$REPO_C2_POS" add .mcp.json
git -C "$REPO_C2_POS" commit -q -m "add mcp.json with plugin root in args"

actual=0
bash "$REPO_C2_POS/hooks/lint.sh" > /dev/null 2>&1 || actual=$?
assert_exit "Check 2 positive: .mcp.json with \${CLAUDE_PLUGIN_ROOT} in args is caught" 1 "$actual"

# ── Check 2 positive: error message contains #356 ────────────────────────────

result_str=""
result_str=$(bash "$REPO_C2_POS/hooks/lint.sh" 2>&1) || true
assert_stderr_contains "Check 2 error mentions #356" "#356" "$result_str"

# ── Check 2 negative: token only in command/env → lint PASSES ────────────────

REPO_C2_NEG="$IF_TMPDIR/c2_neg"
mkdir -p "$REPO_C2_NEG"
make_clean_git_repo "$REPO_C2_NEG"
# The post-#356 fixed form: token in command and env, NOT in args
cat > "$REPO_C2_NEG/.mcp.json" <<'JSONEOF'
{
  "mcpServers": {
    "canon": {
      "command": "${CLAUDE_PLUGIN_ROOT:-.}/mcp-server/boot.sh",
      "args": [],
      "env": {
        "CANON_PROJECT_DIR": "${CLAUDE_PROJECT_DIR:-.}",
        "PLUGIN_ROOT": "${CLAUDE_PLUGIN_ROOT:-.}"
      }
    }
  }
}
JSONEOF
git -C "$REPO_C2_NEG" add .mcp.json
git -C "$REPO_C2_NEG" commit -q -m "add safe mcp.json"

actual=0
bash "$REPO_C2_NEG/hooks/lint.sh" > /dev/null 2>&1 || actual=$?
assert_exit "Check 2 negative: token only in command/env → passes" 0 "$actual"

# ── Check 2 skip: jq unavailable → no hard-fail, prints skip notice ──────────

REPO_C2_SKIP="$IF_TMPDIR/c2_skip"
mkdir -p "$REPO_C2_SKIP"
make_clean_git_repo "$REPO_C2_SKIP"
# Add a dangerous .mcp.json — with jq absent, check must skip (not hard-fail)
cat > "$REPO_C2_SKIP/.mcp.json" <<'JSONEOF'
{
  "mcpServers": {
    "canon": {
      "command": "bash",
      "args": ["${CLAUDE_PLUGIN_ROOT:-.}/mcp-server/boot.sh"]
    }
  }
}
JSONEOF
git -C "$REPO_C2_SKIP" add .mcp.json
git -C "$REPO_C2_SKIP" commit -q -m "add mcp.json"

# Build a PATH without jq (mirrors the no-shellcheck test pattern above)
_JQ_TMPBIN=$(mktemp -d)
trap 'rm -rf "$TMPDIR_WORK" "$_LINT_TMPBIN" "$IF_TMPDIR" "$_JQ_TMPBIN"' EXIT
for _tool in find sort bash dirname echo cat pwd git shellcheck; do
  _tp=$(/usr/bin/which "$_tool" 2>/dev/null || true)
  if [[ -n "$_tp" ]]; then
    ln -sf "$_tp" "$_JQ_TMPBIN/$_tool" 2>/dev/null || true
  fi
done
# jq intentionally NOT linked — this is the scenario under test

actual=0
skip_stderr=""
skip_stderr=$(PATH="$_JQ_TMPBIN" bash "$REPO_C2_SKIP/hooks/lint.sh" 2>&1 >/dev/null) || actual=$?
assert_exit "Check 2 skip: jq absent → no hard-fail (exit 0)" 0 "$actual"
assert_stderr_contains "Check 2 skip: stderr contains skip notice" "jq" "$skip_stderr"

# ── Summary ─────────────────────────────────────────────────────────────────

echo ""
echo "Results: $PASS passed, $FAIL failed"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
