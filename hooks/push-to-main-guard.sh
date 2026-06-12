#!/bin/bash
# Canon Push-to-Main Guard
# Runs as a PreToolUse hook on Bash commands.
# Blocks any git push whose destination resolves to the repo's default protected
# branch (derived from origin/HEAD, falling back to "main"), so direct pushes
# bypass PR review and required build checks.
#
# SCOPE AND THREAT MODEL:
# This guard provides robust defense-in-depth against ACCIDENTAL and common-form
# direct pushes to the protected branch, including abbreviated flags, config-driven
# bare pushes, and shell-obfuscated forms. It is NOT an airtight control against a
# determined local actor who can disable or chmod -x this hook file. The
# AUTHORITATIVE enforcement control is GitHub branch-protection / rulesets on the
# remote. This hook catches mistakes before they reach the wire.
# Any push form that cannot be statically proven to NOT touch the protected branch
# is blocked fail-closed (dc-05: fail-closed-on-ambiguity).
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
#       segments (depth-capped at 3); rc=1 (not a wrapper): check for ambiguous
#       git-prefixed token (fail-closed if found), else ALLOW. Non-git segments
#       containing $(...) or backticks are allowed — they cannot be git pushes.
#       Obfuscated refspecs WITHIN a real git push are caught by SAFE_REFSPEC_RE.
#   6. Resolve the git subcommand via canon_git_subcommand (shape-validated).
#      Empty → fail-closed.
#   7. case "$sub": only "push" is inspected; all other subcommands return 0.
#   8. For "push": push_updates_protected_branch first checks for "push everything"
#      modes (--all, --mirror, and their unambiguous git-accepted abbreviations)
#      and blocks them unconditionally — they ignore push.default and the current
#      branch, so they can push the protected branch from any checkout
#      (dc-05: fail-closed-on-ambiguity). Then uses an allowlist gate on each
#      refspec — ALLOW only if the whole token is provably-literal (strict charset,
#      no shell metacharacters) AND its destination != protected branch. Any
#      non-provably-literal refspec fails-closed (BLOCK).
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
  # Resolution order: (1) git -C <path> in the command — the command explicitly
  # names the target repo; (2) CANON_GUARD_CWD (test/env override);
  # (3) leading "cd <dir> &&" prefix; (4) empty (use hook's cwd).
  # canon_git_dir_path returns only the path; use an array to avoid word-splitting
  # on paths containing spaces. Covers cd-prefix AND -C (multiple -C composed).
  local _gda_path
  _gda_path=$(canon_git_dir_path "$raw_segment")
  local -a git_dir_args=()
  if [[ -n "$_gda_path" ]]; then
    git_dir_args=(-C "$_gda_path")
  elif [[ -n "${CANON_GUARD_CWD:-}" ]]; then
    git_dir_args=(-C "$CANON_GUARD_CWD")
  fi
  local ref
  ref=$(git ${git_dir_args[@]+"${git_dir_args[@]}"} symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- unset origin/HEAD falls back to main below
  ref="${ref#refs/remotes/origin/}"
  if [[ -z "$ref" ]]; then
    ref="main"
  fi
  printf '%s' "$ref"
}

