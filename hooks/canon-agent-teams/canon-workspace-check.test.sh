#!/usr/bin/env bash
# Tests for canon-workspace-check.sh.
# Exercises: feature-flag off, bypass gate, Edit/Write/Bash blocking, gitignored
# paths, workspace present, parent-workspace lookup for worktrees.
#
# Each test case creates its own sandbox git repo and cleans up after itself.

set -euo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/canon-workspace-check.sh"

pass() { echo "PASS: $1"; }
fail() { echo "FAIL: $1" >&2; exit 1; }

# Helper: create a minimal git repo with a tracked file and an ignored path.
# Usage: _setup_repo <dir>
_setup_repo() {
  local dir="$1"
  mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" config user.email "t@t"
  git -C "$dir" config user.name "t"
  git -C "$dir" config commit.gpgsign false
  # Create a tracked file
  mkdir -p "$dir/src"
  echo "tracked" > "$dir/src/app.ts"
  # Create .gitignore that ignores .canon/
  printf ".canon/\n" > "$dir/.gitignore"
  git -C "$dir" add .gitignore src/app.ts
  git -C "$dir" commit -q -m "init"
}

# Helper: create an active workspace session.json for a branch.
# Usage: _create_workspace <repo_dir> <branch> <status>
_create_workspace() {
  local repo_dir="$1"
  local branch="$2"
  local status="${3:-active}"
  local slug
  slug=$(echo "$branch" | tr '/' '-' | tr '[:upper:]' '[:lower:]')
  local ws_dir="$repo_dir/.canon/workspaces/$slug"
  mkdir -p "$ws_dir"
  cat > "$ws_dir/session.json" <<EOF
{
  "branch": "$branch",
  "sanitized": "$slug",
  "status": "$status",
  "flow": "fast-path",
  "task": "test task"
}
EOF
}

# Helper: invoke the hook with given env vars and stdin.
# Usage: _run_hook <stdin_json> [env_var=val ...]
# The function uses TOOL_NAME from the caller's env.
_run_hook() {
  local stdin_json="$1"
  shift
  env "$@" bash "$HOOK" <<< "$stdin_json"
}

# ── Setup master sandbox ───────────────────────────────────────────────────────
MASTER_SANDBOX=$(mktemp -d)
trap 'rm -rf "$MASTER_SANDBOX"' EXIT

# ─────────────────────────────────────────────────────────────────────────────
# 2. CANON_BYPASS_WORKSPACE_CHECK=1 → ALLOWED
# ─────────────────────────────────────────────────────────────────────────────
T2="$MASTER_SANDBOX/t2"
_setup_repo "$T2"

(
  cd "$T2"
  CANON_BYPASS_WORKSPACE_CHECK=1 TOOL_NAME=Edit \
    bash "$HOOK" <<< '{"file_path": "src/app.ts"}' \
    >/dev/null 2>&1
) || fail "2: bypass gate should exit 0"
pass "2: CANON_BYPASS_WORKSPACE_CHECK=1 bypasses check"

# ─────────────────────────────────────────────────────────────────────────────
# 3. Edit tracked file, no workspace → BLOCKED
# ─────────────────────────────────────────────────────────────────────────────
T3="$MASTER_SANDBOX/t3"
_setup_repo "$T3"

exit_code=0
(
  cd "$T3"
  TOOL_NAME=Edit \
    bash "$HOOK" <<< '{"file_path": "src/app.ts"}' \
    >/dev/null 2>&1
) || exit_code=$?

[[ "$exit_code" -eq 2 ]] || fail "3: expected exit 2, got $exit_code"
pass "3: Edit tracked file with no workspace → blocked (exit 2)"

# ─────────────────────────────────────────────────────────────────────────────
# 4. Edit gitignored file, no workspace → ALLOWED
# ─────────────────────────────────────────────────────────────────────────────
T4="$MASTER_SANDBOX/t4"
_setup_repo "$T4"

(
  cd "$T4"
  TOOL_NAME=Edit \
    bash "$HOOK" <<< '{"file_path": ".canon/workspaces/test/session.json"}' \
    >/dev/null 2>&1
) || fail "4: gitignored file should exit 0"
pass "4: Edit gitignored file with no workspace → allowed"

# ─────────────────────────────────────────────────────────────────────────────
# 5. Write tracked file, no workspace → BLOCKED
# ─────────────────────────────────────────────────────────────────────────────
T5="$MASTER_SANDBOX/t5"
_setup_repo "$T5"

