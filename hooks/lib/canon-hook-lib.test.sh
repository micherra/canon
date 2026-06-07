#!/usr/bin/env bash
# canon-hook-lib.test.sh — Unit tests for canon-hook-lib.sh
#
# Run: bash hooks/lib/canon-hook-lib.test.sh
# Exit 0: all tests pass. Exit 1: one or more failures.

set -euo pipefail

# Locate the library relative to this test file.
LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=hooks/lib/canon-hook-lib.sh
source "${LIB_DIR}/canon-hook-lib.sh"

# ---------------------------------------------------------------------------
# Minimal test harness
# ---------------------------------------------------------------------------
PASS=0
FAIL=0
ERRORS=()

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    PASS=$(( PASS + 1 ))
    printf '  PASS  %s\n' "$label"
  else
    FAIL=$(( FAIL + 1 ))
    ERRORS+=("FAIL: $label — expected $(printf '%q' "$expected"), got $(printf '%q' "$actual")")
    printf '  FAIL  %s\n        expected: %q\n        actual:   %q\n' "$label" "$expected" "$actual"
  fi
}

assert_true() {
  local label="$1"
  shift
  if "$@" 2>/dev/null; then
    PASS=$(( PASS + 1 ))
    printf '  PASS  %s\n' "$label"
  else
    FAIL=$(( FAIL + 1 ))
    ERRORS+=("FAIL: $label — expected exit 0 (true), got non-zero")
    printf '  FAIL  %s  (expected true)\n' "$label"
  fi
}

assert_false() {
  local label="$1"
  shift
  if ! "$@" 2>/dev/null; then
    PASS=$(( PASS + 1 ))
    printf '  PASS  %s\n' "$label"
  else
    FAIL=$(( FAIL + 1 ))
    ERRORS+=("FAIL: $label — expected non-zero (false), got exit 0")
    printf '  FAIL  %s  (expected false)\n' "$label"
  fi
}

# ---------------------------------------------------------------------------
# canon_extract_command
# ---------------------------------------------------------------------------
printf '\n=== canon_extract_command ===\n'

VALID_JSON='{"tool_name":"Bash","command":"git commit -m test","session_id":"abc"}'
assert_eq "valid JSON — extracts command" \
  "git commit -m test" \
  "$(canon_extract_command "$VALID_JSON")"

EMPTY_JSON='{}'
assert_eq "empty JSON — returns empty string" \
  "" \
  "$(canon_extract_command "$EMPTY_JSON")"

MALFORMED_JSON='not json at all'
# Should not crash; may return empty.
RESULT=$(canon_extract_command "$MALFORMED_JSON" 2>/dev/null || true)
assert_eq "malformed JSON — does not crash" \
  "" \
  "$RESULT"

EMPTY_INPUT=''
assert_eq "empty input — returns empty string" \
  "" \
  "$(canon_extract_command "$EMPTY_INPUT")"

# YYY2 regression: the real Claude Code payload wraps command under tool_input.
# This is the extraction path the entire jq migration was built for.
NESTED_JSON='{"tool_name":"Bash","tool_input":{"command":"git commit -m \"test\""}}'
assert_eq "nested tool_input.command — extracts command" \
  'git commit -m "test"' \
  "$(canon_extract_command "$NESTED_JSON")"

NESTED_NO_CMD='{"tool_name":"Bash","tool_input":{"other":"value"}}'
assert_eq "nested tool_input without command — returns empty string" \
  "" \
  "$(canon_extract_command "$NESTED_NO_CMD")"

# Flat .command takes lower priority; .tool_input.command wins when both present.
BOTH_JSON='{"command":"flat-cmd","tool_input":{"command":"nested-cmd"}}'
assert_eq "both command paths — tool_input.command takes precedence" \
  "nested-cmd" \
  "$(canon_extract_command "$BOTH_JSON")"

# Escaped-quote value — the grep/sed fallback must NOT return a lone backslash.
# When jq is present it parses correctly; when jq is absent the fallback must
# return empty (fail-closed) rather than a garbage partial parse.
#
# Build a minimal PATH that includes grep/sed/bash/git/head/awk/printf/tr but
# NOT jq, so that command -v jq returns non-zero inside the subshell.
# Use /usr/bin/which to get the real binary path, not a shell function wrapper.
_LIB_TMPBIN=$(mktemp -d)
for _tool in grep sed awk head bash git printf tr cat echo dirname basename; do
  _tp=$(/usr/bin/which "$_tool" 2>/dev/null || true)
  if [[ -n "$_tp" ]]; then
    ln -sf "$_tp" "$_LIB_TMPBIN/$_tool" 2>/dev/null || true
  fi
done
NO_JQ_TEST_PATH="$_LIB_TMPBIN"
# Register cleanup for test dir
trap 'rm -rf "$_LIB_TMPBIN"' EXIT

ESCAPED_RESULT=$(PATH="$NO_JQ_TEST_PATH" bash -c '
  source "'"${LIB_DIR}/canon-hook-lib.sh"'"
  canon_extract_command '"'"'{"tool_input":{"command":"\"git checkout -- ."}}'"'"'
' 2>/dev/null || true)
assert_eq "truly-absent-jq: escaped-quote value returns empty (fail-closed)" \
  "" \
  "$ESCAPED_RESULT"

# Normal value with truly absent jq — must still extract correctly.
PLAIN_RESULT=$(PATH="$NO_JQ_TEST_PATH" bash -c '
  source "'"${LIB_DIR}/canon-hook-lib.sh"'"
  canon_extract_command '"'"'{"command":"git status"}'"'"'
' 2>/dev/null || true)
assert_eq "truly-absent-jq: plain command value extracts correctly" \
  "git status" \
  "$PLAIN_RESULT"

# ---------------------------------------------------------------------------
# canon_git_dir_arg
# ---------------------------------------------------------------------------
printf '\n=== canon_git_dir_arg ===\n'

# Use a directory that is guaranteed to exist on any system.
REAL_DIR="/tmp"

assert_eq "cd /tmp && git commit — returns -C /tmp" \
  "-C /tmp" \
  "$(canon_git_dir_arg "cd /tmp && git commit -m msg")"

assert_eq "no cd prefix — returns empty" \
  "" \
  "$(canon_git_dir_arg "git commit -m msg")"

assert_eq "nonexistent dir — returns empty" \
  "" \
  "$(canon_git_dir_arg "cd /this/path/does/not/exist/9x7z && git commit")"

assert_eq "leading spaces before cd — returns -C /tmp" \
  "-C /tmp" \
  "$(canon_git_dir_arg "  cd /tmp && git commit")"

assert_eq "cd with trailing space before && — returns -C /tmp" \
  "-C /tmp" \
  "$(canon_git_dir_arg "cd /tmp  && git commit")"

assert_eq "double-quoted cd target — strips quotes, returns -C /tmp" \
  "-C /tmp" \
  "$(canon_git_dir_arg "cd \"/tmp\" && git commit")"

