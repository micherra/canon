#!/usr/bin/env bash
# Tests for correction-capture.sh.
# Exercises: feature-flag off, non-Bash input, no git restore/checkout pattern,
# commit older than 60s, git checkout -- detected, git restore detected,
# JSON validity, non-blocking when corrections dir cannot be created.
# All cases must exit 0 (hook is advisory, never blocks).

set -euo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/correction-capture.sh"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

# Helper: create a temp git repo with one commit and return the path
make_repo() {
  local dir
  dir=$(mktemp -d)
  (
    cd "$dir"
    git init -q
    git config user.email t@t
    git config user.name t
    git config commit.gpgsign false
    git config gpg.format openpgp
    echo x > a.ts
    git add a.ts
    git commit -q -m "$(printf 'feat: initial\n\nCanon-Workflow: test\nCanon-Agent: engineer\n')"
  )
  echo "$dir"
}

# Helper: build a Bash PostToolUse JSON payload
make_payload() {
  local tool="${1:-Bash}"
  local cmd="${2:-git checkout -- a.ts}"
  printf '{"tool_name":"%s","tool_input":{"command":"%s"}}' "$tool" "$cmd"
}

# ──────────────────────────────────────────────────────────────────────────────
# Test 1: Feature-flag off → exit 0 (no-op), no file written.
# ──────────────────────────────────────────────────────────────────────────────
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

CORRECTIONS_DIR="$SANDBOX/.canon/corrections"
out=$(CANON_AGENT_TEAMS_MODE=off \
      bash "$HOOK" <<<"$(make_payload)" 2>&1) \
  || fail "flag off should exit 0"
