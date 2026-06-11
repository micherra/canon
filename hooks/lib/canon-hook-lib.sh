#!/usr/bin/env bash
# canon-hook-lib.sh — Shared helper functions for Canon PreToolUse/PostToolUse hooks.
#
# Source this file from hook scripts to get the following utilities:
#
#   canon_extract_command "$INPUT"
#     Parses the "command" field from a Claude Code hook JSON input string.
#     Prints the command on stdout. Prints nothing if the field is absent or empty.
#
#   canon_strip_comments "$COMMAND"
#     Single awk char-walk over a possibly-multiline command string. Drops comment
#     text (from a word-start # to end-of-line) while preserving quote state across
#     newlines. Always emits the newline itself so line alignment is preserved.
#     # mid-word (foo#bar, $#, ${#x}) is NOT treated as a comment. # inside
#     single/double quotes is NOT treated as a comment.
#
#   canon_tokenize "$SEGMENT"
#     Quote-aware awk tokenizer: splits on unquoted whitespace; quoted spans group
#     into one token with quote chars removed. Prints one token per line.
#
#   canon_has_git_token "$SEGMENT"
#     Tokenizes via canon_tokenize; returns 0 iff some token equals exactly "git".
#     This is the authoritative replacement for the per-segment grep prefilter.
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
# canon_strip_comments <command>
# ---------------------------------------------------------------------------
# Single awk char-walk over a possibly-multiline command string. Strips shell
# comment text while preserving quote state across newlines. Rules:
#
#   - Single-quoted (') and double-quoted (") spans preserve their content,
#     including # characters. Quote state persists across newlines.
#   - Inside a comment (from a word-start # to end-of-line), quote characters
#     do NOT toggle quote state (handles apostrophes in prose comments like
#     "workspace's") — only non-comment bytes toggle quote state.
#   - A '#' at word start (at line start or after unquoted space/tab) when not
#     inside quotes enters comment mode for the rest of that line.
#   - '#' mid-word (foo#bar, $#, ${#x}) is NOT treated as a comment.
#   - Comment text (from # to end of line, exclusive) is dropped. The newline
#     itself is ALWAYS emitted to preserve line alignment.
#   - All non-comment bytes (including quote chars) pass through unchanged.
#
# Reads stdin; prints the stripped command on stdout.
canon_strip_comments() {
  awk '
  BEGIN {
    in_sq = 0
    in_dq = 0
  }
  {
    line = $0
    len = length(line)
    in_comment = 0
    at_word_start = 1  # true at beginning of each line

    for (i = 1; i <= len; i++) {
      c = substr(line, i, 1)

      if (in_comment) {
        # Inside a comment: drop all chars until end of line.
        # Quote chars do NOT toggle quote state here (apostrophes in prose).
        continue
      }

      if (in_sq) {
        if (c == "'"'"'") { in_sq = 0 }
        printf "%s", c
        at_word_start = 0
        continue
      }

      if (in_dq) {
        if (c == "\"") { in_dq = 0 }
        printf "%s", c
        at_word_start = 0
        continue
      }

      # Not in any quoted span and not in a comment.
      if (c == "'"'"'") {
        in_sq = 1
        printf "%s", c
        at_word_start = 0
        continue
      }
      if (c == "\"") {
        in_dq = 1
        printf "%s", c
        at_word_start = 0
        continue
      }

      if (c == "#") {
        if (at_word_start) {
          # Comment start: drop the # and everything until end of line.
          in_comment = 1
          continue
        }
        # mid-word # — emit verbatim
        printf "%s", c
        at_word_start = 0
        continue
      }

      if (c == " " || c == "\t") {
        printf "%s", c
        at_word_start = 1
        continue
      }

      printf "%s", c
      at_word_start = 0
    }
    # Always emit the newline to preserve line count.
    printf "\n"
    # in_sq and in_dq persist across newlines (multiline quoted strings).
    # in_comment resets at the newline (comments run to end of line only).
  }
  '
}

# ---------------------------------------------------------------------------
# canon_tokenize <segment>
# ---------------------------------------------------------------------------
# Quote-aware awk tokenizer: splits on unquoted whitespace; single- and
# double-quoted spans group into one token with quote chars removed. Prints
# one token per line on stdout. Empty input produces no output.
#
# This is the same tokenizer logic formerly inlined in canon_git_subcommand,
# extracted as a named helper per source-shared-hook-helpers.
canon_tokenize() {
  local segment="$1"
  printf '%s' "$segment" | awk '
  {
    line = $0
    n = 0
    tokens[n] = ""
    in_tok = 0
    for (i = 1; i <= length(line); i++) {
      c = substr(line, i, 1)
      if (in_dq) {
        if (c == "\"") { in_dq = 0 }
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
    for (j = 0; j <= n; j++) {
      if (tokens[j] != "" || j < n) print tokens[j]
    }
  }
  ' || true # DOCUMENTED FAIL-OPEN -- empty output when segment is empty; caller handles missing tokens
}

# ---------------------------------------------------------------------------
# canon_has_git_token <raw_segment>
# ---------------------------------------------------------------------------
# Tokenizes via canon_tokenize; returns 0 iff some token equals exactly "git".
# Returns 1 otherwise.
#
# This is the quote-aware authoritative replacement for the guard's per-segment
# grep prefilter. Examples:
#   "git status"          → 0 (has standalone git token)
#   'echo "git x"'        → 1 (git is inside double quotes, tokenized as part
#                               of the quoted string, not a standalone token)
#   '"git" status'        → 0 (quoted git: quote chars stripped, token = git)
#   "sudo git status"     → 0 (prefix wrapper, standalone git token present)
#   "forgit status"       → 1 (forgit is one token, not git)
canon_has_git_token() {
  local segment="$1"
  local found=1
  while IFS= read -r tok; do
    if [[ "$tok" == "git" ]]; then
      found=0
      break
    fi
  done < <(canon_tokenize "$segment")
  return $found
}

# ---------------------------------------------------------------------------
# canon_has_ambiguous_git_token <segment>
# ---------------------------------------------------------------------------
# Returns 0 when the segment contains a WORD-BOUNDARY token that STARTS WITH
# "git" followed immediately by a shell metacharacter (no space between).
# Examples that match: git$IFS, git${X}, git$(cmd), git`cmd`, git\`...\`
# Examples that do NOT match: "git" (exact), "gitconfig" (plain alpha suffix),
#   the quoted string "git worktree remove exit: $?" (tokenized as one long
#   token — the $ is not adjacent to git at the word boundary).
# Returns 1 otherwise.
#
# Purpose: inside a recursed inner command (already unwrapped from a string-
# executing wrapper), a token like "git$IFS" means the shell expansion is
# glued directly to "git" — the runtime value is unknown, so the guard cannot
# safely evaluate whether "git$IFS" resolves to the git command.  Failing
# closed on this pattern prevents the bypass where a deliberate IFS/expansion
# trick defeats canon_has_git_token's exact-match check.
#
# Critical: the token MUST be a short, word-boundary form — specifically the
# FIRST 3 characters must be "git" and the 4th character (if any) must be a
# shell metachar ('$', '`', '{', '(', '\').  This rejects quoted strings like
# "git worktree remove exit: $?" which tokenize into one long token starting
# with "git " (with a space at position 4, not a metachar).
#
# Uses POSIX-safe constructs for bash 3.2 / macOS BSD compat.
canon_has_ambiguous_git_token() {
  local segment="$1"
  local found=1
  local tok
  while IFS= read -r tok; do
    # Must start with "git" but not be exactly "git".
    case "$tok" in
      git) ;;  # exact match — not ambiguous
      git*)
        # Extract the character immediately following "git" (4th char).
        # If it is a shell expansion/quoting metachar, this token is ambiguous.
        # This check intentionally rejects plain-alpha suffixes (gitconfig, etc.)
        # and space-separated continuations (quoted strings starting with "git ").
        local suffix4
        suffix4=$(printf '%s' "$tok" | cut -c4)
        # Match shell-expansion metacharacters immediately following "git":
        #   $  — variable expansion (git$IFS, git$VAR)
        #   `  — command substitution (git`cmd`)
        #   {  — brace expansion / parameter expansion (git${IFS})
        #   (  — subshell/arithmetic expansion (git$(cmd))
        # Note: backslash is intentionally omitted — git\ is not a known
        # bypass pattern and its addition triggers SC1003 in case patterns.
        case "$suffix4" in
          '$'|'`'|'{'|'(')
            found=0
            break
            ;;
        esac
        ;;
    esac
  done < <(canon_tokenize "$segment")
  return $found
}

