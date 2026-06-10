#!/bin/bash
# Canon Push-to-Main Guard
# Runs as a PreToolUse hook on Bash commands.
# Blocks any git push whose destination resolves to the repo's default protected
# branch (derived from origin/HEAD, falling back to "main"), so direct pushes
# bypass PR review and required build checks.
#
# Detection pipeline (mirrors destructive-guard.sh):
#   1. Extract command via canon_extract_command (jq with grep/sed fallback).
#   2. Strip shell comments via canon_strip_comments.
#   3. Delete shell quote characters via tr -d (bash quote-removal).
#   4. Segment on && || ; | to evaluate each segment independently.
#   5. For each segment: use canon_has_git_token (tokenizer-authoritative) to
#      check for a standalone "git" token — skips segments without one.
#   5a. String-executing-wrapper expansion: same three-way rc logic as
#       destructive-guard.sh — rc=2 → fail-closed; rc=0 → recurse on inner
#       segments (depth-capped at 3); rc=1 + ambiguous token → fail-closed.
#   6. Resolve the git subcommand via canon_git_subcommand (shape-validated).
#      Empty → fail-closed.
#   7. case "$sub": only "push" is inspected; all other subcommands return 0.
#   8. For "push": push_updates_protected_branch uses an allowlist gate on each
#      refspec — ALLOW only if the whole token is provably-literal (strict
#      charset, no shell metacharacters) AND its destination != protected branch.
#      Any non-provably-literal refspec fails-closed (BLOCK).
#
# Input: JSON on stdin with the tool call details
# Output: Warning message on stderr (when blocking)
# Exit 0: allow the tool call
# Exit 2: block the tool call (user will be prompted)

set -euo pipefail

# shellcheck source=lib/canon-hook-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/canon-hook-lib.sh"

# Read the tool input from stdin
INPUT=$(cat)

# Extract the command being run from the tool input
COMMAND=$(canon_extract_command "$INPUT")

# If we couldn't extract a command, distinguish two cases:
#   1. No "command" field in payload, or command value is empty ("") → pass (exit 0)
#   2. Payload has a "command" key with a non-empty value but extraction yielded
#      empty (jq unavailable and grep/sed also failed) → fail CLOSED (exit 2)
if [[ -z "$COMMAND" ]]; then
  if [[ -n "$INPUT" ]] && printf '%s' "$INPUT" | grep -qE '"command"[[:space:]]*:[[:space:]]*"[^"]'; then
    echo "CANON: command extraction failed on a command payload — blocking fail-closed." >&2
    exit 2
  fi
  exit 0
fi

# Strip shell comments before any further processing. Both streams (RAW and
# quote-deleted) share the same comment-stripped base.
COMMAND=$(printf '%s' "$COMMAND" | canon_strip_comments)

# Preserve the raw (post-comment-strip, pre-quote-deletion) command for
# subcommand resolution. canon_git_subcommand requires the raw form so that
# quoted multi-word values for value-consuming globals (e.g. -C "my dir")
# are treated as ONE token.
RAW_COMMAND="$COMMAND"

# canon_delete_quotes — single source of truth for quote-removal.
# Deletes all shell quote characters (" and ') from the input, exactly
# reproducing bash quote-removal.  Called at the top-level and at each
# recursive unwrap site so both paths apply the SAME transformation.
canon_delete_quotes() {
  printf '%s' "$1" | tr -d '"'"'"''
}

# Neutralize shell quote characters before any boundary/flag matching.
COMMAND=$(canon_delete_quotes "$COMMAND")

# ---------------------------------------------------------------------------
# Per-subcommand argument extractor.
# (Copied verbatim from destructive-guard.sh — see decision D3.)
#
# Given a single git command segment and the resolved subcommand token, print
# only the tokens that appear AFTER the subcommand (its own arguments).
# ---------------------------------------------------------------------------
git_subcommand_args() {
  local segment="$1"
  local sub="$2"
  printf '%s' "$segment" \
    | awk -v subcmd="$sub" '
        {
          found = 0
          out = ""
          for (i = 1; i <= NF; i++) {
            if (!found && $i == subcmd) { found = 1; continue }
            if (found) { out = (out == "" ? $i : out " " $i) }
          }
          print out
        }'
}

