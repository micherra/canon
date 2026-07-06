#!/bin/bash
# tail-enforcement-gate.test.sh — Test suite for hooks/tail-enforcement-gate.sh
#
# Fixture-driven: each test builds a throwaway temp "project root" (mktemp -d,
# git init) containing a .canon/workspaces/<branch>/<slug>/ tree with a
# journal.json whose top-level `session_id` field matches the Stop event's
# session_id (and, for the doc-only case, a real worktree/ git repo), then
# feeds the gate a Stop-event JSON payload on stdin.
#
# NO fixture writes a `.lock` file (tail-gate-codex-fix P1): finalize_workspace
# releases `.lock` unconditionally before the gate's ship==completed trigger
# can ever fire, so `.lock` is not a viable detection signal for a shipped
# build — see plans/tail-gate-codex-fix/DESIGN.md "Why journal.json is the
# right carrier". Detection now reads session_id directly off journal.json,
# which finalize_workspace copies to the archive but never deletes.
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
# Writes .canon/workspaces/br/slug/journal.json under the project, merging
# top-level session_id into the given journal JSON (no .lock file — detection
# is journal.session_id-based, see file header). Prints the workspace dir.
# ---------------------------------------------------------------------------
make_workspace() {
  local project="$1"
  local session_id="$2"
  local journal_json="$3"
  local ws_dir="$project/.canon/workspaces/br/slug"
  mkdir -p "$ws_dir"
  printf '%s' "$journal_json" | jq --arg sid "$session_id" '. + {session_id: $sid}' > "$ws_dir/journal.json"
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
# Test 1: Happy pass — matched journal, ship=completed, context-sync=completed,
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
# Test 6: No-op — no session-matched journal (chat / other session).
# ---------------------------------------------------------------------------
P6=$(make_project)
J6='{"steps":[{"step_id":"ship","status":"completed"},{"step_id":"context-sync","status":"completed"}]}'
make_workspace "$P6" "SESSION-6-OWNER" "$J6" > /dev/null
assert_pass "6. no-op — no session-matched journal" "$(stop_input "SESSION-6-OTHER" "$P6" false)"

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
# Test 10: No-op — a session's OWN journal is unparseable. Detection now
# extracts session_id directly from journal.json (P1 fix), so an unparseable
# journal cannot be attributed to any session — this is the accepted
# fail-open identity gap ADR-0038 already documents (detection is fail-open
# on no-match; enforcement is fail-closed only once a build IS matched).
# Before the P1 fix, a separate well-formed .lock carried the session match
# independently of journal parseability, so this same fixture used to BLOCK;
# that signal no longer exists (by design — see DESIGN.md).
# ---------------------------------------------------------------------------
P10=$(make_project)
WS10="$P10/.canon/workspaces/br/slug"
mkdir -p "$WS10"
printf '{not valid json' > "$WS10/journal.json"
assert_pass "10. no-op — own journal unparseable, cannot resolve session_id (accepted fail-open gap)" "$(stop_input "SESSION-10" "$P10" false)"

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

# ---------------------------------------------------------------------------
# Test 12: P1 (dc-02) — lock-absent-but-journal-matches. Explicitly asserts NO
# .lock file exists anywhere under the workspace and detection still fires via
# journal.session_id alone. finalize_workspace releases .lock unconditionally
# BEFORE the ship==completed trigger can ever fire, so a real shipped-but-
# tail-incomplete build reaches the Stop hook with .lock already gone — this
# is the exact defeat DESIGN.md documents and the fixture this fix targets.
# ---------------------------------------------------------------------------
P12=$(make_project)
J12='{"steps":[{"step_id":"ship","status":"completed"},{"step_id":"context-sync","status":"completed"}]}'
WS12=$(make_workspace "$P12" "SESSION-12" "$J12")
if [[ -f "$WS12/.lock" ]]; then
  echo "  FAIL: 12. setup invariant violated — .lock file should not exist"
  FAIL=$((FAIL + 1))
else
  assert_block "12. block — session matched via journal.session_id with NO .lock present (dc-02)" "$(stop_input "SESSION-12" "$P12" false)"
fi

# ---------------------------------------------------------------------------
# Test 13: P2 (dc-01) — jq-missing fail-closed emit. Runs the gate with a PATH
# containing the utilities it needs EXCEPT jq (mirrors PROBE-FINDINGS.md);
# asserts the gate emits the documented decision:block JSON without depending
# on jq, instead of dying silently at exit 127 with empty stdout.
# ---------------------------------------------------------------------------
NOJQ_DIR=$(mktemp -d)
TMP_ROOTS+=("$NOJQ_DIR")
for bin in bash cat grep dirname env printf ln mktemp git command; do
  bin_path=$(command -v "$bin" 2>/dev/null) && ln -sf "$bin_path" "$NOJQ_DIR/$bin"
done
P13=$(make_project)
NOJQ_OUTPUT=$(env PATH="$NOJQ_DIR" bash "$HOOK" <<< '{"session_id":"x","cwd":"'"$P13"'"}' 2>&1)
NOJQ_EXIT=$?
if [[ "$NOJQ_EXIT" -eq 0 ]] && printf '%s' "$NOJQ_OUTPUT" | grep -q '"decision"[[:space:]]*:[[:space:]]*"block"'; then
  echo "  PASS: 13. jq-missing emits decision:block instead of dying at 127 (dc-01)"
  PASS=$((PASS + 1))
else
  echo "  FAIL: 13. jq-missing emits decision:block instead of dying at 127 (dc-01)"
  echo "        expected exit=0 with decision:block, got exit=$NOJQ_EXIT output=$NOJQ_OUTPUT"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0
