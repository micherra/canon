#!/usr/bin/env bash
# Tests for pre-commit-check.sh
# Run with: bash hooks/pre-commit-check.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/pre-commit-check.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

PASS=0
FAIL=0

# ---------------------------------------------------------------------------
# Helper: create a minimal git repo with a file staged for commit
# ---------------------------------------------------------------------------
setup_commit_repo() {
  local dir="$1"
  local filename="${2:-src/app.ts}"
  local content="${3:-export const foo = 1;}"

  setup_repo "$dir"
  mkdir -p "$dir/$(dirname "$filename")"
  echo "$content" > "$dir/$filename"
  git -C "$dir" add "$filename"
}

# ---------------------------------------------------------------------------
# Helper: invoke the hook in a git repo context
# run_hook_in_repo <repo_dir> <input_json>
# ---------------------------------------------------------------------------
run_hook_in_repo() {
  local dir="$1"
  local input_json="$2"
  local actual_exit=0
  (cd "$dir" && echo "$input_json" | bash "$HOOK" 2>&1) || actual_exit=$?
  echo "$actual_exit"
}

# ---------------------------------------------------------------------------
# Helper: check hook exit code in a repo
# ---------------------------------------------------------------------------
check_hook_exit() {
  local description="$1"
  local expected_exit="$2"
  local dir="$3"
  local input_json="$4"

  local actual_exit=0
  (cd "$dir" && echo "$input_json" | bash "$HOOK" >/dev/null 2>&1) || actual_exit=$?

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

TMPDIR_BASE=$(mktemp -d)
trap 'rm -rf "$TMPDIR_BASE"' EXIT

echo ""
echo "=== pre-commit-check.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# Non-commit commands: silent pass (exit 0)
# ---------------------------------------------------------------------------
echo "-- Non-commit commands (should pass, exit 0) --"

T_NOCOMMIT="$TMPDIR_BASE/t_nocommit"
setup_repo "$T_NOCOMMIT"

check_hook_exit "git status passes"       0 "$T_NOCOMMIT" '{"command":"git status"}'
check_hook_exit "git log passes"          0 "$T_NOCOMMIT" '{"command":"git log --oneline -5"}'
check_hook_exit "git push passes"         0 "$T_NOCOMMIT" '{"command":"git push origin main"}'
check_hook_exit "npm test passes"         0 "$T_NOCOMMIT" '{"command":"npm test"}'
check_hook_exit "empty command passes"    0 "$T_NOCOMMIT" '{"command":""}'
check_hook_exit "no command field passes" 0 "$T_NOCOMMIT" '{"tool":"Bash","other":"value"}'

# ---------------------------------------------------------------------------
# Clean staged files: commit allowed (exit 0)
# ---------------------------------------------------------------------------
echo ""
echo "-- Clean staged files (should pass, exit 0) --"

T_CLEAN="$TMPDIR_BASE/t_clean"
setup_commit_repo "$T_CLEAN" "src/app.ts" "export const greeting = 'hello';"

check_hook_exit "clean TS file allows commit" 0 "$T_CLEAN" '{"command":"git commit -m \"feat: add greeting\""}'

T_CLEAN2="$TMPDIR_BASE/t_clean2"
setup_commit_repo "$T_CLEAN2" "src/config.ts" "export const MAX_RETRIES = 3;"

check_hook_exit "clean config file allows commit" 0 "$T_CLEAN2" '{"command":"git commit -m \"chore: add config\""}'

# ---------------------------------------------------------------------------
# No staged files: commit allowed (exit 0)
# ---------------------------------------------------------------------------
echo ""
echo "-- No staged files (should pass, exit 0) --"

T_NOSTAGED="$TMPDIR_BASE/t_nostaged"
setup_repo "$T_NOSTAGED"

check_hook_exit "no staged files passes" 0 "$T_NOSTAGED" '{"command":"git commit -m \"empty\""}'

# ---------------------------------------------------------------------------
# Secret detection: blocks (exit 2)
# All fixtures use all-zeros or EXAMPLE-pattern placeholders to avoid
# triggering GitHub push protection on this test file itself.
# ---------------------------------------------------------------------------
echo ""
echo "-- Secret detection: blocks (exit 2) --"

# AWS access key pattern — all-zeros suffix (not a real key)
T_AWS="$TMPDIR_BASE/t_aws"
setup_commit_repo "$T_AWS" "src/config.ts" 'const key = "AKIAIOSFODNN7EXAMPLE";'

check_hook_exit "AWS key pattern blocks commit" 2 "$T_AWS" '{"command":"git commit -m \"add config\""}'

# Private key header pattern
T_PRIVKEY="$TMPDIR_BASE/t_privkey"
setup_commit_repo "$T_PRIVKEY" "src/auth.ts" "const pem = '-----BEGIN RSA PRIVATE KEY-----';"

check_hook_exit "Private key header blocks commit" 2 "$T_PRIVKEY" '{"command":"git commit -m \"add auth\""}'

# Hardcoded credential assignment (long value)
T_CRED="$TMPDIR_BASE/t_cred"
setup_commit_repo "$T_CRED" "src/db.ts" 'const password = "thisIsALongPasswordValue123456";'

check_hook_exit "Hardcoded password assignment blocks commit" 2 "$T_CRED" '{"command":"git commit -m \"add db\""}'

# ---------------------------------------------------------------------------
# Excluded file extensions: commit allowed even with secret-like content
# ---------------------------------------------------------------------------
echo ""
echo "-- Excluded extensions skipped (should pass, exit 0) --"

# .env.example — excluded by case statement in hook
T_ENVEX="$TMPDIR_BASE/t_envex"
setup_repo "$T_ENVEX"
echo 'AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE' > "$T_ENVEX/.env.example"
git -C "$T_ENVEX" add ".env.example"

check_hook_exit ".env.example file is skipped" 0 "$T_ENVEX" '{"command":"git commit -m \"add env example\""}'

# .lock file — excluded
T_LOCK="$TMPDIR_BASE/t_lock"
setup_repo "$T_LOCK"
echo 'resolved "AKIAIOSFODNN7EXAMPLE"' > "$T_LOCK/package.lock"
git -C "$T_LOCK" add "package.lock"

check_hook_exit ".lock file is skipped" 0 "$T_LOCK" '{"command":"git commit -m \"add lock\""}'

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