assert_eq "single-quoted cd target — strips quotes, returns -C /tmp" \
  "-C /tmp" \
  "$(canon_git_dir_arg "cd '/tmp' && git commit")"

assert_eq "quoted nonexistent dir — -d gate still applies, returns empty" \
  "" \
  "$(canon_git_dir_arg "cd \"/this/path/does/not/exist/9x7z\" && git commit")"

# ---------------------------------------------------------------------------
# canon_is_git_cmd
# ---------------------------------------------------------------------------
printf '\n=== canon_is_git_cmd (subcmd=commit) ===\n'

assert_true  "plain git commit" \
  canon_is_git_cmd "git commit -m msg" "commit"

assert_true  "git -C /path commit" \
  canon_is_git_cmd "git -C /some/path commit -m msg" "commit"

assert_true  "cd /x && git commit" \
  canon_is_git_cmd "cd /x && git commit -m msg" "commit"

assert_true  "bare git commit (no args)" \
  canon_is_git_cmd "git commit" "commit"

assert_false "git diff pre-commit-branch-guard.sh — must NOT match commit" \
  canon_is_git_cmd "git diff pre-commit-branch-guard.sh" "commit"

assert_false "git log --oneline — not a commit" \
  canon_is_git_cmd "git log --oneline" "commit"

assert_false "git stash — not a commit" \
  canon_is_git_cmd "git stash" "commit"

printf '\n=== canon_is_git_cmd (subcmd=merge) ===\n'

assert_true  "git merge branch" \
  canon_is_git_cmd "git merge feature/foo" "merge"

assert_false "git commit — not a merge" \
  canon_is_git_cmd "git commit -m msg" "merge"

# ---------------------------------------------------------------------------
# canon_git_subcommand — Bug-1 regression: command-prefix wrappers
# Old code: sed removed only the "git" word, leaving the wrapper prefix
# fused to the next token (e.g. sudo → "sudoclean"). Fix: awk anchors to
# the first standalone "git" token.
# ---------------------------------------------------------------------------
printf '\n=== canon_git_subcommand — Bug-1: command-prefix wrappers ===\n'

assert_eq "sudo git clean -fd → clean" \
  "clean" \
  "$(canon_git_subcommand "sudo git clean -fd")"

assert_eq "env git clean -fd → clean" \
  "clean" \
  "$(canon_git_subcommand "env git clean -fd")"

assert_eq "env VAR=1 git clean -fd → clean" \
  "clean" \
  "$(canon_git_subcommand "env VAR=1 git clean -fd")"

assert_eq "time git reset --hard → reset" \
  "reset" \
  "$(canon_git_subcommand "time git reset --hard")"

assert_eq "nice git clean -fd → clean" \
  "clean" \
  "$(canon_git_subcommand "nice git clean -fd")"

assert_eq "nice -n 5 git clean -fd → clean" \
  "clean" \
  "$(canon_git_subcommand "nice -n 5 git clean -fd")"

assert_eq "command git clean -fd → clean" \
  "clean" \
  "$(canon_git_subcommand "command git clean -fd")"

assert_eq "sudo git status → status" \
  "status" \
  "$(canon_git_subcommand "sudo git status")"

# ---------------------------------------------------------------------------
# canon_git_subcommand — Bug-2 regression: quoted option values with spaces
# Old code (via tr-d pre-processing): "git -C my dir reset --hard" →
# "-C" consumed "my", "dir" became the subcommand → fail-OPEN.
# Fix: canon_git_subcommand now receives the RAW (pre-quote-deletion)
# segment and uses a quote-aware tokenizer that keeps "my dir" as one token.
# ---------------------------------------------------------------------------
printf '\n=== canon_git_subcommand — Bug-2: quoted option values with spaces ===\n'

assert_eq 'git -C "my dir" reset --hard → reset (raw: quoted value stays one token)' \
  "reset" \
  "$(canon_git_subcommand 'git -C "my dir" reset --hard')"

assert_eq "git -C 'my dir' clean -fd → clean (single-quoted value)" \
  "clean" \
  "$(canon_git_subcommand "git -C 'my dir' clean -fd")"

assert_eq 'git --git-dir "my dir/.git" reset --hard → reset' \
  "reset" \
  "$(canon_git_subcommand 'git --git-dir "my dir/.git" reset --hard')"

assert_eq 'git -C "my dir" log → log (non-destructive, still resolves)' \
  "log" \
  "$(canon_git_subcommand 'git -C "my dir" log --oneline')"

# Plain (unquoted) single-word value must still work after the fix.
assert_eq 'git -C /some/path reset --hard → reset (unquoted, no regression)' \
  "reset" \
  "$(canon_git_subcommand 'git -C /some/path reset --hard')"

# Plain (unquoted) single-word value must still work after the fix.
assert_eq 'git -C /some/path reset --hard → reset (unquoted, no regression)' \
  "reset" \
  "$(canon_git_subcommand 'git -C /some/path reset --hard')"

# Bypass-3 compatibility: intra-token quotes are still handled correctly
# because the tokenizer removes quote chars when building each token, and
# the subcommand is further stripped of any residual quote chars.
assert_eq 'git cl""ean -f → clean (Bypass-3 intra-token quotes still work)' \
  "clean" \
  "$(canon_git_subcommand 'git cl""ean -f')"

# ---------------------------------------------------------------------------
# canon_git_subcommand — Bug-3 regression: spurious "git" value/positional
# When a prefix supplies a literal "git" as its own argument (env git git …,
# sudo -u git git …, nice -n git git …, git git …), the token walk returns
# "git" as the candidate subcommand. "git" is not a valid git subcommand;
# the fix returns 1 (unresolved) so the parse-ambiguity guard fires → exit 2.
# ---------------------------------------------------------------------------
printf '\n=== canon_git_subcommand — Bug-3: spurious git value before real git ===\n'

assert_false 'env git git reset --hard → unresolved (returns 1)' \
  canon_git_subcommand "env git git reset --hard"

assert_false 'sudo -u git git reset --hard → unresolved (returns 1)' \
  canon_git_subcommand "sudo -u git git reset --hard"

assert_false 'nice -n git git clean -fd → unresolved (returns 1)' \
  canon_git_subcommand "nice -n git git clean -fd"

assert_false 'git git reset --hard → unresolved (returns 1)' \
  canon_git_subcommand "git git reset --hard"

