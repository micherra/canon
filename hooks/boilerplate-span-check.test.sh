#!/bin/bash
# Tests for boilerplate-span-check.sh (sug_BLOAT1)
# Run with: bash hooks/boilerplate-span-check.test.sh
# Exit 0 = all tests pass, Exit 1 = one or more failures

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GATE="$SCRIPT_DIR/boilerplate-span-check.sh"

# shellcheck source=hooks/test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

echo ""
echo "=== boilerplate-span-check.sh tests ==="
echo ""

# ---------------------------------------------------------------------------
# Fixture helpers — build an ephemeral principles/ tree under a mktemp dir.
# Never mutate the real corpus.
# ---------------------------------------------------------------------------

# write_principle <root> <subdir> <name> <anti_rationalization_body>
# Creates <root>/principles/<subdir>/<name>.md with a frontmatter, a body
# section, an "## Anti-Rationalization" section carrying <body>, and a trailing
# "## Verification" heading so the span has a real terminating boundary.
write_principle() {
  local root="$1" subdir="$2" name="$3" body="$4"
  mkdir -p "$root/principles/$subdir"
  {
    printf -- '---\nid: %s\ntitle: %s\nseverity: rule\n---\n\n' "$name" "$name"
    printf -- '# %s\n\nSome intro prose.\n\n' "$name"
    printf -- '## Anti-Rationalization\n\n%s\n\n' "$body"
    printf -- '## Verification\n\n- [ ] done\n'
  } > "$root/principles/$subdir/$name.md"
}

# run_gate <expected_exit> <description> [extra args...]
run_gate() {
  local expected_exit="$1" description="$2"
  shift 2
  local actual_exit=0
  bash "$GATE" "$@" >/dev/null 2>&1 || actual_exit=$?
  if [[ "$actual_exit" -eq "$expected_exit" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit, got exit=$actual_exit"
    FAIL=$((FAIL + 1))
  fi
}

# run_gate_out <expected_exit> <pattern> <description> [extra args...]
run_gate_out() {
  local expected_exit="$1" pattern="$2" description="$3"
  shift 3
  local actual_exit=0 output
  output=$(bash "$GATE" "$@" 2>&1) || actual_exit=$?
  local ok=true
  [[ "$actual_exit" -eq "$expected_exit" ]] || ok=false
  echo "$output" | grep -qF "$pattern" || ok=false
  if [[ "$ok" == "true" ]]; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=$expected_exit + pattern '$pattern', got exit=$actual_exit"
    echo "        output: $output"
    FAIL=$((FAIL + 1))
  fi
}

UNIQ_A="Excuse one is wrong because reason A. Correct action is do A properly."
UNIQ_B="Excuse two is wrong because reason B. Correct action is do B properly."
DUP="| Excuse | Why | Fix |\n| shared | identical | scaffold |"

echo "-- (a) clean fixture tree (all spans distinct) -> exit 0 --"
{
  FIX=$(mktemp -d)
  write_principle "$FIX" rules alpha "$UNIQ_A"
  write_principle "$FIX" strong-opinions beta "$UNIQ_B"
  write_principle "$FIX" conventions gamma "Excuse three differs. Action three differs too."
  run_gate 0 "clean tree -> exit 0" "$FIX"
  rm -rf "$FIX"
}

echo "-- (b) seeded 2-file identical span -> exit 2 --"
{
  FIX=$(mktemp -d)
  write_principle "$FIX" rules alpha "$DUP"
  write_principle "$FIX" strong-opinions beta "$DUP"
  write_principle "$FIX" conventions gamma "$UNIQ_A"
  run_gate 2 "seeded duplicate span -> exit 2" "$FIX"
  run_gate_out 2 "alpha.md" "duplicate report names alpha.md" "$FIX"
  run_gate_out 2 "beta.md" "duplicate report names beta.md" "$FIX"
  rm -rf "$FIX"
}

echo "-- (c) canon:allow-shared-span opt-out suppresses -> exit 0 --"
{
  FIX=$(mktemp -d)
  # Two identical spans, but one file carries the inline opt-out marker so the
  # pair is no longer a >=2 non-opted-out collision.
  write_principle "$FIX" rules alpha "$DUP"
  write_principle "$FIX" strong-opinions beta "<!-- canon:allow-shared-span: intentionally shared -->
$DUP"
  run_gate 0 "opt-out marker suppresses the collision -> exit 0" "$FIX"
  rm -rf "$FIX"
}

echo "-- (d) non-directory worktree_path -> fail-closed exit 2 --"
{
  run_gate_out 2 "not a directory" "non-directory arg -> fail-closed exit 2" "/nonexistent/worktree/path"
}

echo "-- (e) files with no Anti-Rationalization heading are ignored -> exit 0 --"
{
  FIX=$(mktemp -d)
  mkdir -p "$FIX/principles/rules"
  printf -- '---\nid: noheading\n---\n\n# No Anti-Rationalization here\n\nJust prose.\n' \
    > "$FIX/principles/rules/noheading.md"
  printf -- '---\nid: alsonone\n---\n\n# Also none\n\nMore prose.\n' \
    > "$FIX/principles/rules/alsonone.md"
  run_gate 0 "no Anti-Rationalization heading -> exit 0 (nothing to compare)" "$FIX"
  rm -rf "$FIX"
}

echo "-- (f) overridable heading args (start/end) still detect duplicates -> exit 2 --"
{
  FIX=$(mktemp -d)
  mkdir -p "$FIX/principles/rules"
  printf -- '---\nid: a\n---\n\n## Common Pitfalls\nIDENTICAL BODY LINE\n## Verification\nx\n' \
    > "$FIX/principles/rules/a.md"
  printf -- '---\nid: b\n---\n\n## Common Pitfalls\nIDENTICAL BODY LINE\n## Verification\ny\n' \
    > "$FIX/principles/rules/b.md"
  run_gate 2 "overridden start heading detects duplicate -> exit 2" "$FIX" "## Common Pitfalls" "## "
  rm -rf "$FIX"
}

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
