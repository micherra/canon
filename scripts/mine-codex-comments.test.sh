#!/bin/bash
# Tests for mine-codex-comments.sh pure functions (parse + cluster)
# Run with: bash scripts/mine-codex-comments.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures
#
# Tests exercise sourceable pure functions — no live gh calls.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MINE="$SCRIPT_DIR/mine-codex-comments.sh"

PASS=0
FAIL=0

# ---------------------------------------------------------------------------
# Minimal assert helpers (mirrors hooks/test-helpers.sh style)
# ---------------------------------------------------------------------------
assert_eq() {
  local description="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected: $(printf '%q' "$expected")"
    echo "        actual:   $(printf '%q' "$actual")"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local description="$1"
  local pattern="$2"
  local actual="$3"
  if echo "$actual" | grep -q "$pattern"; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected output to contain: $pattern"
    echo "        actual: $actual"
    FAIL=$((FAIL + 1))
  fi
}

# ---------------------------------------------------------------------------
# Source the main script (guard prevents live-gh main from running)
# ---------------------------------------------------------------------------
# shellcheck source=scripts/mine-codex-comments.sh
source "$MINE"

echo ""
echo "=== mine-codex-comments.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# Fixture comment bodies (from DESIGN.md probe table)
# ---------------------------------------------------------------------------

# PR #337 — P1 shell/eval finding
FIXTURE_P1_SHELL='**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-red)</sub></sub>  Block quoted git passed to shell evaluators**

Some detailed explanation here about eval safety.'

# PR #334 — P2 awk/grep/fence finding
FIXTURE_P2_AWK='**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow)</sub></sub>  Bound the frontmatter grep to the tools field**

Explanation about anchoring awk/grep patterns.'

# PR #332 — P2 scope finding
FIXTURE_P2_SCOPE='**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow)</sub></sub>  Include scope-parity warnings in the verdict rules**

Explanation about scope boundary checks.'

# Unclassified body — no class keywords
FIXTURE_UNCLASSIFIED='**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow)</sub></sub>  Some completely unrelated finding about documentation formatting**

No keywords matching any of the 9 classes.'

echo "-- parse_comment_line: extract severity and title --"

result=$(parse_comment_line "$FIXTURE_P1_SHELL")
assert_eq "P1 shell: severity=P1" "P1" "$(echo "$result" | cut -f1)"
assert_eq "P1 shell: title='Block quoted git passed to shell evaluators'" "Block quoted git passed to shell evaluators" "$(echo "$result" | cut -f2)"

result=$(parse_comment_line "$FIXTURE_P2_AWK")
assert_eq "P2 awk: severity=P2" "P2" "$(echo "$result" | cut -f1)"
assert_eq "P2 awk: title='Bound the frontmatter grep to the tools field'" "Bound the frontmatter grep to the tools field" "$(echo "$result" | cut -f2)"

result=$(parse_comment_line "$FIXTURE_P2_SCOPE")
assert_eq "P2 scope: severity=P2" "P2" "$(echo "$result" | cut -f1)"
assert_eq "P2 scope: title='Include scope-parity warnings in the verdict rules'" "Include scope-parity warnings in the verdict rules" "$(echo "$result" | cut -f2)"

echo ""
echo "-- cluster_title: map title to class number --"

assert_eq "shell/eval title -> class 5" "5" "$(cluster_title 'Block quoted git passed to shell evaluators')"
assert_eq "awk/grep title -> class 6" "6" "$(cluster_title 'Bound the frontmatter grep to the tools field')"
assert_eq "scope title -> class 3" "3" "$(cluster_title 'Include scope-parity warnings in the verdict rules')"

echo ""
echo "-- cluster_title: unclassified body -> empty/0 class --"

unclassified_title
result=$(parse_comment_line "$FIXTURE_UNCLASSIFIED")
title=$(echo "$result" | cut -f2)
class=$(cluster_title "$title")
assert_eq "unclassified title -> class 0 (unclassified)" "0" "$class"

echo ""
echo "-- parse_comment_line: no-match body returns empty --"

no_match_body="This is a plain comment with no badge format."
result=$(parse_comment_line "$no_match_body")
assert_eq "no badge body -> empty result" "" "$result"

echo ""
echo "-- classify_gh_failure: 404 / not-found errors are acceptable skips --"