# Prior Bug-1 fixes must still hold: single-git wrapper still resolves.
assert_eq 'sudo git clean -fd still resolves to clean' \
  "clean" \
  "$(canon_git_subcommand 'sudo git clean -fd')"

assert_eq 'env git status still resolves to status' \
  "status" \
  "$(canon_git_subcommand 'env git status')"

# ---------------------------------------------------------------------------
# canon_strip_comments
# ---------------------------------------------------------------------------
printf '\n=== canon_strip_comments ===\n'

# Full-line comment dropped; newline preserved (so line count stays the same).
assert_eq 'full-line comment dropped' \
  "" \
  "$(printf '# this is a comment\n' | canon_strip_comments)"

# Note: the newline itself is preserved in the output — we test line count separately below.

# Trailing comment on same line dropped (space before #).
assert_eq 'trailing comment on same line dropped' \
  "ls /tmp " \
  "$(printf 'ls /tmp # checked against git\n' | canon_strip_comments)"

# # inside double quotes preserved (not a comment).
assert_eq '# inside double quotes preserved' \
  'git commit -m "fix #42"' \
  "$(printf 'git commit -m "fix #42"\n' | canon_strip_comments)"

# # inside single quotes preserved.
assert_eq "# inside single quotes preserved" \
  "echo 'not a #comment'" \
  "$(printf "echo 'not a #comment'\n" | canon_strip_comments)"

# foo#bar (no word boundary) — not a comment, emitted verbatim.
assert_eq 'foo#bar mid-word not a comment' \
  "foo#bar" \
  "$(printf 'foo#bar\n' | canon_strip_comments)"

# $# — not a comment (# is not at word start).
assert_eq '$# not a comment' \
  'echo $#' \
  "$(printf 'echo $#\n' | canon_strip_comments)"

# Apostrophe inside a comment does NOT poison quote state for following lines.
# After the comment line, the next line should still be processed normally.
assert_eq "apostrophe in comment does not affect following line" \
  "ls" \
  "$(printf "# workspace's worktree\nls\n" | canon_strip_comments | tail -1)"

# Multiline double-quoted string spanning a line whose text starts with # is preserved.
assert_eq 'multiline dq string: line starting with # inside dq preserved' \
  '#not-a-comment-inside-dq' \
  "$(printf 'echo "\n#not-a-comment-inside-dq\n"\n' | canon_strip_comments | sed -n '2p')"

# Newline count of output equals input (comment lines still emit a newline).
_INPUT_LINES=$(printf '# comment\nls /tmp\n# another\n' | wc -l | tr -d ' ')
_OUTPUT_LINES=$(printf '# comment\nls /tmp\n# another\n' | canon_strip_comments | wc -l | tr -d ' ')
assert_eq 'newline count of output equals input' \
  "$_INPUT_LINES" \
  "$_OUTPUT_LINES"

# ---------------------------------------------------------------------------
# canon_has_git_token
# ---------------------------------------------------------------------------
printf '\n=== canon_has_git_token ===\n'

assert_true '"git status" has git token' \
  canon_has_git_token "git status"

assert_false '"echo \"git x\"" has no standalone git token' \
  canon_has_git_token 'echo "git x"'

assert_true '"\"git\" status" (quoted git) has git token' \
  canon_has_git_token '"git" status'

assert_true '"sudo git status" has git token' \
  canon_has_git_token "sudo git status"

assert_false '"forgit status" has no standalone git token (prefix match)' \
  canon_has_git_token "forgit status"

# ---------------------------------------------------------------------------
# canon_git_subcommand — shape validation (new in this task)
# ---------------------------------------------------------------------------
printf '\n=== canon_git_subcommand — shape validation ===\n'

# $CMD: unresolvable variable token → shape validation rejects it → returns 1.
_SUBCMD_VAR='$CMD'
assert_false "git \$CMD → unresolved (shape validation, returns 1)" \
  canon_git_subcommand "git $_SUBCMD_VAR"

# ${CMD}: brace-form variable → shape validation rejects it → returns 1.
assert_false 'git ${CMD} → unresolved (shape validation, returns 1)' \
  canon_git_subcommand 'git ${CMD}'

# Existing Bug-1/2/3 expectations stay unchanged.
assert_eq "git -C /some/path status still resolves (shape valid)" \
  "status" \
  "$(canon_git_subcommand 'git -C /some/path status')"

# ---------------------------------------------------------------------------
# canon_unwrap_string_exec_arg — P1 fix: string-executing wrapper detector
# ---------------------------------------------------------------------------
printf '\n=== canon_unwrap_string_exec_arg ===\n'

# Core cases: eval
assert_eq 'eval "git reset --hard" extracts inner command' \
  "git reset --hard" \
  "$(canon_unwrap_string_exec_arg 'eval "git reset --hard"')"

assert_eq 'eval git clean -fd (unquoted) extracts as joined tokens' \
  "git clean -fd" \
  "$(canon_unwrap_string_exec_arg 'eval git clean -fd')"

assert_eq "eval 'git clean -fd' (single-quoted) extracts inner command" \
  "git clean -fd" \
  "$(canon_unwrap_string_exec_arg "eval 'git clean -fd'")"

# Core cases: shell wrappers with -c
assert_eq 'bash -c "git reset --hard" extracts inner command' \
  "git reset --hard" \
  "$(canon_unwrap_string_exec_arg 'bash -c "git reset --hard"')"

assert_eq 'sh -c "git clean -fd" extracts inner command' \
  "git clean -fd" \
  "$(canon_unwrap_string_exec_arg 'sh -c "git clean -fd"')"

assert_eq 'zsh -c "git reset --hard" extracts inner command' \
  "git reset --hard" \
  "$(canon_unwrap_string_exec_arg 'zsh -c "git reset --hard"')"

assert_eq 'ksh -c "git clean -f" extracts inner command' \
  "git clean -f" \
  "$(canon_unwrap_string_exec_arg 'ksh -c "git clean -f"')"

# Transparent prefixes
assert_eq 'command eval "git reset --hard" extracts inner command' \
  "git reset --hard" \
  "$(canon_unwrap_string_exec_arg 'command eval "git reset --hard"')"

assert_eq 'nohup bash -c "git clean -fd" extracts inner command' \
  "git clean -fd" \
  "$(canon_unwrap_string_exec_arg 'nohup bash -c "git clean -fd"')"

assert_eq 'timeout 5 bash -c "git reset --hard" extracts inner command' \
  "git reset --hard" \
  "$(canon_unwrap_string_exec_arg 'timeout 5 bash -c "git reset --hard"')"

