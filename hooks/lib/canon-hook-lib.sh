#!/usr/bin/env bash
# canon-hook-lib.sh — Shared helper functions for Canon PreToolUse/PostToolUse hooks.
#
# Source this file from hook scripts to get three reusable utilities:
#
#   canon_extract_command "$INPUT"
#     Parses the "command" field from a Claude Code hook JSON input string.
#     Prints the command on stdout. Prints nothing if the field is absent or empty.
#
#   canon_git_dir_arg "$COMMAND"
#     Inspects a compound command (e.g. "cd /path && git commit ...") for a leading
#     `cd <dir>` segment and, if that directory exists, prints "-C <dir>" on stdout.
#     Prints nothing when no cd target is found or the directory does not exist.
#     Uses POSIX [[:space:]] for macOS BSD grep compatibility (no \s).
#
#   canon_is_git_cmd "$COMMAND" "$SUBCMD"
#     Returns 0 (true) when COMMAND invokes git with the exact subcommand SUBCMD,
#     without false-positiving on filenames that contain SUBCMD (e.g. "commit" in
#     "git diff pre-commit-branch-guard.sh").
#     Handles: plain "git commit", "git -C /path commit", "cd /x && git commit".

# ---------------------------------------------------------------------------
# canon_extract_command <json>
# ---------------------------------------------------------------------------
# Extracts the value of the "command" JSON key from a Claude Code hook payload.
# Handles optional whitespace around the colon and the surrounding quotes.
# Prints the extracted value on stdout; prints nothing if not found.
#
# NOTE: This is a grep/sed fallback sufficient for the string-typed "command"
# field. For deeply nested or escaped JSON, use jq if available.
canon_extract_command() {
  local input="$1"
  if [[ -z "$input" ]]; then
    return 0
  fi
  # Try jq first (most robust), fall back to grep/sed.
  if command -v jq >/dev/null 2>&1; then
    local result
    result=$(printf '%s' "$input" | jq -r '.tool_input.command // .command // empty' 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- empty result triggers caller's pass-through guard
    printf '%s' "$result"
  else
    # grep/sed fallback: sufficient for plain string values only.
    # The [^"]* pattern cannot handle JSON escape sequences — it stops at
    # the first " even when it is preceded by a backslash (\").  When the
    # extracted value contains a backslash the parse is untrustworthy
    # (partial match before an escape sequence); return empty so the
    # caller's fail-closed branch fires rather than passing through garbage.
    local fallback_result
    fallback_result=$(printf '%s' "$input" \
      | grep -o '"command"[[:space:]]*:[[:space:]]*"[^"]*"' \
      | head -1 \
      | sed 's/.*"command"[[:space:]]*:[[:space:]]*"//;s/"$//' \
      || true)
    # If the extracted value contains a backslash, the fallback encountered
    # an escape sequence it cannot decode faithfully.  Emit empty so
    # downstream fail-closed guards block rather than evaluating garbage.
    # Use [\\] in the pattern so shellcheck does not misread the escape.
    if printf '%s' "$fallback_result" | grep -q '[\\]'; then
      return 0
    fi
    printf '%s' "$fallback_result"
  fi
}

# ---------------------------------------------------------------------------
# canon_git_dir_arg <command>
# ---------------------------------------------------------------------------
# Detects a leading "cd <dir> &&" prefix in a shell command and, when the
# extracted directory exists on disk, prints "-C <dir>" so git commands can
# be scoped to that directory.
#
# Handles:
#   "cd /some/path && git commit -m msg"   → "-C /some/path"
#   "  cd ./relative && git commit"        → "-C ./relative"  (if dir exists)
#   "git commit -m msg"                    → ""
#   "cd /nonexistent && git commit"        → ""
#
# Uses POSIX [[:space:]] throughout — macOS BSD grep does not support \s.
canon_git_dir_arg() {
  local command="$1"
  local cd_target

  # Extract the first `cd <dir>` segment that appears before a `&&` or `;`.
  # Matches optional leading whitespace, then "cd", then the directory token.
  cd_target=$(printf '%s' "$command" \
    | grep -oE '^[[:space:]]*cd[[:space:]]+[^;&|]+' \
    | sed 's/^[[:space:]]*cd[[:space:]]*//' \
    | sed 's/[[:space:]]*$//' \
    || true) # DOCUMENTED FAIL-OPEN -- no cd prefix in command is the normal case

  if [[ -n "$cd_target" ]] && [[ -d "$cd_target" ]]; then
    printf '%s' "-C $cd_target"
  fi
}

# ---------------------------------------------------------------------------
# canon_is_git_cmd <command> <subcmd>
# ---------------------------------------------------------------------------
# Returns 0 when COMMAND is a git invocation of subcommand SUBCMD as a
# standalone word — not as part of a filename argument.
#
# Match logic:
#   Strip a leading "cd <dir> &&" prefix (compound commands).
#   Then check: git [flags] <subcmd>
#   where <subcmd> is bounded on both sides so "commit" does NOT match
#   "pre-commit-branch-guard.sh" in argument position.
#
# Examples (SUBCMD = "commit"):
#   "git commit -m msg"                          → 0 (true)
#   "git -C /path commit -m msg"                 → 0 (true)
#   "cd /x && git commit -m msg"                 → 0 (true)
#   "git diff pre-commit-branch-guard.sh"        → 1 (false)
#   "git log --oneline"                          → 1 (false, SUBCMD="commit")
#   "git commit" (bare)                          → 0 (true)
#
# Uses [[:space:]] and [[:alnum:]] throughout for POSIX/BSD compatibility.
canon_is_git_cmd() {
  local command="$1"
  local subcmd="$2"
  local stripped

  # Strip a leading "cd <dir> &&" prefix so compound commands are handled.
  stripped=$(printf '%s' "$command" \
    | sed 's/^[[:space:]]*cd[[:space:]]*[^;&|]*&&[[:space:]]*//' \
    || true) # DOCUMENTED FAIL-OPEN -- sed no-match means no cd prefix to strip
  # If sed produced nothing (no match), keep the original.
  if [[ -z "$stripped" ]]; then
    stripped="$command"
  fi

  # Match: git (optional flag tokens) <subcmd> (followed by whitespace or end)
  #
  # Strategy: extract the words between "git" and the subcommand boundary.
  # The subcommand is the FIRST word after "git" that does not begin with "-"
  # and is not a path argument to a preceding "-" flag.
  #
  # We handle this with a word-by-word loop:
  #   1. Strip "git" from the front of the command.
  #   2. Walk tokens: skip "-flag" words and their value arguments (non-"-" word).
  #   3. The first non-flag, non-argument word must equal the subcommand.
  local after_git
  after_git=$(printf '%s' "$stripped" \
    | sed -E 's/(^|[[:space:]])git[[:space:]]+//' \
    || true) # DOCUMENTED FAIL-OPEN -- sed no-match means "git" keyword not found

  local remaining="$after_git"
  local expect_value=0

  while true; do
    # Get first word
    local first
    first=$(printf '%s' "$remaining" | awk '{print $1}')
    if [[ -z "$first" ]]; then
      # No more tokens — subcommand not found
      return 1
    fi

    if [[ "$expect_value" -eq 1 ]]; then
      # This token is the value argument for the previous "-flag", skip it
      expect_value=0
      remaining=$(printf '%s' "$remaining" | sed -E 's/^[[:space:]]*[^[:space:]]+[[:space:]]*//' || true) # DOCUMENTED FAIL-OPEN -- advancing past token in word-by-word parser
      continue
    fi

    if [[ "$first" == -* ]]; then
      # Flag token — skip it; the next token is its value argument
      expect_value=1
      remaining=$(printf '%s' "$remaining" | sed -E 's/^[[:space:]]*[^[:space:]]+[[:space:]]*//' || true) # DOCUMENTED FAIL-OPEN -- advancing past token in word-by-word parser
      continue
    fi

    # First non-flag word — this must be the subcommand
    [[ "$first" == "$subcmd" ]]
    return $?
  done
}

# ---------------------------------------------------------------------------
# canon_git_subcommand <command_segment>
# ---------------------------------------------------------------------------
# Resolves the REAL git subcommand of a single command segment, accounting
# for git's global options. Prints the subcommand token on stdout.
# Returns 0 if a git invocation with a resolvable subcommand was found;
# returns 1 (printing nothing) otherwise.
#
# This is the git-global-option-aware corrected version of the token-walk in
# canon_is_git_cmd: instead of assuming EVERY -flag consumes the next token
# (which fails-OPEN when a self-contained global like -p / --no-pager / a
# `=`-form precedes the subcommand), it classifies each global option:
#
#   VALUE-CONSUMING (skip the flag AND the next token), ONLY as a separate
#   token (no '=' in the token):
#     -C  -c  --git-dir  --work-tree  --namespace  --exec-path  --super-prefix
#
#   SELF-CONTAINED (skip the flag only):
#     -p  -P  --paginate  --no-pager  --bare  --no-replace-objects
#     --literal-pathspecs  --icase-pathspecs  --no-optional-locks
#     --no-lazy-fetch, and ANY token containing '=' (e.g. --git-dir=/x, -c k=v)
#
#   UNKNOWN -flag → treated as SELF-CONTAINED (skip only). Consuming the next
#   token for an unknown flag risks skipping the real subcommand → fail-OPEN;
#   for a fail-closed safety hook we never consume an unknown flag's "value".
#
# The FIRST bare (non-'-'-prefixed) token after the global options is the
# subcommand. Strips a leading "cd <dir> &&" prefix like canon_is_git_cmd.
# Uses [[:space:]] throughout for POSIX/BSD (macOS) compatibility.
#
# Bug-1 fix (command-prefix wrappers): locates the first standalone "git"
# token via awk and processes only the tokens AFTER it. A blind word-
# substitution (sed s/…git…//) only removes the "git" word, leaving any
# wrapper prefix (sudo, env, time, nice, command) fused to the next token,
# which then mis-resolves as the subcommand → fail-OPEN.  Anchoring to the
# actual "git" token (not a substring match) is required for correctness.
#
# Bug-2 fix (quoted option values with spaces): accepts the raw (pre-quote-
# deletion) segment so that quoted multi-word values for value-consuming
# globals (e.g. -C "my dir") are treated as ONE token.  A quote-aware awk
# tokenizer splits on unquoted whitespace only — quoted spans are preserved
# as a single token.  Quote characters are stripped from the resolved
# subcommand token to maintain compatibility with Bypass-3 intra-token
# quote handling (git "clean" → subcommand clean).
canon_git_subcommand() {
  local command="$1"
  local stripped

  # Strip a leading "cd <dir> &&" prefix so compound segments are handled.
  stripped=$(printf '%s' "$command" \
    | sed 's/^[[:space:]]*cd[[:space:]]*[^;&|]*&&[[:space:]]*//' \
    || true) # DOCUMENTED FAIL-OPEN -- sed no-match means no cd prefix to strip
  if [[ -z "$stripped" ]]; then
    stripped="$command"
  fi

  # Verify a standalone "git" token exists before further processing.
  if ! printf '%s' "$stripped" | grep -qE '(^|[[:space:]])git([[:space:]]|$)'; then
    return 1
  fi

  # Use a quote-aware awk tokenizer to split the segment into tokens, then
  # locate the first standalone "git" token and walk the tokens after it.
  #
  # Tokenizer rules (mimicking bash quote-removal + word-splitting):
  #   - Single- and double-quoted spans group: whitespace inside quotes does
  #     NOT split a token.  Quote chars themselves are REMOVED from the token.
  #   - Unquoted whitespace separates tokens (runs collapse to one boundary).
  #   - The output is one token per line so the shell loop can consume it.
  #
  # Token walk after "git":
  #   1. Skip tokens before "git" (prefix wrappers like sudo/env/time/nice).
  #   2. After locating "git", apply the global-option classifier:
  #        value-consuming globals (-C -c --git-dir …): consume this token
  #          AND skip the NEXT token as the option value.
  #        =-form or self-contained: skip this token only.
  #        UNKNOWN -flag: skip only (fail-closed: never consume next token).
  #   3. First bare non-'-' token after the globals is the subcommand; print it.
  #   4. If "git" is found but the subcommand cannot be resolved, print nothing
  #      and exit non-zero (caller's parse-ambiguity guard fires → block).
  local tokens_output
  tokens_output=$(printf '%s' "$stripped" | awk '
  {
    line = $0
    n = 0
    tokens[n] = ""
    in_tok = 0
    for (i = 1; i <= length(line); i++) {
      c = substr(line, i, 1)
      if (in_dq) {
        if (c == "\"") { in_dq = 0 }
        # else: append c (not the quote) to current token
        else { tokens[n] = tokens[n] c }
        continue
      }
      if (in_sq) {
        if (c == "'"'"'") { in_sq = 0 }
        else { tokens[n] = tokens[n] c }
        continue
      }
      if (c == "\"") { in_dq = 1; in_tok = 1; continue }
      if (c == "'"'"'") { in_sq = 1; in_tok = 1; continue }
      if (c == " " || c == "\t") {
        if (in_tok) {
          n++
          tokens[n] = ""
          in_tok = 0
        }
        continue
      }
      tokens[n] = tokens[n] c
      in_tok = 1
    }
    # Emit one token per line (skip trailing empty token from trailing space)
    for (j = 0; j <= n; j++) {
      if (tokens[j] != "" || j < n) print tokens[j]
    }
  }
  ' || true) # DOCUMENTED FAIL-OPEN -- empty output triggers "git not found" return below

  # Load tokens into an array, one per line.
  local -a tok_arr
  local tok_count=0
  while IFS= read -r t; do
    tok_arr[tok_count]="$t"
    tok_count=$(( tok_count + 1 ))
  done <<< "$tokens_output"

  # Locate the first standalone "git" token.
  local git_idx=-1
  local i
  for (( i=0; i<tok_count; i++ )); do
    if [[ "${tok_arr[$i]}" == "git" ]]; then
      git_idx=$i
      break
    fi
  done

  if [[ $git_idx -lt 0 ]]; then
    # No standalone "git" token found.
    return 1
  fi

  # Walk tokens after "git" applying the global-option classifier.
  local expect_value=0
  for (( i=git_idx+1; i<tok_count; i++ )); do
    local tok="${tok_arr[$i]}"

    if [[ "$expect_value" -eq 1 ]]; then
      # This token is the value for a value-consuming global; skip it.
      expect_value=0
      continue
    fi

    if [[ "$tok" == -* ]]; then
      # A '-'-prefixed global option.
      if [[ "$tok" == *=* ]]; then
        # =-form (e.g. --git-dir=/x, -c k=v): self-contained.
        : # skip flag only
      else
        case "$tok" in
          -C|-c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix)
            # Value-consuming global: skip this flag and the next token.
            expect_value=1
            ;;
          *)
            # Self-contained global (-p, --no-pager, …) OR an unknown -flag.
            # Skip ONLY this flag — never consume the next token.
            : # skip flag only
            ;;
        esac
      fi
      continue
    fi

    # First bare (non-'-') token — this is the subcommand.
    # Strip any residual quote chars (safety: tokenizer should have removed
    # them already, but intra-token quotes like cl""ean → clean need this).
    local sub
    sub=$(printf '%s' "$tok" | tr -d '"'"'"'')
    if [[ -n "$sub" ]]; then
      # Fail-closed: if the resolved "subcommand" is itself the word "git",
      # the tokenizer latched onto a spurious bare "git" value/positional
      # that appeared before the real git invocation (e.g. "env git git
      # reset --hard", "sudo -u git git clean -fd", "git git reset --hard").
      # "git" is never a valid git subcommand; returning 1 here causes the
      # parse-ambiguity guard in destructive-guard.sh to fire → exit 2.
      if [[ "$sub" == "git" ]]; then
        return 1
      fi
      printf '%s' "$sub"
      return 0
    fi
    # Empty after quote-strip → not a valid subcommand; continue walking.
  done

  # Ran out of tokens without finding a subcommand → unresolved.
  return 1
}