# ---------------------------------------------------------------------------
# is_push_everything_mode <token>
#
# Returns 0 (true) when the token is an unambiguous prefix of --all, --mirror,
# or --branches that git would accept as those flags (canonical-prefix expansion).
# --branches is an alias of --all (per git push -h) and likewise pushes every
# local branch including the protected branch; it must be blocked unconditionally.
#
# git's parse-options accepts any unambiguous abbreviation of a long option.
# For --all:      accepted prefixes are --a, --al, --all
# For --mirror:   accepted prefixes are --m, --mi, --mir, --mirr, --mirro, --mirror
# For --branches: accepted prefixes are --b, --br, --bra, --bran, --branc,
#                 --branch, --branches
#
# The posture is CONSERVATIVE / fail-closed (dc-05): we block both the
# unambiguous accepted forms AND the genuinely ambiguous short forms (--a, --m)
# that git itself would reject. A blocked-but-git-rejected prefix is harmless
# (git would have rejected the command anyway); an accepted-but-unblocked prefix
# is the security defect we are closing.
#
# Flags that start with --a or --m but are definitively NOT push-everything:
#   --atomic  → starts with --at, not matched by the pattern below
#   --all=*   → the = sign prevents a pure-prefix match at the boundary
# --no-branches cancels --branches; it is NOT a push-everything mode and must
# NOT be blocked (the negation form never starts with --b(r...) without --no-).
# No other git-push long option starts with --a, --mi, or --b that could push main.
#
# Implementation: regex match on the full token.
#   --all family:      ^--a(l(l)?)?$
#   --mirror family:   ^--m(i(r(r(o(r)?)?)?)?)?$
#   --branches family: ^--b(r(a(n(c(h(e(s)?)?)?)?)?)?)?$
# ---------------------------------------------------------------------------
is_push_everything_mode() {
  local token="$1"
  if [[ "$token" =~ ^--a(l(l)?)?$ ]]; then
    return 0
  fi
  if [[ "$token" =~ ^--m(i(r(r(o(r)?)?)?)?)?$ ]]; then
    return 0
  fi
  if [[ "$token" =~ ^--b(r(a(n(c(h(e(s)?)?)?)?)?)?)?$ ]]; then
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# bare_push_is_safe <raw_segment> <protected> <remote>
#
# Returns 0 (safe → allow) only when ALL of the following are true:
#   - current branch resolves (not detached HEAD)
#   - current branch ≠ protected branch
#   - push.default is "" (unset), "simple", or "current" (pushes current
#     branch under its own name → destination = current branch ≠ protected)
#   - no configured remote.<remote>.push refspec that could push the protected
#     branch (e.g. refs/heads/* matching-glob or refs/heads/main:refs/heads/main)
#   - remote.<remote>.mirror is not true (mirror config makes bare push act
#     like --mirror — pushes all refs including the protected branch)
# Any failure to resolve → returns 1 (NOT safe → caller blocks).
# ---------------------------------------------------------------------------
bare_push_is_safe() {
  local raw_segment="$1"
  local protected="$2"
  local remote="${3:-origin}"
  # Resolution order: (1) git -C <path> in the command; (2) CANON_GUARD_CWD;
  # (3) leading "cd <dir> &&" prefix; (4) empty (use hook's cwd).
  # canon_git_dir_path returns only the path; use an array to avoid word-splitting
  # on paths containing spaces. Covers cd-prefix AND -C (multiple -C composed).
  local _gda_path
  _gda_path=$(canon_git_dir_path "$raw_segment")
  local -a git_dir_args=()
  if [[ -n "$_gda_path" ]]; then
    git_dir_args=(-C "$_gda_path")
  elif [[ -n "${CANON_GUARD_CWD:-}" ]]; then
    git_dir_args=(-C "$CANON_GUARD_CWD")
  fi
  local cur pd
  cur=$(git ${git_dir_args[@]+"${git_dir_args[@]}"} symbolic-ref --short HEAD 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- detached HEAD → empty → caller blocks
  if [[ -z "$cur" ]]; then
    return 1   # detached HEAD / unresolved → NOT safe → block
  fi
  if [[ "$cur" == "$protected" ]]; then
    return 1   # on the protected branch → bare push targets it → block
  fi
  pd=$(git ${git_dir_args[@]+"${git_dir_args[@]}"} config --get push.default 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- unset → default 'simple' → safe
  case "$pd" in
    ""|simple|current) ;;   # pushes current branch to same-named ref → safe so far (cur != protected)
    *) return 1 ;;          # matching/upstream/nothing/unknown → cannot prove safe → block
  esac

  # Config-driven bare-push main-movers (dc-05: fail-closed if cannot prove safe):
  #
  # (1) remote.<remote>.mirror = true makes bare 'git push <remote>' behave like
  # --mirror — pushes ALL refs including the protected branch regardless of
  # push.default or current branch. Block if any remote has mirror=true.
  local mirror_val
  mirror_val=$(git ${git_dir_args[@]+"${git_dir_args[@]}"} config --bool --get "remote.${remote}.mirror" 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- absent config → empty → safe
  if [[ "$mirror_val" == "true" ]]; then
    return 1   # mirror config → bare push mirrors ALL refs including protected → block
  fi

  # (2) remote.<remote>.push = <refspec> overrides push.default entirely.
  # With refs/heads/*:refs/heads/* or similar glob, bare 'git push' updates ALL
  # branches including the protected branch. Block if any push refspec is set
  # for the target remote — we cannot cheaply prove a glob doesn't match the
  # protected branch, so fail-closed.
  local configured_push_refspec
  configured_push_refspec=$(git ${git_dir_args[@]+"${git_dir_args[@]}"} config --get-all "remote.${remote}.push" 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- absent config → empty → safe
  if [[ -n "$configured_push_refspec" ]]; then
    return 1   # push refspec overrides push.default → cannot prove safe → block
  fi

  return 0   # all checks passed → safe → allow
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
  local remote_name="origin"  # default remote name; updated when first bare token seen
  local refspecs=()
  local skip_next=false
  local _capture_repo_next=false  # set when --repo <value> (separate form) is seen
  local tags_only_mode=false   # set when --tags seen (without push-everything mode)

  while IFS= read -r token; do
    [[ -z "$token" ]] && continue

    if [[ "$skip_next" == "true" ]]; then
      skip_next=false
      continue
    fi

    # --repo <value> (separate form): the previous token was --repo, so this
    # token is the repository value. Mark remote as known and capture the name
    # so subsequent bare tokens are parsed as refspecs (Finding 2 fix).
    if [[ "$_capture_repo_next" == "true" ]]; then
      _capture_repo_next=false
      remote_seen=true
      remote_name="$token"
      continue
    fi

    # Handle option tokens
    if [[ "$token" == -* ]]; then
      # "Push everything" modes: --all/--branches push every refs/heads/* branch;
      # --mirror pushes ALL refs and makes the remote an exact copy.
      # None honors push.default or the current branch — they can push
      # the protected branch even from a feature-branch checkout.
      # dc-05 fail-closed-on-ambiguity: cannot prove they will NOT touch the
      # protected branch → block unconditionally.
      # is_push_everything_mode detects the canonical spellings (--all, --branches,
      # --mirror) AND all git-accepted unambiguous abbreviations (--al, --b, --br,
      # --bra, ..., --mi, --mir, ...) using canonical-prefix expansion — closing the
      # v3 CRITICAL (abbreviations) and the --branches alias finding.
      if is_push_everything_mode "$token"; then
        return 0   # BLOCK — push-everything mode (or abbreviation) is ambiguous w.r.t. protected branch
      fi
      case "$token" in
        # --tags: pushes only refs/tags/*, never branch refs. A tags-only push
        # without positional refspecs cannot reach the protected branch.
        --tags)
          tags_only_mode=true
          ;;
        # Self-contained boolean push options (no value consumed)
        -f|--force|--force-with-lease|--force-if-includes|\
        -u|--set-upstream|\
        --delete|-d|--atomic|-n|--dry-run|--porcelain|\
        --no-verify|--prune|-q|--quiet|-v|--verbose|\
        --follow-tags|--signed|-4|-6)
          # self-contained, skip
          ;;
        # --force-with-lease=* or --force-if-includes=* (= form, self-contained)
        --force-with-lease=*|--force-if-includes=*|--signed=*)
          # self-contained, skip
          ;;
        # --repo supplies the target repository, replacing the positional <repository>
        # argument. When --repo is present, subsequent bare tokens are REFSPECS,
        # not the remote — so we must mark remote_seen=true and set remote_name so
        # those tokens flow through the refspec-safety gate instead of being silently
        # consumed as the "first bare = remote" slot (Finding 2 fix).
        #
        # Separate form: --repo <value> — set _capture_repo_next so the NEXT token
        # is captured as remote_name (handled at the top of the loop).
        # Equals form: --repo=<value> — extract the value inline.
        --repo)
          _capture_repo_next=true
          ;;
        --repo=*)
          # Self-contained: extract value after '=' and mark remote as known.
          remote_seen=true
          remote_name="${token#--repo=}"
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
        # --recurse-submodules consumes a value token (check|on-demand|only|no).
        # Separate form: --recurse-submodules <value> — consume the next token.
        # Equals form:   --recurse-submodules=<value> — self-contained.
        # Without this, 'git push --recurse-submodules check origin' would treat
        # 'check' as the remote and 'origin' as a refspec, mis-parsing a bare
        # push to origin as a safe refspec push (Finding B fix).
        --recurse-submodules)
          skip_next=true
          ;;
        --recurse-submodules=*)
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
      remote_name="$token"  # capture the remote name for config-driven bare-push checks
    else
      refspecs+=("$token")
    fi
  done <<< "$tokens"

  # No refspec tokens: bare push form (git push / git push origin)
  if [[ "${#refspecs[@]}" -eq 0 ]]; then
    # Tags-only push (--tags with no positional refspecs): pushes only
    # refs/tags/* — never branch refs, so the protected branch is not touched.
    if [[ "$tags_only_mode" == "true" ]]; then
      return 1   # tags-only → allow (cannot push branch main)
    fi
    # Narrow positive-safety allow: if current branch can be resolved and is
    # demonstrably not the protected branch with a safe push.default → allow.
    # Also checks remote.*.mirror and remote.*.push config (v3 MEDIUM fix).
    if bare_push_is_safe "$raw_segment" "$protected" "$remote_name"; then
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

    # Finding A fix: when the destination is the symbolic ref HEAD (e.g.
    # 'git push origin HEAD' or 'git push origin src:HEAD'), git resolves it
    # to the current branch. We must do the same — a push to HEAD while on the
    # protected branch is a direct push to the protected branch.
    # Fail-closed: if the current branch cannot be resolved (detached HEAD or
    # git unavailable), HEAD's target is unknown → block (dc-05).
    if [[ "$dst" == "HEAD" ]]; then
      local _head_branch
      # Resolution order: (1) git -C <path> in the command — the command
      # explicitly targets that repo; (2) CANON_GUARD_CWD (test/env override);
      # (3) leading "cd <dir> &&" prefix; (4) empty (hook's cwd).
      # canon_git_dir_path returns only the path; use an array to avoid
      # word-splitting on paths containing spaces. Covers cd-prefix AND -C.
      local _gda_path_head
      _gda_path_head=$(canon_git_dir_path "$raw_segment")
      local -a _gda_head=()
      if [[ -n "$_gda_path_head" ]]; then
        _gda_head=(-C "$_gda_path_head")
      elif [[ -n "${CANON_GUARD_CWD:-}" ]]; then
        _gda_head=(-C "$CANON_GUARD_CWD")
      fi
      _head_branch=$(git ${_gda_head[@]+"${_gda_head[@]}"} symbolic-ref --short HEAD 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- empty on detached HEAD → fail-closed below
      if [[ -z "$_head_branch" ]]; then
        echo "CANON: push refspec destination is HEAD but current branch cannot be resolved — blocking fail-closed." >&2
        return 0   # unknown HEAD target → BLOCK (dc-05: fail-closed-on-ambiguity)
      fi
      dst="$_head_branch"
    fi

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
      # No standalone git token, not a string-executing wrapper, and no ambiguous
      # git-prefixed token: this segment cannot be a git push. Allow it.
      # (Command substitution inside a NON-git segment, e.g. `echo $(whoami)` or a
      # gh-comment body with backticks, is not a push and must not be fail-closed —
      # that was the over-broad defect. Obfuscated refspecs WITHIN a git push are
      # still caught by the SAFE_REFSPEC_RE allowlist in push_updates_protected_branch.)
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
        # Detect push-everything mode flags (including abbreviations) for a more specific message
        local _protected _block_reason _push_everything_found=false
        _protected=$(resolve_protected_branch "$raw_segment")
        _block_reason="direct push to the protected branch '$_protected'"
        local _msg_token
        for _msg_token in $segment; do
          if [[ "$_msg_token" == -* ]] && is_push_everything_mode "$_msg_token"; then
            _push_everything_found=true
            break
          fi
        done
        if [[ "$_push_everything_found" == "true" ]]; then
          _block_reason="'--all'/'--branches'/'--mirror' push (or abbreviated form — pushes every local branch including '$_protected' — cannot be proven safe)"
        fi
        cat <<EOF >&2
CANON: Blocked $_block_reason.
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