# ---------------------------------------------------------------------------
# resolve_protected_branch <raw_segment>
#
# Derives the repo's default protected branch name.
# Uses git symbolic-ref refs/remotes/origin/HEAD (strips the
# refs/remotes/origin/ prefix) or falls back to literal "main".
# Scopes the git call via CANON_GUARD_CWD (when set) or canon_git_dir_arg
# so -C flags are honored. (F3: single-source git-dir scoping — honors
# CANON_GUARD_CWD consistently with bare_push_is_safe.)
# ---------------------------------------------------------------------------
resolve_protected_branch() {
  local raw_segment="$1"
  local git_dir_arg
  # When CANON_GUARD_CWD is set, run git in that directory (matches bare_push_is_safe)
  if [[ -n "${CANON_GUARD_CWD:-}" ]]; then
    git_dir_arg="-C $CANON_GUARD_CWD"
  else
    git_dir_arg=$(canon_git_dir_arg "$raw_segment")
  fi
  local ref
  # shellcheck disable=SC2086
  ref=$(git $git_dir_arg symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- unset origin/HEAD falls back to main below
  ref="${ref#refs/remotes/origin/}"
  if [[ -z "$ref" ]]; then
    ref="main"
  fi
  printf '%s' "$ref"
}

# ---------------------------------------------------------------------------
# bare_push_is_safe <raw_segment> <protected>
#
# Returns 0 (safe → allow) only when ALL of the following are true:
#   - current branch resolves (not detached HEAD)
#   - current branch ≠ protected branch
#   - push.default is "" (unset), "simple", or "current" (pushes current
#     branch under its own name → destination = current branch ≠ protected)
# Any failure to resolve → returns 1 (NOT safe → caller blocks).
# ---------------------------------------------------------------------------
bare_push_is_safe() {
  local raw_segment="$1"
  local protected="$2"
  local git_dir_arg
  # When CANON_GUARD_CWD is set, run git in that directory
  if [[ -n "${CANON_GUARD_CWD:-}" ]]; then
    git_dir_arg="-C $CANON_GUARD_CWD"
  else
    git_dir_arg=$(canon_git_dir_arg "$raw_segment")
  fi
  local cur pd
  # shellcheck disable=SC2086
  cur=$(git $git_dir_arg symbolic-ref --short HEAD 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- detached HEAD → empty → caller blocks
  if [[ -z "$cur" ]]; then
    return 1   # detached HEAD / unresolved → NOT safe → block
  fi
  if [[ "$cur" == "$protected" ]]; then
    return 1   # on the protected branch → bare push targets it → block
  fi
  # shellcheck disable=SC2086
  pd=$(git $git_dir_arg config --get push.default 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- unset → default 'simple' → safe
  case "$pd" in
    ""|simple|current) return 0 ;;   # pushes current branch to same-named ref → safe (cur != protected)
    *) return 1 ;;                   # matching/upstream/nothing/unknown → cannot prove safe → block
  esac
}

# ---------------------------------------------------------------------------
# push_updates_protected_branch <segment> <raw_segment>
#
# Returns 0 (true → BLOCK) when the push updates the protected branch OR the
# form is ambiguous/unresolvable.
# Returns 1 (allow) only when the destination is POSITIVELY non-protected.
# ---------------------------------------------------------------------------
push_updates_protected_branch() {
  local segment="$1"
  local raw_segment="$2"
  local protected
  protected=$(resolve_protected_branch "$raw_segment")

  # Extract the args after "push"
  local args
  args=$(git_subcommand_args "$segment" push)

  # Tokenize args via canon_tokenize, then walk tokens to identify:
  #   - option tokens (dropped or value-consumed)
  #   - first bare token = remote
  #   - remaining bare tokens = refspecs
  local tokens
  tokens=$(canon_tokenize "$args")

  local token
  local remote_seen=false
  local refspecs=()
  local skip_next=false

  while IFS= read -r token; do
    [[ -z "$token" ]] && continue

    if [[ "$skip_next" == "true" ]]; then
      skip_next=false
      continue
    fi

    # Handle option tokens
    if [[ "$token" == -* ]]; then
      case "$token" in
        # Self-contained boolean push options (no value consumed)
        -f|--force|--force-with-lease|--force-if-includes|\
        -u|--set-upstream|--tags|--all|--mirror|\
        --delete|-d|--atomic|-n|--dry-run|--porcelain|\
        --no-verify|--prune|-q|--quiet|-v|--verbose|\
        --follow-tags|--signed|-4|-6)
          # self-contained, skip
          ;;
        # --force-with-lease=* or --force-if-includes=* (= form, self-contained)
        --force-with-lease=*|--force-if-includes=*|--signed=*)
          # self-contained, skip
          ;;
        # --repo consumes next token (separate form) or is self-contained (= form)
        --repo)
          skip_next=true
          ;;
        --repo=*)
          # self-contained, skip
          ;;
        # -o / --push-option consume a value token (separate form)
        -o|--push-option)
          skip_next=true
          ;;
        --push-option=*)
          # self-contained, skip
          ;;
        # --receive-pack / --exec consume a value token (separate form)
        --receive-pack|--exec)
          skip_next=true
          ;;
        --receive-pack=*|--exec=*)
          # self-contained, skip
          ;;
        # Any other -* token: treat as self-contained (fail-closed posture:
        # this only makes us treat more following tokens as positionals → safer)
        *)
          # self-contained, skip
          ;;
      esac
      continue
    fi

    # Bare token: first is remote, rest are refspecs
    if [[ "$remote_seen" == "false" ]]; then
      remote_seen=true
    else
      refspecs+=("$token")
    fi
  done <<< "$tokens"

  # No refspec tokens: bare push form (git push / git push origin)
  if [[ "${#refspecs[@]}" -eq 0 ]]; then
    # Narrow positive-safety allow: if current branch can be resolved and is
    # demonstrably not the protected branch with a safe push.default → allow
    if bare_push_is_safe "$raw_segment" "$protected"; then
      return 1   # safe → allow
    fi
    return 0   # ambiguous or on-main → BLOCK (fail-closed)
  fi

  # ALLOWLIST posture: ALLOW only if EVERY refspec is provably-literal-safe.
  # A refspec is provably-literal iff the WHOLE token (before any derivation)
  # matches the strict safe charset below — no shell metacharacter whatsoever
  # ($, `, {, }, (, ), *, ?, [, ], ~, !, whitespace, \) and at most one colon
  # separating a source half from a destination half. Anything outside this
  # set is NOT provably safe → fail-closed BLOCK (cannot prove non-main).
  # This replaces the previous blocklist (which derived a substring first and
  # then asked negative questions — the F2 defect class). Approach: one
  # positive grep -qE gate on the whole token before any colon-split.
  # (D6: posture ADR; DESIGN-v2: empirically validated 18/18 block, 12/12 allow)
  local SAFE_REFSPEC_RE='^[+]?[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9][A-Za-z0-9._/-]*)?$'

  for refspec in "${refspecs[@]}"; do
    # ALLOWLIST GATE (positive safety): the whole token must be provably literal.
    # Any shell metacharacter ($, `, {, }, (, ), *, ?, etc.), parameter-operator
    # (:-/:=/:+/:?), glob, brace-expansion, multi-colon, or empty token fails
    # this gate → NOT provably safe → fail-closed BLOCK.
    if ! printf '%s' "$refspec" | grep -qE "$SAFE_REFSPEC_RE"; then
      echo "CANON: push refspec '$refspec' is not a provably-literal branch name (contains shell metacharacters or an unresolvable form) — blocking fail-closed." >&2
      return 0   # not provably safe → BLOCK
    fi

    # Token is now known-literal. Derive destination via FIRST-colon split.
    # (NOT ##*: — the last-colon strip is the F2 defect: ${BRANCH:-main} splits
    # inside the braces because :- contains a colon, yielding dst=-main}.)
    # On a charset-validated token there is at most one colon, so first vs last
    # is moot for legitimate input — but first-colon is safe by construction.
    local core="${refspec#+}"
    local dst
    if [[ "$core" == *:* ]]; then dst="${core#*:}"; else dst="$core"; fi
    dst="${dst#refs/heads/}"

    # Exact equality check against the protected branch (never substring/regex)
    if [[ "$dst" == "$protected" ]]; then
      return 0   # destination IS the protected branch → BLOCK
    fi
  done

  return 1   # every refspec provably-literal AND non-protected → allow
}