assert_eq 'env X=1 bash -c "git clean -fd" extracts inner command' \
  "git clean -fd" \
  "$(canon_unwrap_string_exec_arg 'env X=1 bash -c "git clean -fd"')"

assert_eq 'env X=1 Y=2 sh -c "git reset --hard" extracts inner command' \
  "git reset --hard" \
  "$(canon_unwrap_string_exec_arg 'env X=1 Y=2 sh -c "git reset --hard"')"

assert_eq 'nice bash -c "git reset --hard" extracts inner command' \
  "git reset --hard" \
  "$(canon_unwrap_string_exec_arg 'nice bash -c "git reset --hard"')"

assert_eq 'nice -n 5 bash -c "git clean -f" extracts inner command' \
  "git clean -f" \
  "$(canon_unwrap_string_exec_arg 'nice -n 5 bash -c "git clean -f"')"

# Non-executing wrappers — must return empty (return 1)
assert_eq 'echo "git reset --hard" returns empty (not a string executor)' \
  "" \
  "$(canon_unwrap_string_exec_arg 'echo "git reset --hard"' 2>/dev/null || true)"

assert_eq 'printf "git clean -fd" returns empty (not a string executor)' \
  "" \
  "$(canon_unwrap_string_exec_arg 'printf "git clean -fd"' 2>/dev/null || true)"

assert_eq 'git status returns empty (not a wrapper)' \
  "" \
  "$(canon_unwrap_string_exec_arg 'git status' 2>/dev/null || true)"

# bash without -c (script mode) — must return empty
assert_eq 'bash script.sh returns empty (not -c mode)' \
  "" \
  "$(canon_unwrap_string_exec_arg 'bash script.sh' 2>/dev/null || true)"

# eval with no argument — must return empty
assert_eq 'eval with no argument returns empty' \
  "" \
  "$(canon_unwrap_string_exec_arg 'eval' 2>/dev/null || true)"

# bash -c with no argument — must return empty
assert_eq 'bash -c with no string argument returns empty' \
  "" \
  "$(canon_unwrap_string_exec_arg 'bash -c' 2>/dev/null || true)"

# Safe inner commands — extracts correctly (caller decides if destructive)
assert_eq 'bash -c "git status" extracts git status' \
  "git status" \
  "$(canon_unwrap_string_exec_arg 'bash -c "git status"')"

assert_eq 'eval "git log --oneline" extracts git log --oneline' \
  "git log --oneline" \
  "$(canon_unwrap_string_exec_arg 'eval "git log --oneline"')"

# ---------------------------------------------------------------------------
# canon_unwrap_string_exec_arg — Round-2 bypass fixes
# ---------------------------------------------------------------------------
printf '\n=== canon_unwrap_string_exec_arg — round-2 bypass fixes ===\n'

# Bypass class 1: Path-qualified wrappers — basename matching.
assert_eq '/bin/bash -c extracts inner command (path-qualified)' \
  "git reset --hard" \
  "$(canon_unwrap_string_exec_arg '/bin/bash -c "git reset --hard"')"

assert_eq '/bin/sh -c extracts inner command (path-qualified)' \
  "git clean -fd" \
  "$(canon_unwrap_string_exec_arg '/bin/sh -c "git clean -fd"')"

assert_eq '/usr/local/bin/zsh -c extracts (deep path-qualified)' \
  "git checkout -- ." \
  "$(canon_unwrap_string_exec_arg '/usr/local/bin/zsh -c "git checkout -- ."')"

# /usr/bin/env bash -c: env is path-qualified (/usr/bin/env → env prefix), then bash
assert_eq '/usr/bin/env bash -c extracts (path-qualified env + bash)' \
  "git reset --hard" \
  "$(canon_unwrap_string_exec_arg '/usr/bin/env bash -c "git reset --hard"')"

# Bypass class 2: Combined short flags — 'c' as last char of cluster.
assert_eq 'bash -ec "git reset --hard" extracts (c last in cluster)' \
  "git reset --hard" \
  "$(canon_unwrap_string_exec_arg 'bash -ec "git reset --hard"')"

assert_eq 'bash -lc "git clean -fd" extracts (c last in cluster)' \
  "git clean -fd" \
  "$(canon_unwrap_string_exec_arg 'bash -lc "git clean -fd"')"

assert_eq 'sh -xc "git reset --hard" extracts (c last in cluster)' \
  "git reset --hard" \
  "$(canon_unwrap_string_exec_arg 'sh -xc "git reset --hard"')"

# Bypass class 3: Prefix-owned flags — env -i, command -p.
assert_eq 'env -i bash -c extracts (env owns -i flag)' \
  "git reset --hard" \
  "$(canon_unwrap_string_exec_arg 'env -i bash -c "git reset --hard"')"

assert_eq 'command -p eval extracts (command owns -p flag)' \
  "git reset --hard" \
  "$(canon_unwrap_string_exec_arg 'command -p eval "git reset --hard"')"

# Bypass class 4: Escaped inner quotes → rc=2 (fail-closed, not skip-pass).
# The tokenizer leaves backslash artifacts; the backslash check fires rc=2.
_ESC_QT_RC=0
_ESC_QT_OUT=$(canon_unwrap_string_exec_arg 'bash -c "git reset \"--hard\""') || _ESC_QT_RC=$?
assert_eq 'bash -c "git reset \"--hard\"" returns empty (fail-closed, rc=2 path)' \
  "" \
  "$_ESC_QT_OUT"
# The rc should be 2 (fail-closed), not 0 or 1.
if [[ "$_ESC_QT_RC" -eq 2 ]]; then
  PASS=$(( PASS + 1 ))
  printf '  PASS  bash -c escaped-inner-quote → rc=2 (fail-closed)\n'
else
  FAIL=$(( FAIL + 1 ))
  ERRORS+=("FAIL: bash -c escaped-inner-quote — expected rc=2, got rc=$_ESC_QT_RC")
  printf '  FAIL  bash -c escaped-inner-quote → expected rc=2, got rc=%d\n' "$_ESC_QT_RC"
fi

# Pass controls: none of the new recognitions should over-block.
assert_eq '/bin/bash script.sh (no -c) returns empty (not -c mode)' \
  "" \
  "$(canon_unwrap_string_exec_arg '/bin/bash script.sh' 2>/dev/null || true)"

assert_eq '/bin/bash -c "git status" still extracts safely' \
  "git status" \
  "$(canon_unwrap_string_exec_arg '/bin/bash -c "git status"')"

assert_eq 'bash -ec "git status" extracts safely (combined flag + safe inner)' \
  "git status" \
  "$(canon_unwrap_string_exec_arg 'bash -ec "git status"')"