# ---------------------------------------------------------------------------
# canon_unwrap_string_exec_arg <raw_segment>
# ---------------------------------------------------------------------------
# String-executing-wrapper detector.  Classifies a segment into one of three
# outcomes and signals each with a distinct return code:
#
#   (a) NOT a string-executing wrapper at all (echo, printf, git, etc.)
#       → return 1, prints nothing.
#       Caller treats this segment as a normal command (skip if no git token).
#
#   (b) Recognised string-executing wrapper; inner command cleanly extracted.
#       → return 0, prints the inner command on stdout.
#       Caller recurses into the inner command.
#
#   (c) Recognised string-executing wrapper but inner arg unparseable/empty.
#       → return 2, prints nothing.
#       Caller must fail CLOSED (exit 2) — never skip-pass a recognised shell
#       wrapper whose inner command cannot be safely evaluated.
#
# This three-way distinction is the CRITICAL fix: the previous implementation
# collapsed (a) and (c) into the same return code (1 / empty stdout), causing
# the guard to treat an unresolvable /bin/bash -c "..." as "not a wrapper"
# and skip it (fail-OPEN).
#
# Wrapper forms recognised (via basename matching):
#
#   SHELL_WRAPPERS (take a string argument after -c):
#     bash, sh, zsh, ksh — and their path-qualified forms (/bin/bash, etc.)
#   EVAL_WRAPPER:
#     eval  (all remaining tokens form the command)
#
# Universal scan-forward (prefix-vocabulary-free):
#   Any token preceding the wrapper that is not itself a recognised wrapper
#   or transparent prefix is treated as an unknown outer prefix.  The
#   implementation scans forward past it to find the first wrapper token,
#   regardless of what the outer command is.  This covers arbitrary prefixes
#   such as setsid, stdbuf, xargs, sudo, and any future command.
#   Known transparent prefixes (handled with their own flag-skipping logic):
#     command  — skips -p, -v, -V, --
#     nohup    — self-contained, no flags consumed
#     env      — skips -i, -u NAME, -0, NAME=VALUE assignments, --
#                ALSO: env -S / --split-string / bundled-S clusters re-split
#                and execute the payload string (GNU env); the payload is
#                extracted and returned as an inner command (rc=0 / outcome b).
#                Absent payload → fail-closed (rc=2 / outcome c).
#     timeout  — scan-forward after prefix (arity-free)
#     nice     — scan-forward after prefix (arity-free)
#
#   No-exec builtins (short-circuit, outcome a):
#     echo, printf, :, true, false — never execute their arguments; the
#     '*' scan-forward arm short-circuits immediately for these tokens so that
#     'echo bash -c "..."' (unquoted) does not false-block via scan-forward.
#
# Known limitation (consciously deferred):
#   bash -c "$(echo git reset --hard)" — the inner argument is a command
#   substitution, not a literal string.  Static analysis cannot evaluate
#   $(…) or `…` at hook time, so this form passes (exit 0).  This is
#   deliberately exotic (requires attacker-controlled shell expansion) and
#   is not worth the complexity of attempted static evaluation.
#
# Combined short-flag clusters for shell wrappers are handled:
#   bash -ec "cmd"  — 'c' as last char of cluster → treated as -c
#   bash -lc "cmd"  — same
#   sh -xc "cmd"    — same
#   bash -cX "cmd"  — 'c' not last char → fail-closed (ambiguous position)
#
# Path-qualified wrappers are handled via basename matching:
#   /bin/bash -c "..."      → recognised as bash
#   /usr/bin/sh -c "..."    → recognised as sh
#   /usr/bin/env bash -c "..." → env prefix + bash wrapper
#
# Escaped inner quotes: since canon_tokenize strips surrounding quotes,
# 'bash -c "git reset \"--hard\""' yields the inner token 'git reset "--hard"'
# (the backslash-escaped quotes become literal chars in the extracted token).
# This is still a non-empty string — the guard recurses into it successfully.
# If the inner token ends up empty (e.g., bash -c ""), outcome (c) fires.
#
# Uses canon_tokenize for quote-aware tokenisation so that the string argument
# is returned with quote characters removed (the same representation the shell
# would use after one level of quote-removal).
#
# NOTE: Written for bash 3.2 compatibility (macOS default shell).
# No namerefs (local -n) are used; all helpers are inlined.

