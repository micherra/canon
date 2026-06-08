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
echo "-- Summary --"
echo "  PASS: $PASS"
echo "  FAIL: $FAIL"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