# ---------------------------------------------------------------------------
# canon_unwrap_string_exec_arg — Round-3 bypass fixes
#
# Four additional classes confirmed fail-open by the round-3 reviewer:
#  1. Leading backslash: \bash defeats basename-only strip.  Fix: also strip
#     a leading '\' from the resolved token.
#  2. timeout combined flag: -s9 was not skipped, so duration never consumed.
#     Fix: generic skip of all '-*' tokens before the duration positional.
#  3. nice combined flag: -n5 only had the two-token '-n <val>' handler.
#     Fix: generic option-skip loop that handles all '-*' forms; bare '-n'
#     still consumes the next token as its value.
#  4. git$IFS (inner token): tested via canon_has_ambiguous_git_token below.
# ---------------------------------------------------------------------------
printf '\n=== canon_unwrap_string_exec_arg — round-3 bypass fixes ===\n'

# Round-3 bypass 1: leading backslash (\bash).
assert_eq '\\bash -c "git reset --hard" extracts (backslash-prefix normalised)' \
  "git reset --hard" \
  "$(canon_unwrap_string_exec_arg '\bash -c "git reset --hard"')"

assert_eq '\\bash -c "git status" extracts safely (backslash-prefix, safe inner)' \
  "git status" \
  "$(canon_unwrap_string_exec_arg '\bash -c "git status"')"

# Round-3 bypass 2: timeout combined signal flag (-s9).
assert_eq 'timeout -s9 5 bash -c "git reset --hard" extracts (combined -s9 skipped)' \
  "git reset --hard" \
  "$(canon_unwrap_string_exec_arg 'timeout -s9 5 bash -c "git reset --hard"')"

assert_eq 'timeout --signal=9 5 bash -c "git clean -fd" extracts (long-form signal)' \
  "git clean -fd" \
  "$(canon_unwrap_string_exec_arg 'timeout --signal=9 5 bash -c "git clean -fd"')"

# timeout with no flags (existing regression — must still work).
assert_eq 'timeout 5 bash -c "git status" extracts safely (timeout, no flags)' \
  "git status" \
  "$(canon_unwrap_string_exec_arg 'timeout 5 bash -c "git status"')"

# Round-3 bypass 3: nice combined flag (-n5).
assert_eq 'nice -n5 bash -c "git reset --hard" extracts (combined -n5 skipped)' \
  "git reset --hard" \
  "$(canon_unwrap_string_exec_arg 'nice -n5 bash -c "git reset --hard"')"

assert_eq 'nice -n-5 bash -c "git clean -fd" extracts (combined -n-5 negative)' \
  "git clean -fd" \
  "$(canon_unwrap_string_exec_arg 'nice -n-5 bash -c "git clean -fd"')"

# nice -n <val> two-token form (existing regression — must still work).
assert_eq 'nice -n 5 bash -c "git clean -f" extracts safely (two-token -n val)' \
  "git clean -f" \
  "$(canon_unwrap_string_exec_arg 'nice -n 5 bash -c "git clean -f"')"

# nice with no flags (existing regression — must still work).
assert_eq 'nice bash -c "git status" extracts safely (nice, no flags)' \
  "git status" \
  "$(canon_unwrap_string_exec_arg 'nice bash -c "git status"')"

# ---------------------------------------------------------------------------
# canon_unwrap_string_exec_arg -- round-4 bypass fixes (scan-forward).
#
# Root cause: round-3 used arity-based skipping for timeout/nice.  For
# space-separated flag values (-s 9, -k 1), the non-'-' scan consumed the
# FLAG VALUE as the duration, leaving the real duration as the next token;
# the main loop saw an unrecognised token and returned 1 (not a wrapper).
#
# Fix: after the prefix word, scan ALL remaining tokens for the first token
# that normalizes to a known wrapper or prefix (arity-free).
# ---------------------------------------------------------------------------
printf '\n=== canon_unwrap_string_exec_arg -- round-4 scan-forward bypass fixes ===\n'

_R4H="--hard"
_R4FD="-fd"

# Round-4 bypass: space-separated -s VALUE (REVIEWER BLOCKING FORM).
assert_eq "timeout -s 9 5 bash -c inner extracts (space-separated -s value)" \
  "git reset $_R4H" \
  "$(canon_unwrap_string_exec_arg "timeout -s 9 5 bash -c \"git reset $_R4H\"")"

# Round-4 bypass: space-separated -k VALUE (REVIEWER BLOCKING FORM).
assert_eq "timeout -k 1 5 bash -c inner extracts (space-separated -k value)" \
  "git reset $_R4H" \
  "$(canon_unwrap_string_exec_arg "timeout -k 1 5 bash -c \"git reset $_R4H\"")"

# Multiple flags with space-separated values.
assert_eq "timeout -k 1 --preserve-status 5 bash -c inner extracts (multi-flag)" \
  "git reset $_R4H" \
  "$(canon_unwrap_string_exec_arg "timeout -k 1 --preserve-status 5 bash -c \"git reset $_R4H\"")"

# All prior round-3 forms must still work after scan-forward change.
assert_eq "timeout -s9 5 bash -c inner extracts after scan-forward (r3 regression)" \
  "git reset $_R4H" \
  "$(canon_unwrap_string_exec_arg "timeout -s9 5 bash -c \"git reset $_R4H\"")"

assert_eq "timeout 5 bash -c inner extracts after scan-forward (plain form)" \
  "git reset $_R4H" \
  "$(canon_unwrap_string_exec_arg "timeout 5 bash -c \"git reset $_R4H\"")"

# nice still works after scan-forward change.
assert_eq "nice -n 5 bash -c inner extracts after scan-forward (two-token -n)" \
  "git clean $_R4FD" \
  "$(canon_unwrap_string_exec_arg "nice -n 5 bash -c \"git clean $_R4FD\"")"

# Return 1 (not a wrapper) when no wrapper token exists in remaining tokens.
assert_eq "timeout 5 -- passes (no wrapper in remaining tokens, return empty)" \
  "" \
  "$(canon_unwrap_string_exec_arg "timeout 5 --")"