# ---------------------------------------------------------------------------
# Segment the command on && || ; | and evaluate each segment independently.
# Two parallel streams: quote-deleted (SEGMENTS) and raw (RAW_SEGMENTS).
# ---------------------------------------------------------------------------
SEGMENTS=$(printf '%s' "$COMMAND" | sed -E 's/(&&|\|\||;|\|)/\n/g')
RAW_SEGMENTS=$(printf '%s' "$RAW_COMMAND" | sed -E 's/(&&|\|\||;|\|)/\n/g')

# Maximum recursion depth for string-executing wrapper expansion.
CANON_WRAPPER_MAX_DEPTH=3

# ---------------------------------------------------------------------------
# process_segment <segment> <raw_segment> <depth>
#
# Evaluates a single segment pair for push-to-main violations.
# Exits the script (exit 2) if a blocking push is found.
# Returns 0 otherwise (caller continues to the next segment).
#
# The no-git-token / wrapper-unwrap / ambiguous-git-token / depth-guard /
# recurse block is copied verbatim from destructive-guard.sh (decision D3).
# Only the case "$sub" body is replaced with the push-only policy.
# ---------------------------------------------------------------------------
process_segment() {
  local segment="$1"
  local raw_segment="$2"
  local depth="$3"

  # Does this segment contain a standalone "git" token (quote-aware)?
  if ! canon_has_git_token "$raw_segment"; then
    # No standalone git token. Check whether this segment is a
    # string-executing wrapper whose quoted argument may contain git commands.
    local inner_cmd
    local _unwrap_rc=0
    inner_cmd=$(canon_unwrap_string_exec_arg "$raw_segment") || _unwrap_rc=$?

    if [[ "$_unwrap_rc" -eq 2 ]]; then
      # Recognised shell wrapper whose inner command cannot be safely extracted.
      echo "CANON: string-executing wrapper inner command unparseable — blocking fail-closed." >&2
      exit 2
    fi

    if [[ "$_unwrap_rc" -ne 0 ]] || [[ -z "$inner_cmd" ]]; then
      # Not a string-executing wrapper — but check for ambiguous git tokens.
      if canon_has_ambiguous_git_token "$raw_segment"; then
        echo "CANON: ambiguous git-prefixed token detected — blocking fail-closed." >&2
        exit 2
      fi
      # F1: Fail-CLOSED when the segment looks like a string-executing wrapper
      # whose inner command contains shell metacharacters we cannot evaluate
      # statically (command substitution via $( ) or backticks). We cannot
      # prove the inner expansion does NOT push to the protected branch → block.
      if [[ "$raw_segment" == *'$('* || "$raw_segment" == *'`'* ]]; then
        echo "CANON: segment contains unexpanded command substitution — blocking fail-closed." >&2
        exit 2
      fi
      return 0
    fi

    # F1: If the extracted inner_cmd is itself a command substitution ($(...) or
    # backtick form), we cannot evaluate it statically — block fail-closed.
    # e.g. bash -c "$(echo git push origin HEAD:main)" → inner = $(echo ...)
    if [[ "$inner_cmd" == '$('* || "$inner_cmd" == '`'* ]]; then
      echo "CANON: string-executing wrapper inner command is a shell expansion — blocking fail-closed." >&2
      exit 2
    fi

    # Depth guard: cap recursion to prevent pathological nesting.
    if [[ "$depth" -ge "$CANON_WRAPPER_MAX_DEPTH" ]]; then
      echo "CANON: string-executing wrapper nesting exceeds depth limit — blocking fail-closed." >&2
      exit 2
    fi

    # Expand the inner string: re-segment on && || ; | and recurse.
    local inner_segs
    inner_segs=$(printf '%s' "$inner_cmd" | sed -E 's/(&&|\|\||;|\|)/\n/g')
    local sub_depth=$(( depth + 1 ))
    while IFS= read -r inner_seg; do
      inner_seg=$(printf '%s' "$inner_seg" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
      [[ -z "$inner_seg" ]] && continue
      local inner_seg_qd
      inner_seg_qd=$(canon_delete_quotes "$inner_seg")
      process_segment "$inner_seg_qd" "$inner_seg" "$sub_depth"
    done <<< "$inner_segs"
    return 0
  fi

  # Resolve subcommand from the RAW segment (pre-quote-deletion).
  local sub
  sub=$(canon_git_subcommand "$raw_segment" || true) # DOCUMENTED FAIL-OPEN -- empty sub on a git segment triggers the parse-ambiguity block below

  # Fail-closed parse guard: a git invocation whose subcommand cannot be
  # resolved is ambiguous → block rather than risk passing a real push.
  if [[ -z "$sub" ]]; then
    echo "CANON: could not parse git subcommand — blocking fail-closed." >&2
    exit 2
  fi

  local args
  args=$(git_subcommand_args "$segment" "$sub")

  case "$sub" in
    push)
      if push_updates_protected_branch "$segment" "$raw_segment"; then
        cat <<EOF >&2
CANON: Blocked direct push to the protected branch '$(resolve_protected_branch "$raw_segment")'.
Direct pushes to main bypass branch protection (PR review + required build check).
Route this through a PR branch instead:
  git push origin HEAD:canon/<your-slug>
then open a pull request.
EOF
        exit 2
      fi
      ;;
  esac
  # All other git subcommands (pull, fetch, status, commit, …) fall through and return 0.
}

# ---------------------------------------------------------------------------
# Pair each quote-deleted segment with its corresponding raw segment by line
# number and call process_segment on each.
# ---------------------------------------------------------------------------
seg_idx=0
while IFS= read -r segment; do
  seg_idx=$(( seg_idx + 1 ))
  raw_segment=$(printf '%s' "$RAW_SEGMENTS" | sed -n "${seg_idx}p" || true) # DOCUMENTED FAIL-OPEN -- missing raw segment falls back to quote-deleted segment for subcommand resolution
  [[ -z "$raw_segment" ]] && raw_segment="$segment"

  # Trim leading/trailing whitespace.
  segment=$(printf '%s' "$segment" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
  raw_segment=$(printf '%s' "$raw_segment" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')
  [[ -z "$segment" ]] && continue

  process_segment "$segment" "$raw_segment" 0
done <<< "$SEGMENTS"

# No segment was a push to the protected branch — allow
exit 0