exit_code=0
(
  cd "$T5"
  TOOL_NAME=Write \
    bash "$HOOK" <<< '{"file_path": "src/app.ts"}' \
    >/dev/null 2>&1
) || exit_code=$?

[[ "$exit_code" -eq 2 ]] || fail "5: expected exit 2, got $exit_code"
pass "5: Write tracked file with no workspace → blocked (exit 2)"

# ─────────────────────────────────────────────────────────────────────────────
# 6. Bash with tracked redirect target, no workspace → BLOCKED
# ─────────────────────────────────────────────────────────────────────────────
T6="$MASTER_SANDBOX/t6"
_setup_repo "$T6"

exit_code=0
(
  cd "$T6"
  TOOL_NAME=Bash \
    bash "$HOOK" <<< '{"command": "sed -i '\'''\'' '\''s/foo/bar/'\'' README.md"}' \
    >/dev/null 2>&1
) || exit_code=$?

[[ "$exit_code" -eq 2 ]] || fail "6: expected exit 2, got $exit_code"
pass "6: Bash with tracked target (sed -i) with no workspace → blocked"

# ─────────────────────────────────────────────────────────────────────────────
# 7. Bash with gitignored redirect target → ALLOWED
# ─────────────────────────────────────────────────────────────────────────────
T7="$MASTER_SANDBOX/t7"
_setup_repo "$T7"

(
  cd "$T7"
  TOOL_NAME=Bash \
    bash "$HOOK" <<< '{"command": "echo test > .canon/test.log"}' \
    >/dev/null 2>&1
) || fail "7: gitignored Bash target should exit 0"
pass "7: Bash with gitignored redirect target → allowed"

# ─────────────────────────────────────────────────────────────────────────────
# 8. Bash with no file targets → ALLOWED
# ─────────────────────────────────────────────────────────────────────────────
T8="$MASTER_SANDBOX/t8"
_setup_repo "$T8"

(
  cd "$T8"
  TOOL_NAME=Bash \
    bash "$HOOK" <<< '{"command": "ls -la"}' \
    >/dev/null 2>&1
) || fail "8: Bash with no file targets should exit 0"
pass "8: Bash with no file targets → allowed"

# ─────────────────────────────────────────────────────────────────────────────
# 9. Edit tracked file, workspace present for current branch → ALLOWED
# ─────────────────────────────────────────────────────────────────────────────
T9="$MASTER_SANDBOX/t9"
_setup_repo "$T9"

# Get current branch name (usually 'main' or 'master' in a fresh repo)
current_branch=$(git -C "$T9" symbolic-ref --short HEAD 2>/dev/null || echo "main")
_create_workspace "$T9" "$current_branch" "active"

(
  cd "$T9"
  TOOL_NAME=Edit \
    bash "$HOOK" <<< '{"file_path": "src/app.ts"}' \
    >/dev/null 2>&1
) || fail "9: active workspace should allow edit, expected exit 0"
pass "9: Edit tracked file with active workspace → allowed"

# ─────────────────────────────────────────────────────────────────────────────
# 10. Edit tracked file, workspace present but completed → BLOCKED
# ─────────────────────────────────────────────────────────────────────────────
T10="$MASTER_SANDBOX/t10"
_setup_repo "$T10"

current_branch=$(git -C "$T10" symbolic-ref --short HEAD 2>/dev/null || echo "main")
_create_workspace "$T10" "$current_branch" "completed"

exit_code=0
(
  cd "$T10"
  TOOL_NAME=Edit \
    bash "$HOOK" <<< '{"file_path": "src/app.ts"}' \
    >/dev/null 2>&1
) || exit_code=$?

[[ "$exit_code" -eq 2 ]] || fail "10: completed workspace should not allow edit, expected exit 2, got $exit_code"
pass "10: Edit tracked file with completed-only workspace → blocked"

# ─────────────────────────────────────────────────────────────────────────────
# 11. Bash with tee target (tracked) → BLOCKED
# ─────────────────────────────────────────────────────────────────────────────
T11="$MASTER_SANDBOX/t11"
_setup_repo "$T11"

exit_code=0
(
  cd "$T11"
  TOOL_NAME=Bash \
    bash "$HOOK" <<< '{"command": "echo hello | tee src/app.ts"}' \
    >/dev/null 2>&1
) || exit_code=$?

[[ "$exit_code" -eq 2 ]] || fail "11: expected exit 2, got $exit_code"
pass "11: Bash with tee to tracked file → blocked"

# ─────────────────────────────────────────────────────────────────────────────
# 12. Bash with redirect to gitignored target → ALLOWED
# ─────────────────────────────────────────────────────────────────────────────
T12="$MASTER_SANDBOX/t12"
_setup_repo "$T12"

(
  cd "$T12"
  TOOL_NAME=Bash \
    bash "$HOOK" <<< '{"command": "echo hi >> .canon/log.txt"}' \
    >/dev/null 2>&1
) || fail "12: gitignored append target should exit 0"
pass "12: Bash with >> to gitignored file → allowed"

# ─────────────────────────────────────────────────────────────────────────────
# 13. Edit in worktree with CANON_PARENT_WORKSPACE pointing to active ws → ALLOWED
# ─────────────────────────────────────────────────────────────────────────────
T13_MAIN="$MASTER_SANDBOX/t13-main"
T13_WT="$MASTER_SANDBOX/t13-worktree"

_setup_repo "$T13_MAIN"

# Record the initial branch (parent) and create the active workspace for it
parent_branch=$(git -C "$T13_MAIN" symbolic-ref --short HEAD 2>/dev/null || echo "main")
_create_workspace "$T13_MAIN" "$parent_branch" "active"
parent_slug=$(echo "$parent_branch" | tr '/' '-' | tr '[:upper:]' '[:lower:]')

# Create a worktree on a new branch (worktree-branch, different from parent_branch)
git -C "$T13_MAIN" branch "worktree-branch" 2>/dev/null || true
git -C "$T13_MAIN" worktree add -q "$T13_WT" "worktree-branch"

(
  cd "$T13_WT"
  TOOL_NAME=Edit \
  CANON_PARENT_WORKSPACE="$parent_slug" \
    bash "$HOOK" <<< '{"file_path": "src/app.ts"}' \
    >/dev/null 2>&1
) || fail "13: worktree with active parent workspace should exit 0"
pass "13: Edit in worktree with active CANON_PARENT_WORKSPACE → allowed"

# Cleanup worktree
git -C "$T13_MAIN" worktree remove --force "$T13_WT" 2>/dev/null || true

# ─────────────────────────────────────────────────────────────────────────────
# 15. Bash with redirect, no space after > (e.g. >src/app.ts) → BLOCKED
# ─────────────────────────────────────────────────────────────────────────────
T15="$MASTER_SANDBOX/t15"
_setup_repo "$T15"

exit_code=0
(
  cd "$T15"
  TOOL_NAME=Bash \
    bash "$HOOK" <<< '{"command": "echo hi >src/app.ts"}' \
    >/dev/null 2>&1
) || exit_code=$?

[[ "$exit_code" -eq 2 ]] || fail "15: expected exit 2, got $exit_code"
pass "15: Bash with >file (no space) to tracked file → blocked"

# ─────────────────────────────────────────────────────────────────────────────
# 16. Bash with tee writing to multiple files, one tracked → BLOCKED
# ─────────────────────────────────────────────────────────────────────────────
T16="$MASTER_SANDBOX/t16"
_setup_repo "$T16"

exit_code=0
(
  cd "$T16"
  TOOL_NAME=Bash \
    bash "$HOOK" <<< '{"command": "echo hi | tee .canon/log.txt src/app.ts"}' \
    >/dev/null 2>&1
) || exit_code=$?

[[ "$exit_code" -eq 2 ]] || fail "16: expected exit 2, got $exit_code"
pass "16: Bash with tee to gitignored + tracked files → blocked"

# ─────────────────────────────────────────────────────────────────────────────
# 14. Block message content check — BLOCKED with expected message
# ─────────────────────────────────────────────────────────────────────────────
T14="$MASTER_SANDBOX/t14"
_setup_repo "$T14"

stderr_msg=""
exit_code=0
stderr_msg=$(
  cd "$T14"
  TOOL_NAME=Edit \
    bash "$HOOK" <<< '{"file_path": "src/app.ts"}' \
    2>&1 >/dev/null
) || exit_code=$?

[[ "$exit_code" -eq 2 ]] || fail "14: expected exit 2, got $exit_code"
echo "$stderr_msg" | grep -q "No active Canon workspace" \
  || fail "14: expected block message, got: $stderr_msg"
pass "14: Block message contains expected text"

# ─────────────────────────────────────────────────────────────────────────────
echo "canon-workspace-check.sh: all tests passed"