# ---------------------------------------------------------------------------
# canon_unwrap_string_exec_arg -- round-5 universal scan-forward bypass fixes.
#
# Root cause: the round-4 implementation had a fixed allowlist of recognised
# outer prefix words (command, nohup, env, timeout, nice).  Any unrecognised
# leading word hit the '*) return 1' arm — skip-pass (fail-OPEN) for forms
# like 'setsid bash -c "…"', 'stdbuf -oL bash -c "…"', 'xargs -I{} bash -c'.
#
# Fix: the '*' arm now uses universal scan-forward: advance past the unknown
# prefix token, then call _do_scan_for_wrapper to find any wrapper token in
# the remaining tokens.  This is prefix-vocabulary-free.
#
# No-over-block property: echo "bash -c '…'" — after canon_tokenize, token[0]
# is 'echo' and token[1] is the entire quoted string 'bash -c '…'' as one
# token.  The scan checks token[1]: its raw value 'bash -c …' does NOT match
# 'bash' exactly in the case, so scan finds no wrapper and returns 1.
# ---------------------------------------------------------------------------
printf '\n=== canon_unwrap_string_exec_arg -- round-5 universal scan-forward ===\n'

_R5H="--hard"
_R5FD="-fd"

# setsid prefix (should extract, rc=0).
assert_eq "setsid bash -c inner extracts (universal scan-forward)" \
  "git reset $_R5H" \
  "$(canon_unwrap_string_exec_arg "setsid bash -c \"git reset $_R5H\"")"

# stdbuf prefix with flag (should extract, rc=0).
assert_eq "stdbuf -oL bash -c inner extracts (flag-bearing unknown prefix)" \
  "git reset $_R5H" \
  "$(canon_unwrap_string_exec_arg "stdbuf -oL bash -c \"git reset $_R5H\"")"

# xargs -I{} prefix (should extract, rc=0).
assert_eq "xargs -I{} bash -c inner extracts (xargs with replacement token)" \
  "git reset $_R5H" \
  "$(canon_unwrap_string_exec_arg "xargs -I{} bash -c \"git reset $_R5H\"")"

# No-over-block: echo "bash -c '…'" — the whole quoted arg is one token, NOT matched as bash.
assert_eq "echo \"bash -c '...'\": quoted wrapper word is NOT a bare token (no-over-block)" \
  "" \
  "$(canon_unwrap_string_exec_arg "echo \"bash -c 'git reset $_R5H'\"")"

# No-over-block: printf "bash -c ..." — same property.
assert_eq "printf \"bash -c ...\": quoted wrapper word is NOT a bare token (no-over-block)" \
  "" \
  "$(canon_unwrap_string_exec_arg "printf \"bash -c 'git clean $_R5FD'\"")"

# Consciously-documented gap: command-substitution inner is not evaluated.
# The inner arg is '$(echo git reset --hard)' — a single token with '$('.
# The guard returns 0 but the inner string contains '$(' which canon_tokenize
# yields as a single non-'git' token → canon_has_git_token returns false on
# the recursion → guard passes.  This is the known deferred limitation.
# (No assert here — behavior is captured in the guard integration test.)

# Unknown prefix with no wrapper found — returns empty (rc=1).
assert_eq "setsid git status: no wrapper in tokens, scan returns empty" \
  "" \
  "$(canon_unwrap_string_exec_arg 'setsid git status')"

# ---------------------------------------------------------------------------
# canon_unwrap_string_exec_arg -- round-6: env -S / --split-string and
#   no-exec builtin short-circuit.
#
# Issue 1 (BLOCKING): env -S re-splits and executes its payload — the flag-
#   skipper must recognise -S / --split-string / bundled-S clusters and
#   return the payload for recursive evaluation (rc=0).  If payload is absent
#   → rc=2 (fail-closed).
#
# Issue 2 (WARNING regression): echo/printf with UNQUOTED args containing
#   "bash" as a separate token were over-blocked by the universal scan-forward.
#   Fix: the '*' arm now short-circuits for CANON_NO_EXEC_BUILTINS (echo,
#   printf, :, true, false) before calling _do_scan_for_wrapper.
# ---------------------------------------------------------------------------
printf '\n=== canon_unwrap_string_exec_arg -- round-6: env -S + no-exec builtins ===\n'

_R6H="--hard"
_R6FD="-fd"

# --- env -S: payload extraction (rc=0; guard recurses) ---

# env -S "bash -c 'git reset --hard'" → extracts "bash -c 'git reset --hard'"
_R6_S_PAYLOAD="bash -c 'git reset $_R6H'"
_R6_S_RC=0
_R6_S_OUT=$(canon_unwrap_string_exec_arg "env -S \"$_R6_S_PAYLOAD\"") || _R6_S_RC=$?
assert_eq "env -S PAYLOAD extracts payload (rc=0, guard recurses)" \
  "$_R6_S_PAYLOAD" \
  "$_R6_S_OUT"
if [[ "$_R6_S_RC" -eq 0 ]]; then
  PASS=$(( PASS + 1 ))
  printf '  PASS  env -S PAYLOAD → rc=0\n'
else
  FAIL=$(( FAIL + 1 ))
  ERRORS+=("FAIL: env -S PAYLOAD — expected rc=0, got rc=$_R6_S_RC")
  printf '  FAIL  env -S PAYLOAD → expected rc=0, got rc=%d\n' "$_R6_S_RC"
fi

# env --split-string="git reset --hard" → extracts "git reset --hard"
_R6_SS_RC=0
_R6_SS_OUT=$(canon_unwrap_string_exec_arg "env --split-string=\"git reset $_R6H\"") || _R6_SS_RC=$?
assert_eq "env --split-string=PAYLOAD extracts payload (rc=0)" \
  "git reset $_R6H" \
  "$_R6_SS_OUT"
if [[ "$_R6_SS_RC" -eq 0 ]]; then
  PASS=$(( PASS + 1 ))
  printf '  PASS  env --split-string=PAYLOAD → rc=0\n'
else
  FAIL=$(( FAIL + 1 ))
  ERRORS+=("FAIL: env --split-string=PAYLOAD — expected rc=0, got rc=$_R6_SS_RC")
  printf '  FAIL  env --split-string=PAYLOAD → expected rc=0, got rc=%d\n' "$_R6_SS_RC"
fi

# env -Si "git reset --hard":
# GNU env semantics: -Si means -S with inline string "i" (chars after S in cluster).
# The inline string is "i", and the remaining token "git reset --hard" is appended as argv.
# Effective command env executes: "i" "git reset --hard" (execs 'i', which doesn't exist).
# The guard extracts the FULL payload "i git reset --hard" (join-and-recurse) and recurses.
# This is the correct class fix: even though real env runs 'i' (not git reset --hard),
# the guard conservatively blocks because the joined payload contains a destructive git op.
_R6_SI_RC=0
_R6_SI_OUT=$(canon_unwrap_string_exec_arg "env -Si \"git reset $_R6H\"") || _R6_SI_RC=$?
assert_eq "env -Si PAYLOAD extracts inline payload + trailing (rc=0, join-and-recurse)" \
  "i git reset $_R6H" \
  "$_R6_SI_OUT"
