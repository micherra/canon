#!/bin/bash
# Tests for pre-commit-check.sh
# Run with: bash hooks/pre-commit-check.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures
#
# All tests use isolated temp git repos. No hard-coded paths; safe for CI.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/pre-commit-check.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

MASTER_TMP=$(mktemp -d)
trap 'rm -rf "$MASTER_TMP"' EXIT

# setup_repo — minimal git repo with one initial commit
setup_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" config user.email "test@test"
  git -C "$dir" config user.name "Test"
  git -C "$dir" config commit.gpgsign false
  echo "v1" > "$dir/file.txt"
  git -C "$dir" add "$dir/file.txt"
  git -C "$dir" commit -q -m "init"
}

# stage_file — write content to a file in the repo and stage it
# Usage: stage_file <repo_dir> <filename> <content>
stage_file() {
  local dir="$1"
  local filename="$2"
  local content="$3"
  printf '%s\n' "$content" > "$dir/$filename"
  git -C "$dir" add "$dir/$filename"
}

# run_test — validate exit code only, hook invoked from current directory
# Usage: run_test "description" expected_exit stdin_json
run_test() {
  local description="$1"
  local expected_exit="$2"
  local stdin_json="$3"

  local actual_exit=0
  echo "$stdin_json" | bash "$HOOK" >/dev/null 2>&1 || actual_exit=$?

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

# run_test_in_dir — validate exit code only, hook invoked from a specific dir
run_test_in_dir() {
  local description="$1"
  local expected_exit="$2"
  local repo_dir="$3"
  local stdin_json="$4"

  local tmpout
  tmpout=$(mktemp)

  local actual_exit=0
  (cd "$repo_dir" && echo "$stdin_json" | bash "$HOOK" > "$tmpout" 2>&1) || actual_exit=$?

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    echo "        output: $(cat "$tmpout")"
    FAIL=$((FAIL + 1))
  fi
  rm -f "$tmpout"
}

# run_test_in_dir_with_output — validate exit code AND stdout/stderr pattern
run_test_in_dir_with_output() {
  local description="$1"
  local expected_exit="$2"
  local expected_pattern="$3"
  local repo_dir="$4"
  local stdin_json="$5"

  local tmpout
  tmpout=$(mktemp)

  local actual_exit=0
  (cd "$repo_dir" && echo "$stdin_json" | bash "$HOOK" > "$tmpout" 2>&1) || actual_exit=$?
  local output
  output=$(cat "$tmpout")
  rm -f "$tmpout"

  local ok=true
  [[ "$actual_exit" -eq "$expected_exit" ]] || ok=false
  if [[ -n "$expected_pattern" ]] && ! echo "$output" | grep -q "$expected_pattern"; then
    ok=false
  fi

  if [[ "$ok" == "true" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    echo "        expected pattern: '$expected_pattern'"
    echo "        actual output: '$output'"
    FAIL=$((FAIL + 1))
  fi
}

# run_test_in_dir_no_pattern — validate exit code AND output does NOT match pattern
run_test_in_dir_no_pattern() {
  local description="$1"
  local expected_exit="$2"
  local forbidden_pattern="$3"
  local repo_dir="$4"
  local stdin_json="$5"

  local tmpout
  tmpout=$(mktemp)

  local actual_exit=0
  (cd "$repo_dir" && echo "$stdin_json" | bash "$HOOK" > "$tmpout" 2>&1) || actual_exit=$?
  local output
  output=$(cat "$tmpout")
  rm -f "$tmpout"

  local ok=true
  [[ "$actual_exit" -eq "$expected_exit" ]] || ok=false
  if [[ -n "$forbidden_pattern" ]] && echo "$output" | grep -q "$forbidden_pattern"; then
    ok=false
  fi

  if [[ "$ok" == "true" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    echo "        forbidden pattern found: '$forbidden_pattern'"
    echo "        actual output: '$output'"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "=== pre-commit-check.sh tests ==="
echo ""

# ─────────────────────────────────────────────────────────────────────────────
# Bypass gate: non-commit commands exit 0 immediately (no git context needed)
# ─────────────────────────────────────────────────────────────────────────────
echo "-- Bypass gate: non-commit commands pass through --"

run_test "git push does not trigger pre-commit check" 0 \
  '{"command":"git push origin main"}'

run_test "git status does not trigger pre-commit check" 0 \
  '{"command":"git status"}'

run_test "git fetch does not trigger pre-commit check" 0 \
  '{"command":"git fetch --all"}'

run_test "npm test does not trigger pre-commit check" 0 \
  '{"command":"npm test"}'

run_test "empty command passes through" 0 \
  '{"command":""}'

run_test "no command field passes through" 0 \
  '{"tool":"Bash"}'

# ─────────────────────────────────────────────────────────────────────────────
# Silent pass: git commit with no staged files
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Silent pass: git commit with no staged files --"

REPO_NO_STAGE="$MASTER_TMP/no-stage"
setup_repo "$REPO_NO_STAGE"

run_test_in_dir "git commit with no staged files — exits 0" 0 \
  "$REPO_NO_STAGE" \
  '{"command":"git commit -m \"test\""}'

run_test_in_dir_no_pattern "git commit with no staged files — no CANON output" 0 \
  "CANON" \
  "$REPO_NO_STAGE" \
  '{"command":"git commit -m \"test\""}'

# ─────────────────────────────────────────────────────────────────────────────
# Silent pass: staged file with no secrets — exits 0, no output
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Silent pass: staged file with no secrets --"

REPO_CLEAN="$MASTER_TMP/clean-stage"
setup_repo "$REPO_CLEAN"
stage_file "$REPO_CLEAN" "config.ts" 'export const APP_NAME = "canon";'

run_test_in_dir "clean staged file — exits 0" 0 \
  "$REPO_CLEAN" \
  '{"command":"git commit -m \"add config\""}'

run_test_in_dir_no_pattern "clean staged file — no CANON PRE-COMMIT BLOCK emitted" 0 \
  "CANON PRE-COMMIT BLOCK" \
  "$REPO_CLEAN" \
  '{"command":"git commit -m \"add config\""}'

# ─────────────────────────────────────────────────────────────────────────────
# Blocking: AWS access key pattern (AKIA...)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Blocking: AWS access key pattern --"

REPO_AWS="$MASTER_TMP/aws-key"
setup_repo "$REPO_AWS"
stage_file "$REPO_AWS" "deploy.sh" 'AWS_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE123'

run_test_in_dir "staged file with AWS key — exits 2 (blocked)" 2 \
  "$REPO_AWS" \
  '{"command":"git commit -m \"add deploy\""}'

run_test_in_dir_with_output "staged file with AWS key — emits CANON PRE-COMMIT BLOCK" 2 \
  "CANON PRE-COMMIT BLOCK" \
  "$REPO_AWS" \
  '{"command":"git commit -m \"add deploy\""}'

run_test_in_dir_with_output "AWS key block mentions aws access key" 2 \
  "AWS access key" \
  "$REPO_AWS" \
  '{"command":"git commit -m \"add deploy\""}'

# ─────────────────────────────────────────────────────────────────────────────
# Blocking: Private key (BEGIN RSA PRIVATE KEY)
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Blocking: private key pattern --"

REPO_PRIVKEY="$MASTER_TMP/priv-key"
setup_repo "$REPO_PRIVKEY"
stage_file "$REPO_PRIVKEY" "server.key" '-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA...
-----END RSA PRIVATE KEY-----'

run_test_in_dir "staged file with private key — exits 2 (blocked)" 2 \
  "$REPO_PRIVKEY" \
  '{"command":"git commit -m \"add key\""}'

run_test_in_dir_with_output "private key block mentions Private key" 2 \
  "Private key" \
  "$REPO_PRIVKEY" \
  '{"command":"git commit -m \"add key\""}'

# ─────────────────────────────────────────────────────────────────────────────
# Blocking: Hardcoded credential in variable assignment
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Blocking: hardcoded credential in variable assignment --"

REPO_CRED="$MASTER_TMP/credential"
setup_repo "$REPO_CRED"
stage_file "$REPO_CRED" "settings.py" 'SECRET_KEY = "supersecretvaluethatismorethan16chars"'

run_test_in_dir "staged file with hardcoded secret — exits 2 (blocked)" 2 \
  "$REPO_CRED" \
  '{"command":"git commit -m \"add settings\""}'

run_test_in_dir_with_output "hardcoded secret block mentions credential" 2 \
  "credential" \
  "$REPO_CRED" \
  '{"command":"git commit -m \"add settings\""}'

# ─────────────────────────────────────────────────────────────────────────────
# Blocking: Stripe live secret key
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Blocking: Stripe live secret key --"

REPO_STRIPE="$MASTER_TMP/stripe"
setup_repo "$REPO_STRIPE"
stage_file "$REPO_STRIPE" "payment.ts" 'const stripeKey = "sk_live_00000000000000000000";'

run_test_in_dir "staged file with Stripe key — exits 2 (blocked)" 2 \
  "$REPO_STRIPE" \
  '{"command":"git commit -m \"add payment\""}'

run_test_in_dir_with_output "Stripe key block mentions Stripe" 2 \
  "Stripe" \
  "$REPO_STRIPE" \
  '{"command":"git commit -m \"add payment\""}'

# ─────────────────────────────────────────────────────────────────────────────
# Blocking: Connection string with embedded password
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Blocking: connection string with embedded password --"

REPO_CONN="$MASTER_TMP/connstr"
setup_repo "$REPO_CONN"
stage_file "$REPO_CONN" "db.ts" 'const DB_URL = "postgres://admin:hunter2@localhost:5432/mydb";'

run_test_in_dir "staged file with connection string — exits 2 (blocked)" 2 \
  "$REPO_CONN" \
  '{"command":"git commit -m \"add db config\""}'

run_test_in_dir_with_output "connection string block mentions Connection string" 2 \
  "Connection string" \
  "$REPO_CONN" \
  '{"command":"git commit -m \"add db config\""}'

# ─────────────────────────────────────────────────────────────────────────────
# Silent pass: test files are skipped even if they contain secret-like content
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Silent pass: test and spec files are excluded from scanning --"

REPO_TESTFILE="$MASTER_TMP/test-file"
setup_repo "$REPO_TESTFILE"
stage_file "$REPO_TESTFILE" "auth.test.ts" 'const AWS_KEY = "AKIAIOSFODNN7EXAMPLE123"; // fixture'
stage_file "$REPO_TESTFILE" "payment.spec.js" 'const sk = "sk_live_00000000000000000000"; // fixture'

run_test_in_dir "test file with secret-like content — exits 0 (skipped)" 0 \
  "$REPO_TESTFILE" \
  '{"command":"git commit -m \"add tests\""}'

run_test_in_dir_no_pattern "test file — no CANON PRE-COMMIT BLOCK" 0 \
  "CANON PRE-COMMIT BLOCK" \
  "$REPO_TESTFILE" \
  '{"command":"git commit -m \"add tests\""}'

# ─────────────────────────────────────────────────────────────────────────────
# Silent pass: .env.example is excluded from scanning
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Silent pass: .env.example is excluded from scanning --"

REPO_ENVEX="$MASTER_TMP/env-example"
setup_repo "$REPO_ENVEX"
stage_file "$REPO_ENVEX" ".env.example" 'SECRET_KEY = "your_secret_key_here_at_least_16ch"'

run_test_in_dir ".env.example with secret-like content — exits 0 (skipped)" 0 \
  "$REPO_ENVEX" \
  '{"command":"git commit -m \"add env example\""}'

run_test_in_dir_no_pattern ".env.example — no CANON PRE-COMMIT BLOCK" 0 \
  "CANON PRE-COMMIT BLOCK" \
  "$REPO_ENVEX" \
  '{"command":"git commit -m \"add env example\""}'

# ─────────────────────────────────────────────────────────────────────────────
# Variants: git commit with flags still triggers check
# ─────────────────────────────────────────────────────────────────────────────
echo ""
echo "-- Commit command variants still trigger the guard --"

REPO_FLAGS="$MASTER_TMP/commit-flags"
setup_repo "$REPO_FLAGS"
stage_file "$REPO_FLAGS" "config.env" 'API_KEY = "AKIAIOSFODNN7FLAGSTEST1234"'

run_test_in_dir "git commit --allow-empty with secret — exits 2" 2 \
  "$REPO_FLAGS" \
  '{"command":"git commit --allow-empty -m \"test\""}'

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
