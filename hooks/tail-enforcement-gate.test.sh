#!/bin/bash
# tail-enforcement-gate.test.sh — Test suite for hooks/tail-enforcement-gate.sh
#
# Fixture-driven: each test builds a throwaway temp "project root" (mktemp -d,
# git init) containing a .canon/workspaces/<branch>/<slug>/ tree with
# journal.json + .lock (and, for the doc-only case, a real worktree/ git repo),
# then feeds the gate a Stop-event JSON payload on stdin.
#
# The gate signals "block" via {"decision":"block",...} JSON on stdout with
# exit 0 (not via a non-zero exit code — see PROBE-FINDINGS P1), so assertions
# inspect stdout content, not just the exit code.
#
# Run: bash hooks/tail-enforcement-gate.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="$SCRIPT_DIR/tail-enforcement-gate.sh"
ALLOWLIST_FILE="$SCRIPT_DIR/lib/accepted-skip-reasons.txt"
ROOT_CLAUDE_MD="$SCRIPT_DIR/../CLAUDE.md"

# shellcheck source=test-helpers.sh
source "$SCRIPT_DIR/test-helpers.sh"

TMP_ROOTS=()

cleanup() {
  local d
  for d in "${TMP_ROOTS[@]+"${TMP_ROOTS[@]}"}"; do
    rm -rf "$d"
  done
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# make_project — creates a throwaway git repo standing in for the project
# root (the Stop event's "cwd" resolves to this repo via rev-parse
# --show-toplevel).
# ---------------------------------------------------------------------------
make_project() {
  local dir
  dir=$(mktemp -d)
  TMP_ROOTS+=("$dir")
  git -C "$dir" init -q
  git -C "$dir" config user.email "t@example.com"
  git -C "$dir" config user.name "T"
  git -C "$dir" config commit.gpgsign false
  echo "placeholder" > "$dir/README.md"
  git -C "$dir" add README.md
  git -C "$dir" commit -q -m init
  printf '%s' "$dir"
}

# ---------------------------------------------------------------------------
# make_workspace <project_dir> <session_id> <journal_json>
# Writes .canon/workspaces/br/slug/journal.json + .lock under the project.
# Prints the workspace dir.
# ---------------------------------------------------------------------------
make_workspace() {
  local project="$1"
  local session_id="$2"
  local journal_json="$3"
  local ws_dir="$project/.canon/workspaces/br/slug"
  mkdir -p "$ws_dir"
  printf '%s' "$journal_json" > "$ws_dir/journal.json"
  printf '{"job_id":"j1","pid":123,"session_id":"%s","started_at":"2026-01-01T00:00:00Z"}' "$session_id" > "$ws_dir/.lock"
  printf '%s' "$ws_dir"
}

# ---------------------------------------------------------------------------
# make_doc_only_worktree <ws_dir>
# Creates a real git worktree at <ws_dir>/worktree whose HEAD diverges from
# "main" by a doc-only (.md) commit — no origin remote, so the gate's
# origin/HEAD lookup fails and falls back to the "main" literal.
# ---------------------------------------------------------------------------
make_doc_only_worktree() {
  local ws_dir="$1"
  local wt="$ws_dir/worktree"
  mkdir -p "$wt"
  git -C "$wt" init -q -b main
  git -C "$wt" config user.email "t@example.com"
  git -C "$wt" config user.name "T"
  git -C "$wt" config commit.gpgsign false
  echo "code" > "$wt/app.js"
  git -C "$wt" add app.js
  git -C "$wt" commit -q -m init
  git -C "$wt" checkout -q -b canon/feature
  echo "docs" > "$wt/NOTES.md"
  git -C "$wt" add NOTES.md
  git -C "$wt" commit -q -m docs
}

# ---------------------------------------------------------------------------
# stop_input <session_id> <cwd> <stop_hook_active>
# ---------------------------------------------------------------------------
stop_input() {
  local session_id="$1"
  local cwd="$2"
  local active="$3"
  jq -n --arg sid "$session_id" --arg cwd "$cwd" --argjson active "$active" \
    '{session_id: $sid, cwd: $cwd, hook_event_name: "Stop", permission_mode: "default", stop_hook_active: $active}'
}

# ---------------------------------------------------------------------------
# assert_block / assert_pass
# ---------------------------------------------------------------------------
assert_block() {
  local description="$1"
  local input_json="$2"
  local output exit_code=0
  output=$(printf '%s' "$input_json" | bash "$HOOK" 2>&1) || exit_code=$?

  if [[ "$exit_code" -eq 0 ]] && printf '%s' "$output" | grep -q '"decision"[[:space:]]*:[[:space:]]*"block"'; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=0 with decision:block, got exit=$exit_code output=$output"
    FAIL=$((FAIL + 1))
  fi
}

assert_pass() {
  local description="$1"
  local input_json="$2"
  local output exit_code=0
  output=$(printf '%s' "$input_json" | bash "$HOOK" 2>&1) || exit_code=$?

  if [[ "$exit_code" -eq 0 ]] && ! printf '%s' "$output" | grep -q '"decision"'; then
    echo "  PASS: $description"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $description"
    echo "        expected exit=0 with no decision block, got exit=$exit_code output=$output"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== tail-enforcement-gate.test.sh ==="

# ---------------------------------------------------------------------------
# Test 1: Happy pass — matched lock, ship=completed, context-sync=completed,
# learn=completed → no block.
# ---------------------------------------------------------------------------
P1=$(make_project)
J1='{"steps":[{"step_id":"ship","status":"completed"},{"step_id":"context-sync","status":"completed"},{"step_id":"learn","status":"completed"}]}'
make_workspace "$P1" "SESSION-1" "$J1" > /dev/null
assert_pass "1. happy pass — all tail steps completed" "$(stop_input "SESSION-1" "$P1" false)"

# ---------------------------------------------------------------------------
# Test 2: Block — learn missing entirely.
# ---------------------------------------------------------------------------
P2=$(make_project)
J2='{"steps":[{"step_id":"ship","status":"completed"},{"step_id":"context-sync","status":"completed"}]}'
make_workspace "$P2" "SESSION-2" "$J2" > /dev/null
assert_block "2. block — learn step missing" "$(stop_input "SESSION-2" "$P2" false)"

# ---------------------------------------------------------------------------
# Test 3: Block — context-sync skipped with empty skip_reason.
# ---------------------------------------------------------------------------
P3=$(make_project)
J3='{"steps":[{"step_id":"ship","status":"completed"},{"step_id":"context-sync","status":"skipped","skip_reason":""},{"step_id":"learn","status":"completed"}]}'
make_workspace "$P3" "SESSION-3" "$J3" > /dev/null
assert_block "3. block — context-sync skipped with empty reason" "$(stop_input "SESSION-3" "$P3" false)"

# ---------------------------------------------------------------------------
# Test 4: Block — learn skipped with a non-accepted reason.
# ---------------------------------------------------------------------------
P4=$(make_project)
J4='{"steps":[{"step_id":"ship","status":"completed"},{"step_id":"context-sync","status":"completed"},{"step_id":"learn","status":"skipped","skip_reason":"because I felt like it"}]}'
make_workspace "$P4" "SESSION-4" "$J4" > /dev/null
assert_block "4. block — learn skipped with non-accepted reason" "$(stop_input "SESSION-4" "$P4" false)"

# ---------------------------------------------------------------------------
# Test 5: Pass — learn skipped with an accepted reason.
# ---------------------------------------------------------------------------
P5=$(make_project)
J5='{"steps":[{"step_id":"ship","status":"completed"},{"step_id":"context-sync","status":"completed"},{"step_id":"learn","status":"skipped","skip_reason":"no new patterns observed"}]}'
make_workspace "$P5" "SESSION-5" "$J5" > /dev/null
assert_pass "5. pass — learn skipped with accepted reason" "$(stop_input "SESSION-5" "$P5" false)"

# ---------------------------------------------------------------------------
# Test 6: No-op — no session-matched lock (chat / other session).
# ---------------------------------------------------------------------------
P6=$(make_project)
J6='{"steps":[{"step_id":"ship","status":"completed"},{"step_id":"context-sync","status":"completed"}]}'
make_workspace "$P6" "SESSION-6-OWNER" "$J6" > /dev/null
assert_pass "6. no-op — no session-matched lock" "$(stop_input "SESSION-6-OTHER" "$P6" false)"

# ---------------------------------------------------------------------------
# Test 7: No-op — ship not completed (mid-build; review done, ship started)
# even with learn missing.
# ---------------------------------------------------------------------------
P7=$(make_project)
J7='{"steps":[{"step_id":"review","status":"completed"},{"step_id":"ship","status":"started"},{"step_id":"context-sync","status":"completed"}]}'
make_workspace "$P7" "SESSION-7" "$J7" > /dev/null
assert_pass "7. no-op — ship not completed (mid-build)" "$(stop_input "SESSION-7" "$P7" false)"

# ---------------------------------------------------------------------------
# Test 8: No-op — doc-only diff, shipped build, context-sync skipped-empty.
# ---------------------------------------------------------------------------
P8=$(make_project)
J8='{"steps":[{"step_id":"ship","status":"completed"},{"step_id":"context-sync","status":"skipped","skip_reason":""},{"step_id":"learn","status":"completed"}]}'
WS8=$(make_workspace "$P8" "SESSION-8" "$J8")
make_doc_only_worktree "$WS8"
assert_pass "8. no-op — doc-only diff wins before tail check" "$(stop_input "SESSION-8" "$P8" false)"

# ---------------------------------------------------------------------------
# Test 9: Loop-guard — stop_hook_active=true with a real violation present.
# ---------------------------------------------------------------------------
P9=$(make_project)
J9='{"steps":[{"step_id":"ship","status":"completed"},{"step_id":"context-sync","status":"completed"}]}'
make_workspace "$P9" "SESSION-9" "$J9" > /dev/null
assert_pass "9. loop-guard — stop_hook_active true never re-blocks" "$(stop_input "SESSION-9" "$P9" true)"

# ---------------------------------------------------------------------------
# Test 10: Fail-closed — unparseable journal on a session-matched workspace.
# ---------------------------------------------------------------------------
P10=$(make_project)
WS10="$P10/.canon/workspaces/br/slug"
mkdir -p "$WS10"
printf '{not valid json' > "$WS10/journal.json"
printf '{"job_id":"j1","pid":123,"session_id":"SESSION-10","started_at":"2026-01-01T00:00:00Z"}' > "$WS10/.lock"
assert_block "10. fail-closed — unparseable journal blocks" "$(stop_input "SESSION-10" "$P10" false)"

# ---------------------------------------------------------------------------
# Test 11: Parity assertion — every accepted-skip-reasons.txt line appears
# verbatim in root CLAUDE.md.
# ---------------------------------------------------------------------------
PARITY_OK=1
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  if ! grep -qF -- "$line" "$ROOT_CLAUDE_MD"; then
    PARITY_OK=0
    echo "        missing from CLAUDE.md: $line"
  fi
done < "$ALLOWLIST_FILE"

if [[ "$PARITY_OK" -eq 1 ]]; then
  echo "  PASS: 11. parity — every accepted skip_reason appears in root CLAUDE.md"
  PASS=$((PASS + 1))
else
  echo "  FAIL: 11. parity — accepted-skip-reasons.txt diverges from CLAUDE.md"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