if [[ "$_R6_SI_RC" -eq 0 ]]; then
  PASS=$(( PASS + 1 ))
  printf '  PASS  env -Si PAYLOAD → rc=0\n'
else
  FAIL=$(( FAIL + 1 ))
  ERRORS+=("FAIL: env -Si PAYLOAD — expected rc=0, got rc=$_R6_SI_RC")
  printf '  FAIL  env -Si PAYLOAD → expected rc=0, got rc=%d\n' "$_R6_SI_RC"
fi

# env -S "git status" → extract "git status" (rc=0; guard recurses → safe → pass)
_R6_SSTAT_RC=0
_R6_SSTAT_OUT=$(canon_unwrap_string_exec_arg "env -S \"git status\"") || _R6_SSTAT_RC=$?
assert_eq "env -S 'git status' extracts git status (rc=0; caller finds safe cmd)" \
  "git status" \
  "$_R6_SSTAT_OUT"
if [[ "$_R6_SSTAT_RC" -eq 0 ]]; then
  PASS=$(( PASS + 1 ))
  printf '  PASS  env -S git-status → rc=0\n'
else
  FAIL=$(( FAIL + 1 ))
  ERRORS+=("FAIL: env -S git-status — expected rc=0, got rc=$_R6_SSTAT_RC")
  printf '  FAIL  env -S git-status → expected rc=0, got rc=%d\n' "$_R6_SSTAT_RC"
fi

# --- No-exec builtins: short-circuit returns rc=1 (not a wrapper) ---

# echo bash -c "git reset --hard" UNQUOTED → rc=1 (echo is no-exec)
_R6_ECHO_RC=0
_R6_ECHO_OUT=$(canon_unwrap_string_exec_arg "echo bash -c \"git reset $_R6H\"") || _R6_ECHO_RC=$?
assert_eq "echo bash -c UNQUOTED returns empty (no-exec builtin, rc=1)" \
  "" \
  "$_R6_ECHO_OUT"
if [[ "$_R6_ECHO_RC" -eq 1 ]]; then
  PASS=$(( PASS + 1 ))
  printf '  PASS  echo bash -c UNQUOTED → rc=1 (no-exec)\n'
else
  FAIL=$(( FAIL + 1 ))
  ERRORS+=("FAIL: echo bash -c UNQUOTED — expected rc=1, got rc=$_R6_ECHO_RC")
  printf '  FAIL  echo bash -c UNQUOTED → expected rc=1, got rc=%d\n' "$_R6_ECHO_RC"
fi

# printf bash -c "git reset --hard" UNQUOTED → rc=1 (printf is no-exec)
_R6_PRINTF_RC=0
_R6_PRINTF_OUT=$(canon_unwrap_string_exec_arg "printf bash -c \"git reset $_R6H\"") || _R6_PRINTF_RC=$?
assert_eq "printf bash -c UNQUOTED returns empty (no-exec builtin, rc=1)" \
  "" \
  "$_R6_PRINTF_OUT"
if [[ "$_R6_PRINTF_RC" -eq 1 ]]; then
  PASS=$(( PASS + 1 ))
  printf '  PASS  printf bash -c UNQUOTED → rc=1 (no-exec)\n'
else
  FAIL=$(( FAIL + 1 ))
  ERRORS+=("FAIL: printf bash -c UNQUOTED — expected rc=1, got rc=$_R6_PRINTF_RC")
  printf '  FAIL  printf bash -c UNQUOTED → expected rc=1, got rc=%d\n' "$_R6_PRINTF_RC"
fi

# Prior no-over-block controls (echo/printf QUOTED) must still hold.
assert_eq "echo QUOTED bash arg still returns empty (rc=1, no-exec path)" \
  "" \
  "$(canon_unwrap_string_exec_arg "echo \"bash -c 'git reset $_R6H'\"" 2>/dev/null || true)"

assert_eq "printf QUOTED bash arg still returns empty (rc=1, no-exec path)" \
  "" \
  "$(canon_unwrap_string_exec_arg "printf \"bash -c 'git clean $_R6FD'\"" 2>/dev/null || true)"

# ---------------------------------------------------------------------------
# canon_unwrap_string_exec_arg -- round-8: env -S CLASS — separate-token form.
#
# The critical sub-case: when -S / --split-string / bundled-S clusters have the
# payload as a SEPARATE TOKEN (not inline), env executes payload PLUS ALL
# SUBSEQUENT OPERANDS.  "env -S bash -c 'git reset --hard'" has effective command
# "bash -c 'git reset --hard'" — the guard must join toks[payload..end] and recurse.
#
# Without this fix, the guard only saw "bash" as the payload and never saw the
# "-c 'git reset --hard'" operands → the recursion returned rc=1 (not a -c form)
# and the segment slipped through (fail-OPEN on the CORRECT code path).
# ---------------------------------------------------------------------------
printf '\n=== canon_unwrap_string_exec_arg -- round-8: env -S CLASS separate-token form ===\n'

_R8H="--hard"
_R8FD="-fd"

# env -S bash -c 'git reset --hard' → join → "bash -c git reset --hard" (rc=0)
_R8_SEP_RC=0
_R8_SEP_OUT=$(canon_unwrap_string_exec_arg "env -S bash -c 'git reset $_R8H'") || _R8_SEP_RC=$?
assert_eq "env -S bash -c PAYLOAD extracts joined command (rc=0, join-and-recurse)" \
  "bash -c git reset $_R8H" \
  "$_R8_SEP_OUT"
if [[ "$_R8_SEP_RC" -eq 0 ]]; then
  PASS=$(( PASS + 1 ))
  printf '  PASS  env -S bash -c PAYLOAD → rc=0\n'
else
  FAIL=$(( FAIL + 1 ))
  ERRORS+=("FAIL: env -S bash -c PAYLOAD — expected rc=0, got rc=$_R8_SEP_RC")
  printf '  FAIL  env -S bash -c PAYLOAD → expected rc=0, got rc=%d\n' "$_R8_SEP_RC"
fi

# env -iS bash -c 'git reset --hard' → S is last char of -iS → same join
_R8_IS_RC=0
_R8_IS_OUT=$(canon_unwrap_string_exec_arg "env -iS bash -c 'git reset $_R8H'") || _R8_IS_RC=$?
assert_eq "env -iS bash -c PAYLOAD extracts joined command (rc=0, S-last in cluster)" \
  "bash -c git reset $_R8H" \
  "$_R8_IS_OUT"
if [[ "$_R8_IS_RC" -eq 0 ]]; then
  PASS=$(( PASS + 1 ))
  printf '  PASS  env -iS bash -c PAYLOAD → rc=0\n'