if ls "$CORRECTIONS_DIR"/*.json 2>/dev/null | grep -q .; then
  fail "flag off should write no correction files"
fi
pass "flag off is no-op, no files written"

# ──────────────────────────────────────────────────────────────────────────────
# Test 2: Non-Bash tool → exit 0 (no-op).
# ──────────────────────────────────────────────────────────────────────────────
out=$(CANON_AGENT_TEAMS_MODE=on \
      bash "$HOOK" <<<'{"tool_name":"Edit","tool_input":{"command":""}}' 2>&1) \
  || fail "non-Bash tool should exit 0"
pass "non-Bash tool ignored"

# ──────────────────────────────────────────────────────────────────────────────
# Test 3: Bash command that does not contain git restore/checkout patterns → exit 0.
# ──────────────────────────────────────────────────────────────────────────────
out=$(CANON_AGENT_TEAMS_MODE=on \
      bash "$HOOK" <<<"$(make_payload "Bash" "npm test")" 2>&1) \
  || fail "non-restore Bash should exit 0"
pass "non-restore Bash command ignored"

# ──────────────────────────────────────────────────────────────────────────────
# Test 4: Last commit older than 60 seconds → exit 0, no file written.
# ──────────────────────────────────────────────────────────────────────────────
REPO4=$(make_repo)
(
  cd "$REPO4"
  # Backdate the commit to 90 seconds ago via GIT_COMMITTER_DATE
  PAST=$(date -u -v-90S "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
         || date -u -d "-90 seconds" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
         || echo "1970-01-01T00:00:00Z")
  # Amend commit date to be 90s in the past
  GIT_COMMITTER_DATE="$PAST" git commit -q --amend --no-edit --date="$PAST" 2>/dev/null || true

  LOCAL_CORRECTIONS="$REPO4/.canon/corrections"
  out=$(CANON_AGENT_TEAMS_MODE=on \
        bash "$HOOK" <<<"$(make_payload "Bash" "git checkout -- a.ts")" 2>&1) \
    || fail "old commit case should exit 0"
  if ls "$LOCAL_CORRECTIONS"/*.json 2>/dev/null | grep -q .; then
    fail "old commit case should write no correction files"
  fi
)
rm -rf "$REPO4"
pass "old commit (>60s) is a no-op, no files written"

# ──────────────────────────────────────────────────────────────────────────────
# Test 5: git checkout -- detected within 60s → correction file written.
# ──────────────────────────────────────────────────────────────────────────────
REPO5=$(make_repo)
(
  cd "$REPO5"
  LOCAL_CORRECTIONS="$REPO5/.canon/corrections"
  out=$(CANON_AGENT_TEAMS_MODE=on \
        bash "$HOOK" <<<"$(make_payload "Bash" "git checkout -- src/services/order.ts")" 2>&1) \
    || fail "git checkout -- case should exit 0"
  COUNT=$(ls "$LOCAL_CORRECTIONS"/*.json 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$COUNT" -lt 1 ]]; then
    fail "git checkout -- case should write at least one correction file, found: $COUNT"
  fi
)
rm -rf "$REPO5"
pass "git checkout -- writes correction file"

# ──────────────────────────────────────────────────────────────────────────────
# Test 6: git restore detected within 60s → correction file written.
# ──────────────────────────────────────────────────────────────────────────────
REPO6=$(make_repo)
(
  cd "$REPO6"
  LOCAL_CORRECTIONS="$REPO6/.canon/corrections"
  out=$(CANON_AGENT_TEAMS_MODE=on \
        bash "$HOOK" <<<"$(make_payload "Bash" "git restore hooks/hook.sh")" 2>&1) \
    || fail "git restore case should exit 0"
  COUNT=$(ls "$LOCAL_CORRECTIONS"/*.json 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$COUNT" -lt 1 ]]; then
    fail "git restore case should write at least one correction file, found: $COUNT"
  fi
)
rm -rf "$REPO6"
pass "git restore writes correction file"

# ──────────────────────────────────────────────────────────────────────────────
# Test 7: Correction JSON file contains valid JSON with expected fields.
# ──────────────────────────────────────────────────────────────────────────────
REPO7=$(make_repo)
(
  cd "$REPO7"
  LOCAL_CORRECTIONS="$REPO7/.canon/corrections"
  CANON_AGENT_TEAMS_MODE=on \
    bash "$HOOK" <<<"$(make_payload "Bash" "git checkout -- src/api/handler.ts")" 2>/dev/null
  JSON_FILE=$(ls "$LOCAL_CORRECTIONS"/*.json 2>/dev/null | head -1)
  if [[ -z "$JSON_FILE" ]]; then
    fail "no correction JSON file found"
  fi
  # Validate JSON is parseable
  if ! python3 -m json.tool "$JSON_FILE" > /dev/null 2>&1; then
    fail "correction file is not valid JSON: $(cat "$JSON_FILE")"
  fi
  # Check required fields
  CONTENT=$(cat "$JSON_FILE")
  for field in file_path commit_sha timestamp; do
    if ! echo "$CONTENT" | grep -q "\"$field\""; then
      fail "missing field '$field' in correction JSON: $CONTENT"
    fi
  done
)
rm -rf "$REPO7"
pass "correction JSON file contains valid JSON with required fields"

# ──────────────────────────────────────────────────────────────────────────────
# Test 8: Hook exits 0 even when .canon/corrections/ cannot be created.
# (Simulate by making the parent directory read-only.)
# ──────────────────────────────────────────────────────────────────────────────
REPO8=$(make_repo)
(
  cd "$REPO8"
  # Create .canon but make it read-only so corrections/ cannot be created inside
  mkdir -p "$REPO8/.canon"
  chmod 444 "$REPO8/.canon"

  out=$(CANON_AGENT_TEAMS_MODE=on \
        bash "$HOOK" <<<"$(make_payload "Bash" "git checkout -- a.ts")" 2>&1) \
    || fail "unwritable corrections dir case should exit 0"

  # Restore permissions for cleanup
  chmod 755 "$REPO8/.canon"
)
rm -rf "$REPO8"
pass "hook exits 0 even when corrections dir cannot be created"

echo "correction-capture.sh: all tests passed"