assert_eq "exit=1, 'HTTP 404' -> skip" "skip" \
  "$(classify_gh_failure 1 'gh: HTTP 404 (https://api.github.com/repos/...)')"

assert_eq "exit=1, 'Not Found' -> skip" "skip" \
  "$(classify_gh_failure 1 'gh: Not Found (HTTP 404)')"

assert_eq "exit=1, 'not found' (lowercase) -> skip" "skip" \
  "$(classify_gh_failure 1 'GraphQL: not found')"

assert_eq "exit=1, 'No such' -> skip" "skip" \
  "$(classify_gh_failure 1 'No such resource')"

echo ""
echo "-- classify_gh_failure: rate-limit / auth / 5xx / network are aborts --"

assert_eq "exit=1, HTTP 429 rate-limit -> abort" "abort" \
  "$(classify_gh_failure 1 'gh: HTTP 429 Too Many Requests (https://api.github.com/repos/...)')"

assert_eq "exit=1, HTTP 401 auth -> abort" "abort" \
  "$(classify_gh_failure 1 'gh: HTTP 401 Unauthorized (https://api.github.com/repos/...)')"

assert_eq "exit=1, HTTP 403 scope -> abort" "abort" \
  "$(classify_gh_failure 1 'gh: HTTP 403 Forbidden (https://api.github.com/repos/...)')"

assert_eq "exit=1, HTTP 500 server error -> abort" "abort" \
  "$(classify_gh_failure 1 'gh: HTTP 500 Internal Server Error')"

assert_eq "exit=1, network error -> abort" "abort" \
  "$(classify_gh_failure 1 'error: failed to connect to github.com')"

assert_eq "exit=1, empty stderr -> abort" "abort" \
  "$(classify_gh_failure 1 '')"

echo ""
echo "-- fetch_pr_comments integration: stub gh binary, verify fail-closed path --"
# Stub gh via PATH prepend so fetch_pr_comments uses our controlled fake.
# This exercises the real integration seam: gh_exit capture via || gh_exit=$?,
# classify_gh_failure dispatch, and the correct return code from fetch_pr_comments.

STUB_DIR=$(mktemp -d)

# Stub: exits 1 with HTTP 429 stderr — must make fetch_pr_comments return 1 (abort)
cat > "$STUB_DIR/gh" <<'STUB'
#!/bin/bash
printf 'gh: HTTP 429 Too Many Requests (https://api.github.com/repos/...)\n' >&2
exit 1
STUB
chmod +x "$STUB_DIR/gh"

result_exit=0
output=$(PATH="$STUB_DIR:$PATH" fetch_pr_comments "99" 2>/dev/null) || result_exit=$?
assert_eq "stub gh exits 1 + HTTP 429 stderr -> fetch_pr_comments returns 1" "1" "$result_exit"
assert_eq "stub gh exits 1 + HTTP 429 stderr -> no stdout emitted" "" "$output"

# Stub: exits 1 with HTTP 404 stderr — must make fetch_pr_comments return 0 (skip)
cat > "$STUB_DIR/gh" <<'STUB'
#!/bin/bash
printf 'gh: HTTP 404 Not Found (https://api.github.com/repos/...)\n' >&2
exit 1
STUB
chmod +x "$STUB_DIR/gh"

result_exit=0
output=$(PATH="$STUB_DIR:$PATH" fetch_pr_comments "42" 2>/dev/null) || result_exit=$?
assert_eq "stub gh exits 1 + HTTP 404 stderr -> fetch_pr_comments returns 0 (skip)" "0" "$result_exit"
assert_eq "stub gh exits 1 + HTTP 404 stderr -> no stdout emitted" "" "$output"

# Stub: exits 0 with comment output — must pass stdout through and return 0
cat > "$STUB_DIR/gh" <<'STUB'
#!/bin/bash
printf 'src/foo.ts\tsome comment body\n'
exit 0
STUB
chmod +x "$STUB_DIR/gh"

result_exit=0
output=$(PATH="$STUB_DIR:$PATH" fetch_pr_comments "7") || result_exit=$?
assert_eq "stub gh exits 0 -> fetch_pr_comments returns 0" "0" "$result_exit"
assert_eq "stub gh exits 0 -> stdout passed through" "src/foo.ts	some comment body" "$output"

rm -rf "$STUB_DIR"

echo ""
echo "-- Summary --"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