else
  FAIL=$(( FAIL + 1 ))
  ERRORS+=("FAIL: env -iS bash -c PAYLOAD — expected rc=0, got rc=$_R8_IS_RC")
  printf '  FAIL  env -iS bash -c PAYLOAD → expected rc=0, got rc=%d\n' "$_R8_IS_RC"
fi

# env -i -S bash -c 'git reset --hard' → separate -i and -S flags → same join
_R8_I_S_RC=0
_R8_I_S_OUT=$(canon_unwrap_string_exec_arg "env -i -S bash -c 'git reset $_R8H'") || _R8_I_S_RC=$?
assert_eq "env -i -S bash -c PAYLOAD extracts joined command (rc=0, -i then -S separate)" \
  "bash -c git reset $_R8H" \
  "$_R8_I_S_OUT"
if [[ "$_R8_I_S_RC" -eq 0 ]]; then
  PASS=$(( PASS + 1 ))
  printf '  PASS  env -i -S bash -c PAYLOAD → rc=0\n'
else
  FAIL=$(( FAIL + 1 ))
  ERRORS+=("FAIL: env -i -S bash -c PAYLOAD — expected rc=0, got rc=$_R8_I_S_RC")
  printf '  FAIL  env -i -S bash -c PAYLOAD → expected rc=0, got rc=%d\n' "$_R8_I_S_RC"
fi

# env --split-string=bash -c 'git reset --hard' → = form + trailing operands joined
_R8_EQ_RC=0
_R8_EQ_OUT=$(canon_unwrap_string_exec_arg "env --split-string=bash -c 'git reset $_R8H'") || _R8_EQ_RC=$?
assert_eq "env --split-string=bash -c PAYLOAD extracts joined command (rc=0, = form + trailing)" \
  "bash -c git reset $_R8H" \
  "$_R8_EQ_OUT"
if [[ "$_R8_EQ_RC" -eq 0 ]]; then
  PASS=$(( PASS + 1 ))
  printf '  PASS  env --split-string=bash -c PAYLOAD → rc=0\n'
else
  FAIL=$(( FAIL + 1 ))
  ERRORS+=("FAIL: env --split-string=bash -c PAYLOAD — expected rc=0, got rc=$_R8_EQ_RC")
  printf '  FAIL  env --split-string=bash -c PAYLOAD → expected rc=0, got rc=%d\n' "$_R8_EQ_RC"
fi

# env -S "git status" still passes (single-token payload, no trailing → unchanged)
_R8_SAFE_RC=0
_R8_SAFE_OUT=$(canon_unwrap_string_exec_arg "env -S \"git status\"") || _R8_SAFE_RC=$?
assert_eq "env -S \"git status\" single-token payload still works (rc=0)" \
  "git status" \
  "$_R8_SAFE_OUT"
if [[ "$_R8_SAFE_RC" -eq 0 ]]; then
  PASS=$(( PASS + 1 ))
  printf '  PASS  env -S "git status" single-token → rc=0\n'
else
  FAIL=$(( FAIL + 1 ))
  ERRORS+=("FAIL: env -S \"git status\" single-token — expected rc=0, got rc=$_R8_SAFE_RC")
  printf '  FAIL  env -S "git status" single-token → expected rc=0, got rc=%d\n' "$_R8_SAFE_RC"
fi

# env -iS "git status" still passes (single-token payload, S-last → next token only)
_R8_IS_SAFE_RC=0
_R8_IS_SAFE_OUT=$(canon_unwrap_string_exec_arg "env -iS \"git status\"") || _R8_IS_SAFE_RC=$?
assert_eq "env -iS \"git status\" single-token payload still works (rc=0)" \
  "git status" \
  "$_R8_IS_SAFE_OUT"
if [[ "$_R8_IS_SAFE_RC" -eq 0 ]]; then
  PASS=$(( PASS + 1 ))
  printf '  PASS  env -iS "git status" single-token → rc=0\n'
else
  FAIL=$(( FAIL + 1 ))
  ERRORS+=("FAIL: env -iS \"git status\" single-token — expected rc=0, got rc=$_R8_IS_SAFE_RC")
  printf '  FAIL  env -iS "git status" single-token → expected rc=0, got rc=%d\n' "$_R8_IS_SAFE_RC"
fi

# ---------------------------------------------------------------------------
# canon_has_ambiguous_git_token — Round-3 fix for git$IFS inner bypass.
#
# When a string-executing wrapper extracts "git$IFS reset --hard" as its
# inner command, canon_has_git_token returns false (git$IFS != git), so the
# outer canon_has_git_token check misses it. canon_has_ambiguous_git_token
# detects the shell-metachar-glued form and allows process_segment to fail
# closed.
# ---------------------------------------------------------------------------
printf '\n=== canon_has_ambiguous_git_token — round-3 (git$IFS inner bypass) ===\n'

# Ambiguous forms (should return 0 = found).
assert_true 'git$IFS token detected as ambiguous' \
  canon_has_ambiguous_git_token 'git$IFS reset --hard'

assert_true 'git${IFS} token detected as ambiguous' \
  canon_has_ambiguous_git_token 'git${IFS}clean -fd'

assert_true 'git$(cmd) token detected as ambiguous (subshell expansion glued)' \
  canon_has_ambiguous_git_token 'git$(pick-cmd) reset --hard'

assert_true 'git`cmd` token detected as ambiguous (backtick subst glued)' \
  canon_has_ambiguous_git_token 'git`pick-cmd` clean -fd'

# Non-ambiguous forms (should return 1 = not found).
assert_false '"git" exact token — not ambiguous' \
  canon_has_ambiguous_git_token 'git status'

assert_false '"gitconfig" tool — not ambiguous (plain alpha suffix, no metachar)' \
  canon_has_ambiguous_git_token 'gitconfig --list'

assert_false 'echo "git worktree remove exit: $?" — not ambiguous ($? follows space, not glued)' \
  canon_has_ambiguous_git_token 'echo "git worktree remove exit: $?"'

assert_false '"git worktree remove exit: $?" as inner seg — not ambiguous' \
  canon_has_ambiguous_git_token 'git worktree remove exit: $?'

assert_false 'empty segment — not ambiguous' \
  canon_has_ambiguous_git_token ''

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
TOTAL=$(( PASS + FAIL ))
printf '\n--- Results: %d/%d passed ---\n' "$PASS" "$TOTAL"
if [[ $FAIL -gt 0 ]]; then
  printf '\nFailed tests:\n'
  for err in "${ERRORS[@]}"; do
    printf '  %s\n' "$err"
  done
  exit 1
fi
exit 0