canon_unwrap_string_exec_arg() {
  local segment="$1"

  # Tokenize the segment (quote-aware; quoted spans stripped).
  local -a toks
  local tok_count=0
  local _t
  while IFS= read -r _t; do
    toks[tok_count]="$_t"
    tok_count=$(( tok_count + 1 ))
  done < <(canon_tokenize "$segment")

  if [[ $tok_count -eq 0 ]]; then
    return 1
  fi

  # ---------------------------------------------------------------------------
  # Inner helper: _do_shell_c_extract
  # Walk from current $idx searching for -c.
  # Sets $idx as a side-effect (uses the outer function's local $idx).
  # Returns:
  #   0  — extracted; inner command printed on stdout
  #   1  — not a -c invocation (script-file mode, -- without -c, etc.)
  #   2  — recognised -c form but argument is empty → fail-closed
  # ---------------------------------------------------------------------------
  _do_shell_c_extract() {
    while [[ $idx -lt $tok_count ]]; do
      local flag="${toks[$idx]}"
      case "$flag" in
        -c)
          # Standalone -c: the very next token is the command string.
          local _ci=$(( idx + 1 ))
          if [[ $_ci -lt $tok_count ]]; then
            local _inner="${toks[$_ci]}"
            if [[ -n "$_inner" ]]; then
              # Backslash check: the canon_tokenize awk tokenizer does not handle
              # backslash escape sequences inside double-quoted spans.  When the
              # raw argument contains escaped inner quotes (e.g., "git reset
              # \"--hard\""), the tokenizer leaves behind literal backslashes in
              # the extracted token (yielding "git reset \--hard\").  The resulting
              # inner command cannot be safely evaluated by the guard.  Failing
              # closed is safer than attempting to interpret the garbled form.
              # Use [\\] in the pattern to satisfy shellcheck without misreading.
              if printf '%s' "$_inner" | grep -q '[\\]'; then
                return 2 # escaped-quote artifact → fail-closed
              fi
              printf '%s' "$_inner"
              return 0
            else
              return 2 # -c with empty string argument → fail-closed
            fi
          else
            return 2 # -c with no argument at all → fail-closed
          fi
          ;;
        --)
          # End of options; no -c seen → not a -c invocation.
          return 1
          ;;
        -*)
          # Flag cluster like -ec, -lc, -xc, -login, -e, -x, etc.
          # Strip the leading '-' to get the cluster body.
          local _cluster="${flag#-}"
          # Determine the position of 'c' in the cluster.
          # If 'c' is the LAST character, treat as -c with the next token.
          local _last="${_cluster: -1}"
          if [[ "$_last" == "c" ]]; then
            local _ci=$(( idx + 1 ))
            if [[ $_ci -lt $tok_count ]]; then
              local _inner="${toks[$_ci]}"
              if [[ -n "$_inner" ]]; then
                # Same backslash-artifact check as standalone -c above.
                if printf '%s' "$_inner" | grep -q '[\\]'; then
                  return 2
                fi
                printf '%s' "$_inner"
                return 0
              else
                return 2
              fi
            else
              return 2 # combined -c with no argument
            fi
          elif [[ "$_cluster" == *c* ]]; then
            # 'c' appears mid-cluster (e.g., -cX) — argument position is
            # ambiguous.  Fail closed: recognised shell wrapper, cannot parse.
            return 2
          else
            # No 'c' in this flag cluster — self-contained option, advance.
            idx=$(( idx + 1 ))
          fi
          ;;
        *)
          # Bare non-'-' token: this is a script file path, not -c mode.
          return 1
          ;;
      esac
    done
    # Ran out of tokens without finding -c — script-file mode or bare shell.
    return 1
  }

  # ---------------------------------------------------------------------------
  # Inner helper: _do_skip_env_flags
  # Advances $idx past flags and assignments owned by 'env':
  #   -i, -0, -v (self-contained)
  #   -u NAME     (-u consumes one following token)
  #   -uNAME      (combined form, self-contained)
  #   NAME=VALUE  (assignment, skip)
  #   --          (end of options; advance once then stop)
  #   -S / --split-string (separate-token forms) / --split-string=PAYLOAD (= form)
  #   / bundled-S clusters (-iS, -Si, etc.)
  #     env re-splits and executes the payload just like a shell -c argument,
  #     AND appends all subsequent operands to argv.  Sets _env_split_payload to
  #     the JOIN of toks[payload_start .. end] and returns 2 (string-executor).
  #     Returns 2 with empty _env_split_payload if payload is absent (fail-closed).
  # Stops at the first bare word that is not an assignment (the command).
  # ---------------------------------------------------------------------------
  _env_split_payload=""
  _do_skip_env_flags() {
    while [[ $idx -lt $tok_count ]]; do
      local _t="${toks[$idx]}"
      case "$_t" in
        --)
          idx=$(( idx + 1 )) # consume '--', stop
          return 0
          ;;
        -u)
          idx=$(( idx + 1 )) # consume '-u'
          [[ $idx -lt $tok_count ]] && idx=$(( idx + 1 )) # consume NAME
          ;;
        -i|-0|-v)
          idx=$(( idx + 1 )) # self-contained flag
          ;;
        # ---------------------------------------------------------------------------
        # GNU env -S / --split-string: re-splits and EXECUTES the payload string.
        # Treat the payload as an inner command string, like -c for shell wrappers.
        # All of these forms set _env_split_payload and return 2 (string-executor).
        #   -S PAYLOAD           — separate next token is the payload
        #   --split-string=...   — = form; payload is the suffix after =
        #   --split-string PAYLOAD — separate next token form
        #   -iS / similar        — cluster with S as last char; next token is payload
        #   -Si                  — S has inline suffix 'i'; payload = "i" only
        #                          (real env execs 'i'; NOT destructive — do not block)
        #
        # CRITICAL: env executes the payload PLUS all subsequent operands, appended
        # to argv.  So "env -S bash -c 'git reset --hard'" executes "bash" with
        # additional argv "-c" and "git reset --hard" → effectively "bash -c 'git
        # reset --hard'".  The guard must reconstruct the effective command as the
        # JOIN of toks[payload_idx .. end] so the recursion path sees the full argv.
        # ---------------------------------------------------------------------------
        --split-string=*)
          # = form: payload is the value after =, PLUS all remaining tokens joined.
          # "env --split-string=bash -c 'git reset --hard'" → "bash -c git reset --hard"
          local _eqpay="${_t#--split-string=}"
          local _ji=$(( idx + 1 ))
          while [[ $_ji -lt $tok_count ]]; do
            _eqpay="$_eqpay ${toks[$_ji]}"
            _ji=$(( _ji + 1 ))
          done
          _env_split_payload="$_eqpay"
          return 2
          ;;
        --split-string|-S)
          # Separate-token form: effective command = toks[payload_idx .. end] joined.
          # "env -S bash -c 'git reset --hard'" → payload_idx=next → "bash -c git reset --hard"
          local _si=$(( idx + 1 ))
          if [[ $_si -lt $tok_count ]]; then
            local _joined="${toks[$_si]}"
            local _ji=$(( _si + 1 ))
            while [[ $_ji -lt $tok_count ]]; do
              _joined="$_joined ${toks[$_ji]}"
              _ji=$(( _ji + 1 ))
            done
            _env_split_payload="$_joined"
          fi
          # _env_split_payload may be empty if no next token — caller fails-closed
          return 2
          ;;
        -*)
          # Check for a bundled short-flag cluster containing 'S' (e.g. -iS, -Si, -xiS).
          # Strip the leading '-' and check if 'S' is in the cluster body.
          local _cluster="${_t#-}"
          # Only applies to pure-short-flag clusters (no '=' and no '--' prefix).
          if [[ "$_cluster" != *=* ]] && [[ "$_cluster" == *S* ]]; then
            # Determine whether S is the LAST char of the cluster or not:
            #   S last  (-iS, -xiS) → next token is the payload for -S; remaining
            #                         tokens are appended as argv (join-and-recurse).
            #   S not last (-Si, -Sba) → the chars AFTER S in the cluster are the
            #                         INLINE payload string (real env semantics:
            #                         "env -Si bash" execs 'i', not 'bash').
            #                         The inline form is typically a short string that
            #                         does NOT execute a destructive git command, but
            #                         we still extract it and recurse (fail-closed if
            #                         somehow destructive).
            local _slast="${_cluster: -1}"
            if [[ "$_slast" == "S" ]]; then
              # S is the last char: next token is the payload, remaining tokens appended.
              local _si=$(( idx + 1 ))
              if [[ $_si -lt $tok_count ]]; then
                local _joined="${toks[$_si]}"
                local _ji=$(( _si + 1 ))
                while [[ $_ji -lt $tok_count ]]; do
                  _joined="$_joined ${toks[$_ji]}"
                  _ji=$(( _ji + 1 ))
                done
                _env_split_payload="$_joined"
              fi
              # _env_split_payload may be empty if no next token — caller fails-closed
            else
              # S is NOT the last char: the chars after S are the inline payload.
              # Extract the substring of the cluster that follows 'S'.
              # Iterate the cluster character-by-character to find the first S
              # and take everything after it as the inline string.
              local _inline_pay=""
              local _found_s=0
              local _ci _cc
              for (( _ci=0; _ci<${#_cluster}; _ci++ )); do
                _cc="${_cluster:$_ci:1}"
                if [[ "$_found_s" -eq 1 ]]; then
                  _inline_pay="${_inline_pay}${_cc}"
                elif [[ "$_cc" == "S" ]]; then
                  _found_s=1
                fi
              done
              # The inline payload is the extracted substring (may be empty → fail-closed).
              # Additionally, any tokens after this cluster token are appended to argv.
              local _ji=$(( idx + 1 ))
              while [[ $_ji -lt $tok_count ]]; do
                if [[ -n "$_inline_pay" ]]; then
                  _inline_pay="$_inline_pay ${toks[$_ji]}"
                else
                  _inline_pay="${toks[$_ji]}"
                fi
                _ji=$(( _ji + 1 ))
              done
              _env_split_payload="$_inline_pay"
            fi
            return 2
          fi
          # Unknown env flag without S — treat as self-contained (conservative).
          idx=$(( idx + 1 ))
          ;;
        *=*)
          # NAME=VALUE assignment
          idx=$(( idx + 1 ))
          ;;
        *)
          # Bare word: this is the command token.
          return 0
          ;;
      esac
    done
  }

  # ---------------------------------------------------------------------------
  # Inner helper: _do_skip_command_flags
  # Advances $idx past flags owned by the 'command' builtin:
  #   -p, -v, -V  (self-contained)
  #   --          (end of options; advance once then stop)
  # Stops conservatively on any unknown flag so it doesn't skip the command.
  # ---------------------------------------------------------------------------
  _do_skip_command_flags() {
    while [[ $idx -lt $tok_count ]]; do
      local _t="${toks[$idx]}"
      case "$_t" in
        --)
          idx=$(( idx + 1 ))
          return 0
          ;;
        -p|-v|-V)
          idx=$(( idx + 1 ))
          ;;
        -*)
          # Unknown flag: stop conservatively.
          return 0
          ;;
        *)
          return 0
          ;;
      esac
    done
  }

  # ---------------------------------------------------------------------------
  # Inner helper: _do_scan_for_wrapper
  # Scans tokens from current $idx forward (left-to-right) for the FIRST
  # token that normalizes (basename + backslash-strip) to a known
  # string-executing wrapper (bash/sh/zsh/ksh/eval) or a recognized
  # transparent prefix (command/nohup/env/timeout/nice).
  #
  # If found: sets $idx to that token's position and returns 0.
  # If not found (no wrapper or prefix among remaining tokens): returns 1.
  #
  # Arity-free: ignores how many flags (-s/-k/--signal/--kill-after for
  # timeout; -n for nice) or positional values (durations, priority numbers)
  # precede the wrapper.  The scan finds the wrapper regardless.
  # ---------------------------------------------------------------------------
  _do_scan_for_wrapper() {
    local _scan_i="$idx"
    while [[ $_scan_i -lt $tok_count ]]; do
      local _sr="${toks[$_scan_i]}"
      local _st="${_sr##*/}"
      _st="${_st#\\}"
      case "$_st" in
        command|nohup|env|timeout|nice|bash|sh|zsh|ksh|eval)
          idx="$_scan_i"
          return 0
          ;;
      esac
      _scan_i=$(( _scan_i + 1 ))
    done
    return 1
  }

  # ---------------------------------------------------------------------------
  # Main token walk: skip transparent prefixes, then match the wrapper token.
  # ---------------------------------------------------------------------------
  local idx=0

  while [[ $idx -lt $tok_count ]]; do
    local raw_tok="${toks[$idx]}"
    # Basename resolution for path-qualified wrappers (/bin/bash → bash).
    # Also strip a leading backslash so \bash is treated the same as bash
    # (bash quote-removal does not prevent a literal \bash from reaching here).
    local tok="${raw_tok##*/}"
    tok="${tok#\\}"

    case "$tok" in
      command)
        # Skip 'command' and any flags it owns.
        idx=$(( idx + 1 ))
        _do_skip_command_flags
        ;;
      nohup)
        # Transparent prefix: self-contained, no flags to skip.
        idx=$(( idx + 1 ))
        ;;
      env)
        # Skip 'env' itself and any flags/assignments it owns.
        # When _do_skip_env_flags detects -S/--split-string it returns 2 and
        # sets _env_split_payload to the payload string env will re-execute.
        # Treat this like a string-executing wrapper: extract the payload and
        # return 0 (caller recurses into it), or fail-closed (rc=2) if empty.
        idx=$(( idx + 1 ))
        local _env_flags_rc=0
        _do_skip_env_flags || _env_flags_rc=$?
        if [[ "$_env_flags_rc" -eq 2 ]]; then
          # env is acting as a string-executor via --split-string.
          if [[ -n "$_env_split_payload" ]]; then
            printf '%s' "$_env_split_payload"
            return 0
          else
            # No payload: fail-closed.
            return 2
          fi
        fi
        ;;
      timeout|nice)
        # Scan-forward approach (arity-free): after the prefix word, scan ALL
        # remaining tokens left-to-right for the first token that normalizes to
        # a known string-executing wrapper or recognized transparent prefix.
        #
        # This replaces per-command flag-arity tracking.  It does not matter
        # how many flags or positional values precede the wrapper:
        #   timeout 5 bash -c "..."            (plain duration, no flags)
        #   timeout -s 9 5 bash -c "..."       (space-separated -s value)
        #   timeout -k 1 5 bash -c "..."       (space-separated -k value)
        #   timeout --signal=9 5 bash -c "..." (=-form, self-contained)
        #   timeout -k 1 --preserve-status 5 bash -c "..."
        #   nice bash -c "..."                 (no flags)
        #   nice -n 5 bash -c "..."            (two-token -n value)
        #   nice -n5 bash -c "..."             (combined form)
        #
        # KEY CONSTRAINT: if no wrapper is found among remaining tokens,
        # return 1 (not a string-executing wrapper).  Benign direct-git
        # prefixed forms (timeout 5 git status) are handled by
        # process_segment's canon_has_git_token branch, not here.
        idx=$(( idx + 1 ))
        if ! _do_scan_for_wrapper; then
          return 1
        fi
        ;;
      eval)
        # eval: the rest of the tokens (joined by spaces) form the command.
        # An eval with no arguments is a no-op → outcome (a).
        local _ri=$(( idx + 1 ))
        if [[ $_ri -ge $tok_count ]]; then
          return 1
        fi
        local _cs="${toks[$_ri]}"
        local _j=$(( _ri + 1 ))
        while [[ $_j -lt $tok_count ]]; do
          _cs="$_cs ${toks[$_j]}"
          _j=$(( _j + 1 ))
        done
        printf '%s' "$_cs"
        return 0
        ;;
      bash|sh|zsh|ksh)
        # Shell wrapper recognised.  Advance past the wrapper name, then
        # search for -c (with combined-flag support).
        idx=$(( idx + 1 ))
        _do_shell_c_extract
        # Propagate the exact return code: 0 (extracted), 1 (not -c), 2 (fail-closed).
        return $?
        ;;
      *)
        # Pure-output / no-exec builtins: these commands NEVER execute their
        # arguments, so their argument tokens are not a string-executing
        # context.  Short-circuit: return 1 (not a wrapper).
        #
        # CANON_NO_EXEC_BUILTINS is the authoritative list.  Do NOT add eval
        # or any executing command to this set.
        # (See also: round-6 WARNING regression — echo/printf with UNQUOTED
        #  bare "bash" token were over-blocked by scan-forward.)
        local _tok_base="${tok##*/}"
        _tok_base="${_tok_base#\\}"
        case "$_tok_base" in
          echo|printf|:|true|false)
            return 1
            ;;
        esac

        # Unknown leading token (e.g. setsid, stdbuf, xargs, sudo, or any
        # future unrecognised prefix).  Universal scan-forward: advance past
        # this token, then scan ALL remaining tokens left-to-right for the
        # first one that normalises to a known string-executing wrapper
        # (bash/sh/zsh/ksh/eval) or recognised transparent prefix.
        #
        # This is prefix-vocabulary-free: no allowlist of outer words is
        # needed because we simply look for the wrapper wherever it appears.
        # Benign commands like "echo" are safe because their argument tokens
        # are entire quoted strings (e.g. echo "bash -c …") — after
        # canon_tokenize strips the outer quotes, that multi-word string
        # becomes ONE token ("bash -c …") which does NOT match "bash" exactly
        # in the case, so the scan proceeds past it and returns 1.
        #
        # If a wrapper is found, _do_scan_for_wrapper sets idx to its
        # position; the outer loop continues and the wrapper's case arm fires.
        # If no wrapper is found, the segment has no string-executing context
        # — outcome (a).
        idx=$(( idx + 1 ))
        if ! _do_scan_for_wrapper; then
          return 1
        fi
        ;;
    esac
    # loop continues — keep advancing through transparent prefixes
  done

  # Exhausted all tokens without finding a wrapper — outcome (a).
  return 1
}

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
# canon_git_C_path <raw_segment>
# ---------------------------------------------------------------------------
# Extracts the EFFECTIVE path that git will use for a sequence of -C options
# in a raw git command segment. Uses canon_tokenize so quoted paths with
# spaces are treated as a single token. Prints the effective path on stdout;
# prints nothing when -C is absent or its value cannot be determined.
#
# Git applies multiple -C options in sequence:
#   - An absolute path REPLACES the accumulated path.
#   - A relative path is resolved relative to the accumulated path (composed).
#
# Handles:
#   "git -C /some/path push origin HEAD"           → "/some/path"
#   "git -C 'my dir' push origin HEAD"             → "my dir"
#   "git -C /tmp/a -C /tmp/b push origin HEAD"     → "/tmp/b"   (last absolute wins)
#   "git -C /tmp/a -C sub push origin HEAD"        → "/tmp/a/sub" (relative composes)
#   "git push origin main"                         → ""  (no -C)
#
# Returns the effective directory exactly as computed; callers should validate
# with [[ -d ]] before use.
canon_git_C_path() {
  local segment="$1"

  # Use canon_tokenize to split into tokens; walk the token stream looking for
  # a standalone "git" token, then apply the same value-consuming rule as
  # canon_git_subcommand: -C (without '=') consumes the next token as its value.
  local tokens
  tokens=$(canon_tokenize "$segment")

  local -a tok_arr
  local tok_count=0
  while IFS= read -r t; do
    tok_arr[tok_count]="$t"
    tok_count=$(( tok_count + 1 ))
  done <<< "$tokens"

  # Find the first standalone "git" token.
  local git_idx=-1
  local i
  for (( i=0; i<tok_count; i++ )); do
    if [[ "${tok_arr[$i]}" == "git" ]]; then
      git_idx=$i
      break
    fi
  done
  if [[ $git_idx -lt 0 ]]; then return 0; fi

  # Walk tokens after "git"; collect ALL -C values and compute the effective
  # directory the same way git does:
  #   - absolute path → replace accumulated
  #   - relative path → join onto accumulated (accumulated/relative)
  # Stop at the subcommand (first bare non-'-' token).
  local expect_value=0
  local expect_C_value=0
  local effective_dir=""
  local found_C=0
  for (( i=git_idx+1; i<tok_count; i++ )); do
    local tok="${tok_arr[$i]}"

    if [[ "$expect_C_value" -eq 1 ]]; then
      expect_C_value=0
      found_C=1
      # Compose: absolute path replaces; relative path appends to accumulated.
      if [[ "$tok" == /* ]]; then
        effective_dir="$tok"
      else
        if [[ -n "$effective_dir" ]]; then
          effective_dir="${effective_dir}/${tok}"
        else
          effective_dir="$tok"
        fi
      fi
      continue
    fi

    if [[ "$expect_value" -eq 1 ]]; then
      # Value for some other consuming global; skip.
      expect_value=0
      continue
    fi

    if [[ "$tok" == -* ]]; then
      if [[ "$tok" == *=* ]]; then
        : # self-contained (e.g. --git-dir=/x), skip flag only
      else
        case "$tok" in
          -C)
            expect_C_value=1
            ;;
          -c|--git-dir|--work-tree|--namespace|--exec-path|--super-prefix)
            expect_value=1
            ;;
          *)
            : # unknown or self-contained global, skip flag only
            ;;
        esac
      fi
      continue
    fi

    # First bare non-'-' token is the subcommand — stop.
    break
  done

  if [[ "$found_C" -eq 1 ]]; then
    printf '%s' "$effective_dir"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# canon_git_dir_arg <command>
# ---------------------------------------------------------------------------
# Detects a leading "cd <dir> &&" prefix OR a "git -C <dir> ..." inline form
# in a shell command and, when the extracted directory exists on disk, prints
# just the DIRECTORY PATH so callers can pass it safely as: git -C "$path" ...
#
# Returning only the path (not "-C <path>") lets callers quote it correctly,
# preventing word-splitting on paths containing spaces (P1 Finding B fix).
#
# Handles:
#   "cd /some/path && git commit -m msg"       → "/some/path"
#   "  cd ./relative && git commit"            → "./relative"  (if dir exists)
#   "git -C /some/path push origin HEAD"       → "/some/path"  (if dir exists)
#   "git -C /tmp/a -C /tmp/b push origin HEAD" → "/tmp/b"  (effective dir, if exists)
#   "git commit -m msg"                        → ""
#   "cd /nonexistent && git commit"            → ""
#
# Callers MUST use the array form to avoid word-splitting on spaces:
#   local -a gda=()
#   local _p; _p=$(canon_git_dir_arg "$cmd")
#   [[ -n "$_p" ]] && gda=(-C "$_p")
#   git "${gda[@]}" <subcmd> ...
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

  # Strip one matched pair of surrounding quotes, if present. Agents commonly
  # quote the path (cd "<worktree>" && git commit); without this the quotes stay
  # attached and the [[ -d ]] gate below fails, dropping the -C scope. Only strip
  # when leading and trailing quotes match (a lone quote is left intact).
  case $cd_target in
    \"*\") cd_target=${cd_target#\"}; cd_target=${cd_target%\"} ;;
    \'*\') cd_target=${cd_target#\'}; cd_target=${cd_target%\'} ;;
  esac

  if [[ -n "$cd_target" ]] && [[ -d "$cd_target" ]]; then
    printf '%s' "$cd_target"
    return
  fi

  # Also check for a "git -C <path> ..." inline form (separate token, not =form).
  # This handles "git -C /other/repo push origin HEAD" where there is no leading cd.
  # canon_git_C_path now returns the EFFECTIVE path after composing all -C options.
  local c_path
  c_path=$(canon_git_C_path "$command" || true) # DOCUMENTED FAIL-OPEN -- absent -C is the normal case
  if [[ -n "$c_path" ]] && [[ -d "$c_path" ]]; then
    printf '%s' "$c_path"
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
# token via canon_tokenize and processes only the tokens AFTER it. A blind
# word-substitution (sed s/…git…//) only removes the "git" word, leaving any
# wrapper prefix (sudo, env, time, nice, command) fused to the next token,
# which then mis-resolves as the subcommand → fail-OPEN. Anchoring to the
# actual "git" token (not a substring match) is required for correctness.
#
# Bug-2 fix (quoted option values with spaces): accepts the raw (pre-quote-
# deletion) segment so that quoted multi-word values for value-consuming
# globals (e.g. -C "my dir") are treated as ONE token. canon_tokenize splits
# on unquoted whitespace only — quoted spans are preserved as a single token.
# Quote characters are stripped from the resolved subcommand token to maintain
# compatibility with Bypass-3 intra-token quote handling (git "clean" → clean).
#
# Bug-3 fix (spurious "git" value/positional): "git" is never a valid git
# subcommand; returning 1 causes the parse-ambiguity guard to fire → exit 2.
#
# Shape-validation fix: after quote-stripping the candidate subcommand token,
# if it does not match ^[A-Za-z][A-Za-z0-9_-]*$ (i.e. it contains $, {}, ()
# or other shell metacharacters), return 1 so the parse-ambiguity guard in
# destructive-guard.sh blocks fail-closed. This closes the fail-open gap for
# "git $SUBCMD", "git ${CMD}", "git $(pick-cmd)" etc.
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
  # Use canon_has_git_token for a quote-aware, tokenizer-authoritative check.
  if ! canon_has_git_token "$stripped"; then
    return 1
  fi

  # Use canon_tokenize to split the segment into tokens, then locate the first
  # standalone "git" token and walk the tokens after it.
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
  tokens_output=$(canon_tokenize "$stripped")

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
      # Shape validation: a valid git subcommand token consists only of
      # alphanumeric characters, hyphens, and underscores, starting with a
      # letter. Tokens containing $, {, }, (, ), ` etc. are shell constructs
      # whose runtime value is unknown — treat as unresolvable → return 1 so
      # the parse-ambiguity guard fires → fail-closed (exit 2).
      if ! printf '%s' "$sub" | grep -qE '^[A-Za-z][A-Za-z0-9_-]*$'; then
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
