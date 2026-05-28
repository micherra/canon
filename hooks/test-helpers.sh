#!/usr/bin/env bash
# test-helpers.sh — Shared test helper functions for Canon hook test suites.
#
# Source this file from hook test scripts to get reusable utilities:
#
#   run_test <description> <expected_exit> <command_json> [cwd]
#     Runs a hook with JSON on stdin. Checks the exit code.
#
#   run_test_in_dir <description> <expected_exit> <hook> <dir> [input_json]
#     Runs a hook with the working directory set to <dir>.
#
#   run_test_in_dir_with_output <description> <expected_output_pattern> <hook> <dir> [input_json]
#     Runs a hook and checks that stdout/stderr contains expected_output_pattern.
#
#   run_test_in_dir_no_pattern <description> <no_pattern> <hook> <dir> [input_json]
#     Runs a hook and checks that stdout/stderr does NOT contain no_pattern.
#
#   setup_repo <dir>
#     Creates a minimal git repo at <dir> suitable for hook testing.
#
# Usage:
#   source "$(dirname "${BASH_SOURCE[0]}")/test-helpers.sh"
#
# Convention for secret fixtures:
#   When testing secret-detection hooks, use all-zeros suffixes or
#   EXAMPLE-pattern placeholders for key fixtures — not plausible real-looking
#   values. GitHub push protection scans test files regardless of hook
#   exclusion rules.

# ---------------------------------------------------------------------------
# Pass/fail counters — caller initializes these before sourcing if desired.
# test-helpers.sh will set them to 0 if not already declared.
# ---------------------------------------------------------------------------
: "${PASS:=0}"
: "${FAIL:=0}"

export PASS FAIL

# ---------------------------------------------------------------------------
# run_test <description> <expected_exit> <command_json> [cwd]
# ---------------------------------------------------------------------------
# Runs the HOOK variable with the given JSON on stdin.
# Uses CANON_GUARD_CWD env var for hooks that need a path override.
run_test() {
  local description="$1"
  local expected_exit="$2"
  local command_json="$3"
  local custom_pwd="${4:-}"

  local cwd="${custom_pwd:-/home/user/project}"
  local actual_exit=0
  echo "$command_json" | CANON_GUARD_CWD="$cwd" bash "$HOOK" >/dev/null 2>&1 || actual_exit=$?

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------------------
# run_test_in_dir <description> <expected_exit> <hook> <dir> [input_json]
# ---------------------------------------------------------------------------
# Runs a hook script with the working directory set to <dir>.
run_test_in_dir() {
  local description="$1"
  local expected_exit="$2"
  local hook="$3"
  local dir="$4"
  local input_json="${5:-{}}"

  local actual_exit=0
  (cd "$dir" && echo "$input_json" | bash "$hook" >/dev/null 2>&1) || actual_exit=$?

  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------------------
# run_test_in_dir_with_output <description> <pattern> <hook> <dir> [input_json]
# ---------------------------------------------------------------------------
# Runs a hook and checks (a) exit code is 0 and (b) stdout+stderr contains the given pattern.
run_test_in_dir_with_output() {
  local description="$1"
  local expected_pattern="$2"
  local hook="$3"
  local dir="$4"
  local input_json="${5:-{}}"

  local output
  local actual_exit=0
  output=$(cd "$dir" && echo "$input_json" | bash "$hook" 2>&1) || actual_exit=$?

  local exit_ok=true
  local output_ok=true

  if [[ "$actual_exit" -ne 0 ]]; then
    exit_ok=false
  fi

  if ! echo "$output" | grep -q "$expected_pattern"; then
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

# ---------------------------------------------------------------------------
# run_test_in_dir_no_pattern <description> <no_pattern> <hook> <dir> [input_json]
# ---------------------------------------------------------------------------
# Runs a hook and checks (a) exit code is 0 and (b) stdout+stderr does NOT contain the given pattern.
run_test_in_dir_no_pattern() {
  local description="$1"
  local no_pattern="$2"
  local hook="$3"
  local dir="$4"
  local input_json="${5:-{}}"

  local output
  local actual_exit=0
  output=$(cd "$dir" && echo "$input_json" | bash "$hook" 2>&1) || actual_exit=$?

  local exit_ok=true
  local output_ok=true

  if [[ "$actual_exit" -ne 0 ]]; then
    exit_ok=false
  fi

  if echo "$output" | grep -q "$no_pattern"; then
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
      echo "        expected output NOT to contain: $no_pattern"
      echo "        actual output: $output"
    fi
    FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------------------
# run_test_with_output <description> <expected_output_pattern> [input_json] [env_overrides]
# ---------------------------------------------------------------------------
# Runs HOOK via `bash "$HOOK"` with optional env overrides.
# Checks that stdout+stderr contains the expected pattern.
# Exit code is NOT checked — this helper focuses on output content.
# env_overrides is a string of KEY=VALUE pairs, e.g. "FOO=bar BAZ=qux".
run_test_with_output() {
  local description="$1"
  local expected_pattern="$2"
  local input_json="${3:-{}}"
  local env_overrides="${4:-}"

  local output
  local actual_exit=0
  # shellcheck disable=SC2086
  output=$(echo "$input_json" | env ${env_overrides} bash "$HOOK" 2>&1) || actual_exit=$?

  if echo "$output" | grep -q "$expected_pattern"; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected output containing: $expected_pattern"
    echo "        actual output: $output"
    FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------------------
# setup_repo <dir>
# ---------------------------------------------------------------------------
# Creates a minimal git repo at <dir> with a tracked file and .gitignore.
# Suitable for hooks that query git branch or staged files.
setup_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" config user.email "test@example.com"
  git -C "$dir" config user.name "Test User"
  git -C "$dir" config commit.gpgsign false
  mkdir -p "$dir/src"
  echo "// tracked source file" > "$dir/src/app.ts"
  printf ".canon/\n" > "$dir/.gitignore"
  git -C "$dir" add .gitignore src/app.ts
  git -C "$dir" commit -q -m "init"
}
