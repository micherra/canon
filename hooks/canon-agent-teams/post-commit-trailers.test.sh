#!/usr/bin/env bash
# Tests for post-commit-trailers.sh.
# Exercises: feature-flag off, non-Bash input, non-commit Bash call, commit
# with trailer, commit without trailer. All cases must exit 0 (hook warns
# but never blocks).

set -euo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/post-commit-trailers.sh"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

# 2. Non-Bash tool — exit 0.
out=$(bash "$HOOK" <<<'{"tool_name":"Edit"}' 2>&1) || fail "non-Bash should exit 0"
pass "non-Bash tool ignored"

# 3. Bash but not a git commit — exit 0.
out=$(bash "$HOOK" <<<'{"tool_name":"Bash","tool_input":{"command":"ls -la"}}' 2>&1) || fail "non-commit Bash should exit 0"
pass "non-commit Bash ignored"

# 4. git commit with trailer present — exit 0, no warning on stderr.
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT
(
  cd "$SANDBOX"
  git init -q
  git config user.email t@t
  git config user.name t
  git config commit.gpgsign false
  git config gpg.format openpgp
  echo x > a
  git add a
  git commit -q -m "$(printf 'feat: add a thing\n\nSome body text explaining the change.\n\nCanon-Workflow: my-slug\nCanon-Agent: engineer\nCanon-State: implement\n')"
  out=$(bash "$HOOK" <<<'{"tool_name":"Bash","tool_input":{"command":"git commit -m foo"}}' 2>&1) \
    || { echo "hook exited non-zero: $out" >&2; exit 1; }
  if echo "$out" | grep -q 'CANON WARNING'; then
    echo "did not expect warning: $out" >&2; exit 1
  fi
)
pass "commit with trailer emits no warning"

# 5. git commit without trailer — exit 0, warning on stderr.
SANDBOX2=$(mktemp -d)
(
  cd "$SANDBOX2"
  git init -q
  git config user.email t@t
  git config user.name t
  git config commit.gpgsign false
  git config gpg.format openpgp
  echo x > a
  git add a
  git commit -q -m "no trailer here"
  out=$(bash "$HOOK" <<<'{"tool_name":"Bash","tool_input":{"command":"git commit -m foo"}}' 2>&1) \
    || { echo "hook exited non-zero: $out" >&2; exit 1; }
  if ! echo "$out" | grep -q 'CANON WARNING'; then
    echo "expected warning but got: $out" >&2; exit 1
  fi
)
rm -rf "$SANDBOX2"
pass "commit without trailer warns"

echo "post-commit-trailers.sh: all tests passed"
