#!/bin/bash
# mine-codex-comments.sh — Pull every chatgpt-codex-connector[bot] review
# comment across merged PRs #47+ (the Codex-activation window), parse
# {severity, title, path}, cluster into 9 defect classes, rank by
# count × severity-weight (P1=2, P2=1), and write the durable artifact
# docs/reference/codex-defect-classes.md.
#
# Re-run cadence: quarterly, or when corrective-build rate ticks up.
#
# Usage:
#   bash scripts/mine-codex-comments.sh
#
# Requirements:
#   - gh CLI authenticated with read access to this repo
#   - jq (used internally by gh --jq)
#   - xargs, grep, sed (standard POSIX)
#
# Safety invariant: do NOT use eval, bash -c, or sh -c over variable content.
# This script mines shell-eval safety defects; it must not contain one.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTPUT_FILE="$REPO_ROOT/docs/reference/codex-defect-classes.md"
CODEX_WINDOW_MIN=47

# ---------------------------------------------------------------------------
# parse_comment_line <body>
#   Parses the first badge line of a Codex comment body.
#   Outputs a tab-separated "SEVERITY\tTITLE" line, or empty if no match.
#
#   Expected badge shape (confirmed live on PRs #332, #334, #337):
#   **<sub><sub>![P1 Badge](url)</sub></sub>  Title text here**
# ---------------------------------------------------------------------------
parse_comment_line() {
  local body="$1"
  # Extract just the first line of the body for parsing
  local firstline
  firstline=$(printf '%s' "$body" | head -n 1)

  # Quick prefilter: must contain a P1 or P2 badge reference
  if ! printf '%s' "$firstline" | grep -qE '\[P[12] Badge\]'; then
    return 0
  fi

  # Extract severity and title via sed substitution.
  # Pattern: ..![P{1,2} Badge](url)</sub></sub>  Title text**
  local parsed
  parsed=$(printf '%s' "$firstline" \
    | sed -E 's/.*!\[(P[12]) Badge\][^)]*\)<\/sub><\/sub>[[:space:]]+([^*]+)\*\*.*/\1\t\2/')

  # Validate: substitution succeeded only if result differs from input
  # (sed returns input unchanged when pattern doesn't match)
  if printf '%s' "$parsed" | grep -q $'\t'; then
    # Trim trailing whitespace from title field
    printf '%s' "$parsed" | sed 's/[[:space:]]*$//'
  fi
}

# ---------------------------------------------------------------------------
# cluster_title <title>
#   Maps a defect title to a class number (1-9) via keyword matching.
#   Returns "0" if no class matches (unclassified).
#
#   Class keyword buckets (case-insensitive):
#     1 board/state:    board|wave-gate|finalize|terminal|flow-event|precedence|normalize|profile lookup
#     2 path/dir:       path|dir|CANON_PROJECT_DIR|pluginDir|ESM|primer dir|project root
#     3 scope:          scope|boundary|restrict|too (wide|broad|narrow)|worktree exception
#     4 validation:     validat|guard|missing|raise|assert|verify-before|robust-to-concurrent
#     5 shell/eval:     shell|git|eval|tokenize|quoted|subshell|destructive|strip command|evaluator
#     6 grep/awk/fence: grep|awk|regex|anchor|frontmatter|fence
#     7 concurrency:    concurren|transaction|race|serialize|atomic|session-scoped
#     8 tool-wiring:    wire|schema|args|resolve_agent_skills|show_pr_impact|diff_base
#     9 return-shape:   return|empty|state_artifacts|non-empty
# ---------------------------------------------------------------------------
cluster_title() {
  local title="$1"
  local title_lower
  title_lower=$(printf '%s' "$title" | tr '[:upper:]' '[:lower:]')

  # Class 5: shell/eval safety — check early to avoid git false-positives in class 1
  if printf '%s' "$title_lower" | grep -qE 'shell|eval|tokenize|quoted|subshell|destructive|strip command|evaluator|passed to shell|subcommand|command prefix|git token'; then
    printf '5'
    return 0
  fi

  # Class 1: board/state persistence & ordering
  if printf '%s' "$title_lower" | grep -qE 'board|wave.?gate|finalize|terminal|flow.?event|precedence|normalize|profile lookup|dag|wave|claim|shipped|mark.*ship|mark.*complet|journal|sequence|downstream|emit|ordering|flow state|step.*order'; then
    printf '1'
    return 0
  fi

  # Class 2: path/dir resolution
  if printf '%s' "$title_lower" | grep -qE 'path|dir|canon_project_dir|plugindir|esm|primer dir|project root|root|plugin|symlink|install|boot|real path|data root|node_modules'; then
    printf '2'
    return 0
  fi

  # Class 3: scope/boundary
  if printf '%s' "$title_lower" | grep -qE 'scope|boundary|restrict|too wide|too broad|too narrow|worktree exception|layer|prune|exclude|broaden|narrow|parity|verdict rule'; then
    printf '3'
    return 0
  fi

  # Class 4: validation/guard
  if printf '%s' "$title_lower" | grep -qE 'validat|guard|missing|raise|assert|verify.before|robust.to.concurrent|check|skip|abort|probe|detect|require|preserve|respect|filter|before (running|applying|treating|registering|waiting)'; then
    printf '4'
    return 0
  fi

  # Class 6: grep/awk/regex/fence boundary
  if printf '%s' "$title_lower" | grep -qE 'grep|awk|regex|anchor|frontmatter|fence|pattern|match'; then
    printf '6'
    return 0
  fi

  # Class 7: concurrency/transaction/race
  if printf '%s' "$title_lower" | grep -qE 'concurren|transaction|race|serialize|atomic|session.scoped|session|active|still active'; then
    printf '7'
    return 0
  fi

  # Class 8: tool-wiring schema/args
  if printf '%s' "$title_lower" | grep -qE 'wire|schema|args|resolve_agent_skills|show_pr_impact|diff_base|expose|mcp|through.*tool|tool.*list|through.*schema|through.*review'; then
    printf '8'
    return 0
  fi

  # Class 9: return-shape/empty handling
  if printf '%s' "$title_lower" | grep -qE 'return|empty|state_artifacts|non-empty'; then
    printf '9'
    return 0
  fi

  # Unclassified
  printf '0'
  return 0
}

# ---------------------------------------------------------------------------
# class_name <class_number>
#   Returns the human-readable name for a defect class number.
# ---------------------------------------------------------------------------
class_name() {
  case "$1" in
    0) printf 'unclassified' ;;
    1) printf 'board/state persistence & ordering' ;;
    2) printf 'path/dir resolution' ;;
    3) printf 'scope/boundary too broad-or-narrow' ;;
    4) printf 'validation / guard bad-or-missing input' ;;
    5) printf 'shell/git tokenize & eval safety' ;;
    6) printf 'grep/awk/regex/fence boundary' ;;
    7) printf 'concurrency / transaction / race' ;;
    8) printf 'tool-wiring (schema/args/call)' ;;
    9) printf 'return-shape / empty handling' ;;
    *) printf 'unknown (class %s)' "$1" ;;
  esac
}

# ---------------------------------------------------------------------------
# unclassified_title
#   Placeholder function for test clarity — no-op (cluster_title returns 0).
# ---------------------------------------------------------------------------
unclassified_title() {
  : # no-op; tests call this for readability before testing a no-match title
}

# ---------------------------------------------------------------------------
# classify_gh_failure <exit_code> <stderr_text>
#   Classifies a non-zero gh api exit as "skip" (404/not-found — acceptable)
#   or "abort" (rate-limit, auth, 5xx, network — real failure).
#   Prints "skip" or "abort". Exit code is always 0 (pure classifier).
#
#   Exported so the xargs wrapper can source it alongside fetch_pr_comments.
# ---------------------------------------------------------------------------
classify_gh_failure() {
  local _exit_code="$1"  # reserved for future numeric checks; classification driven by stderr text
  local stderr_text="$2"

  # HTTP 404 / resource not found — PR or its comments were deleted.
  # Acceptable: mine should keep running over remaining PRs.
  if printf '%s' "$stderr_text" | grep -qiE 'HTTP 404|not found|No such'; then
    printf 'skip'
    return 0
  fi

  # Any other non-zero exit is a real failure: rate-limit (HTTP 429),
  # auth/scope error (HTTP 401/403), server error (HTTP 5xx), network failure, etc.
  printf 'abort'
  return 0
}
export -f classify_gh_failure

# ---------------------------------------------------------------------------
# fetch_pr_comments <pr_number>
#   Pulls Codex bot review comments for one PR and prints tab-separated
#   "PATH\tBODY" rows. One row per comment.
#   Called by xargs -P 8 worker (exported below).
#
#   Fail-closed: any non-404 gh api failure exits non-zero so the xargs
#   worker signals failure, causing the main script to abort before writing
#   the output artifact from a silently-partial corpus.
#   Only HTTP 404 (deleted PR / comments) is skipped quietly.
#   The xargs wrapper sources this script, so explicit export -f is not
#   required — but classify_gh_failure is exported for clarity.
# ---------------------------------------------------------------------------
fetch_pr_comments() {
  local pr_num="$1"
  local tmp_out tmp_err failure_class
  local gh_exit=0
  tmp_out=$(mktemp)
  tmp_err=$(mktemp)

  # Filter is inline in jq to avoid --arg flag incompatibility with gh api --jq
  # Initialize gh_exit=0 before; capture real exit in || clause so set -e does not
  # fire here (we handle failure explicitly below).
  gh api "repos/:owner/:repo/pulls/${pr_num}/comments" \
    --paginate \
    --jq '.[] | select(.user.login=="chatgpt-codex-connector[bot]") | [.path, .body] | @tsv' \
    > "$tmp_out" 2> "$tmp_err" || gh_exit=$?

  if [[ $gh_exit -eq 0 ]]; then
    cat "$tmp_out"
    rm -f "$tmp_out" "$tmp_err"
    return 0
  fi

  # Non-zero exit: classify to decide whether to skip or abort.
  failure_class=$(classify_gh_failure "$gh_exit" "$(cat "$tmp_err")")

  if [[ "$failure_class" == "skip" ]]; then
    # 404 / deleted PR — acceptable; skip this PR quietly.
    rm -f "$tmp_out" "$tmp_err"
    return 0
  fi

  # Real failure (rate-limit, auth, 5xx, network) — emit error and abort the worker.
  >&2 printf 'ERROR: gh api failed (exit %d) for PR #%s\n' "$gh_exit" "$pr_num"
  >&2 cat "$tmp_err"
  rm -f "$tmp_out" "$tmp_err"
  return 1  # non-zero exit propagates through xargs → aborts main before corpus write
}

# ---------------------------------------------------------------------------
# MAIN — only runs when script is executed directly (not sourced by tests)
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then

  # ---- Preflight: verify gh is available and authenticated ----
  if ! command -v gh >/dev/null 2>&1; then
    >&2 echo "ERROR: gh CLI not found on PATH. Install the GitHub CLI and retry."
    exit 1
  fi

  if ! gh auth status >/dev/null 2>&1; then
    >&2 echo "ERROR: gh is not authenticated. Run 'gh auth login' first."
    >&2 echo "       Unauthenticated rate limits (60 req/hr) are insufficient for this mine (~275 calls)."
    exit 1
  fi

  >&2 echo "=== Codex comment mine starting ==="
  >&2 echo "    Artifact: $OUTPUT_FILE"

  # ---- Enumerate merged PRs in the Codex window ----
  # Use paginated REST API instead of --limit to ensure the full corpus is fetched
  # as the repo grows beyond any fixed cap. Pages of 100 are fetched until a page
  # returns fewer than 100 results (last page) or all numbers fall below the window
  # minimum (early stop — REST API returns newest first).
  >&2 echo "    Fetching merged PR list (paginated)..."
  PR_LIST=""
  _page=1
  _per_page=100
  while true; do
    # Fetch raw page: capture ALL closed PR numbers (merged + unmerged) so we can
    # determine the true raw page size for last-page detection, then filter to
    # merged-only for the corpus. Without the raw count, a page of 100 closed PRs
    # with 99 merged looks like 99 results (<100), causing premature loop exit and
    # silently dropping all older merged PRs.
    _raw_page=$(gh api \
      "repos/:owner/:repo/pulls?state=closed&per_page=${_per_page}&page=${_page}" \
      --jq '[.[] | .number] | .[]')
    # Count raw items on this page BEFORE any merged-filter to detect last page.
    _raw_count=$(printf '%s\n' "$_raw_page" | grep -c '[0-9]' || true)
    # Filter to merged PRs only for the corpus.
    _batch=$(gh api \
      "repos/:owner/:repo/pulls?state=closed&per_page=${_per_page}&page=${_page}" \
      --jq '[.[] | select(.merged_at != null) | .number] | .[]')
    # Apply window filter to this batch
    _batch_in_window=$(printf '%s\n' "$_batch" \
      | awk -v min="$CODEX_WINDOW_MIN" '$1 >= min')
    if [[ -n "$_batch_in_window" ]]; then
      PR_LIST="${PR_LIST}${_batch_in_window}"$'\n'
    fi
    # Early stop: if the smallest number in this raw page is below the window minimum,
    # all subsequent pages (older PRs) will also be below — no need to continue.
    _batch_min=$(printf '%s\n' "$_raw_page" | grep '[0-9]' | sort -n | head -1)
    if [[ $_raw_count -lt $_per_page ]]; then
      # Last page (raw item count < per_page) — no more results
      break
    fi
    if [[ -n "$_batch_min" && "$_batch_min" -lt "$CODEX_WINDOW_MIN" ]]; then
      # Passed the window boundary — all remaining pages are older
      break
    fi
    _page=$((_page + 1))
  done
  # Trim trailing blank lines and deduplicate (pages shouldn't overlap, but be safe)
  PR_LIST=$(printf '%s\n' "$PR_LIST" | grep '[0-9]' | sort -rn | uniq)

  PR_COUNT=$(printf '%s\n' "$PR_LIST" | grep -c '[0-9]' || true)
  >&2 echo "    PRs in window (#${CODEX_WINDOW_MIN}+): $PR_COUNT"

  # ---- Pull comments in parallel via xargs -P 8 ----
  # Each worker writes its output to a dedicated temp file (keyed by PR number)
  # rather than streaming to shared stdout. With -P 8, concurrent cat "$tmp_out"
  # calls interleave on the parent's stdin, producing malformed TSV rows where
  # path and body columns from different PRs can be spliced together. Serializing
  # via per-worker files and concatenating in order after xargs completes
  # eliminates the race entirely.
  TMPDIR_MINE=$(mktemp -d)
  WRAPPER="$TMPDIR_MINE/fetch-one-pr.sh"
  # Worker writes to TMPDIR_MINE/<pr_number>.tsv so outputs are never interleaved.
  printf '#!/bin/bash\nset -euo pipefail\nsource %s\nfetch_pr_comments "$1" > %s/"$1".tsv\n' \
    "$SCRIPT_DIR/mine-codex-comments.sh" "$TMPDIR_MINE" > "$WRAPPER"
  chmod +x "$WRAPPER"

  >&2 echo "    Pulling Codex comments (parallel -P 8)..."
  printf '%s\n' "$PR_LIST" | xargs -P 8 -n 1 "$WRAPPER"

  # Concatenate per-worker files in PR-number order for a deterministic, well-formed TSV.
  RAW_COMMENTS=""
  while IFS= read -r _pr_num; do
    _worker_file="$TMPDIR_MINE/${_pr_num}.tsv"
    if [[ -f "$_worker_file" ]]; then
      RAW_COMMENTS="${RAW_COMMENTS}$(cat "$_worker_file")"$'\n'
    fi
  done < <(printf '%s\n' "$PR_LIST" | grep '[0-9]')

  rm -rf "$TMPDIR_MINE"

  COMMENT_COUNT=$(printf '%s\n' "$RAW_COMMENTS" | grep -c $'\t' || true)
  >&2 echo "    Raw comment rows fetched: $COMMENT_COUNT"

  # ---- Parse each comment body's first line ----
  # RAW_COMMENTS is PATH\tBODY per line. We need the body portion.
  PARSED_LINES=""
  PARSE_COUNT=0

  while IFS=$'\t' read -r _path body; do
    [[ -z "$body" ]] && continue
    parsed=$(parse_comment_line "$body")
    if [[ -n "$parsed" ]]; then
      PARSED_LINES="${PARSED_LINES}${parsed}"$'\n'
      PARSE_COUNT=$((PARSE_COUNT + 1))
    fi
  done <<< "$RAW_COMMENTS"

  >&2 echo "    Parsed badge comments: $PARSE_COUNT"

  # Fail-closed: if we have raw comments but parsed zero badges, Codex's badge
  # format has drifted. Overwriting the artifact with zeroed counts would silently
  # erase the mined evidence. Exit non-zero before any write (scripts/.claude/CLAUDE.md:
  # "never write a partial or empty artifact — if any step fails, exit before writing output").
  if [[ "$COMMENT_COUNT" -gt 0 && "$PARSE_COUNT" -eq 0 ]]; then
    >&2 echo "ERROR: Found $COMMENT_COUNT raw comment rows but 0 parsed badges."
    >&2 echo "       Codex comment badge format may have changed. Refusing to overwrite"
    >&2 echo "       $OUTPUT_FILE with empty results."
    >&2 echo "       Inspect parse_comment_line() and update the badge regex to match"
    >&2 echo "       the current format before re-running."
    exit 1
  fi

  # ---- Cluster, rank, and accumulate in one awk pass ----
  # Uses a temp dir for per-class citation files (bash 3 compatible — no declare -A).
  STATS_DIR=$(mktemp -d)

  # Write parsed lines to a temp file for awk processing
  PARSED_FILE="$STATS_DIR/parsed.tsv"
  printf '%s' "$PARSED_LINES" > "$PARSED_FILE"

  # Cluster each line and write class-tagged lines for awk
  # Format: CLASS\tSEVERITY\tTITLE
  CLASSIFIED_FILE="$STATS_DIR/classified.tsv"
  while IFS=$'\t' read -r severity title; do
    [[ -z "$severity" || -z "$title" ]] && continue
    class=$(cluster_title "$title")
    printf '%s\t%s\t%s\n' "$class" "$severity" "$title"
  done < "$PARSED_FILE" > "$CLASSIFIED_FILE"

  # Count lines for progress
  LINE_NUM=$(grep -c '.' "$CLASSIFIED_FILE" 2>/dev/null || printf '0')  # DOCUMENTED FAIL-OPEN -- empty file returns 0
  UNCLASSIFIED=$(grep -c '^0\t' "$CLASSIFIED_FILE" 2>/dev/null || printf '0')  # DOCUMENTED FAIL-OPEN -- no class-0 returns 0
  >&2 echo "    Clustered: $LINE_NUM comments, $UNCLASSIFIED unclassified"

  # Use awk to compute counts, p1 counts, and scores; capture first 3 citations per class
  # Output format: CLASS TOTAL P1 SCORE CITATION1|CITATION2|CITATION3
  RANKED=$(awk -F'\t' '
    {
      cls=$1; sev=$2; title=$3
      count[cls]++
      if (sev=="P1") p1[cls]++
      if (citecount[cls]<3) {
        if (length(cites[cls])>0) cites[cls]=cites[cls] "|"
        cites[cls]=cites[cls] title
        citecount[cls]++
      }
    }
    END {
      for (c=1; c<=9; c++) {
        total=count[c]+0
        n_p1=p1[c]+0
        n_p2=total-n_p1
        score=n_p1*2+n_p2
        printf "%d\t%d\t%d\t%d\t%s\n", c, total, n_p1, score, cites[c]
      }
    }
  ' "$CLASSIFIED_FILE" | sort -t$'\t' -k4,4rn)

  # ---- Write the artifact ----
  >&2 echo "    Writing $OUTPUT_FILE..."
  {
    printf '# Codex Defect Classes — Frequency-Ranked Evidence\n\n'
    printf '> **Mine command**: `bash scripts/mine-codex-comments.sh`\n'
    printf '> **Re-run cadence**: Quarterly, or when the corrective-build rate ticks up (>20%% of recent builds are "address-codex" rework).\n'
    printf '> **Upgrade trigger**: If the ranked class order shifts significantly across two consecutive re-runs, consider promoting the top volatile class to a standing learner dimension (per codex-preempt-04 Decision D4).\n'
    printf '> **Source**: Every `chatgpt-codex-connector[bot]` review comment across merged PRs #%d+ (the Codex-activation window).\n\n' "$CODEX_WINDOW_MIN"

    printf '## Ranked Defect Classes\n\n'
    printf '| Rank | Class | Comments | of which P1 | Score (P1×2 + P2×1) |\n'
    printf '|------|-------|----------|-------------|---------------------|\n'

    rank=1
    while IFS=$'\t' read -r c total p1 score _cites; do
      name=$(class_name "$c")
      printf '| %d | **%s** (class %d) | %d | %d | %d |\n' \
        "$rank" "$name" "$c" "$total" "$p1" "$score"
      rank=$((rank + 1))
    done <<< "$RANKED"

    printf '\n## Per-Class Details\n\n'

    while IFS=$'\t' read -r c total p1 score cites; do
      name=$(class_name "$c")
      p2=$((total - p1))
      printf '### Class %d: %s\n\n' "$c" "$name"
      printf '**Comments**: %d total (%d P1, %d P2) | **Score**: %d\n\n' \
        "$total" "$p1" "$p2" "$score"

      # Encoding and wiring notes
      case "$c" in
        1) printf '**Encoding**: PROMPT — judgment: wave-gate precedence, finalize/terminal-state transitions, flow-event override ordering, read-before-write on board state.\n\n' ;;
        2) printf '**Encoding**: PROMPT + light grep hint — judgment on project-root vs plugin-dir resolution; grep hint for ESM `__dirname`/`import.meta` and hardcoded `CANON_PROJECT_DIR`.\n\n' ;;
        3) printf '**Encoding**: PROMPT — judgment: is a guard/exception/pathspec scoped to exactly its declared surface?\n\n' ;;
        4) printf '**Encoding**: PROMPT — judgment: raise/return on missing state, verify-before-act, robust-to-concurrent-init.\n\n' ;;
        5) printf '**Encoding**: GREP — diff-deterministic flag for string-executing wrappers (`eval`, `bash -c`, `sh -c`) over interpolated variables.\n\n' ;;
        6) printf '**Encoding**: GREP — flag unanchored frontmatter `awk`/`grep` patterns; short fences around embedded prompts.\n\n' ;;
        7) printf '**Encoding**: PROMPT — judgment: serialize board read+write, same-transaction reads, atomic init, session-scoped jobs.\n\n' ;;
        8) printf '**Encoding**: NOT WIRED — already covered by reviewer Stage 2 "Agent to Tool Reachability" and "Discriminant Surface Parity". Wiring again is redundant. Listed here so a re-miner sees it is handled.\n\n' ;;
        9) printf '**Encoding**: NOT WIRED — below noise cut (lowest volume, P1=1). Listed for completeness; revisit if a re-run re-ranks it higher.\n\n' ;;
      esac

      # Citation lines (pipe-separated, split back out)
      if [[ -n "$cites" ]]; then
        printf '**Sample findings**:\n\n'
        printf '%s' "$cites" | tr '|' '\n' | while IFS= read -r cite; do
          [[ -n "$cite" ]] && printf '%s\n' "- *${cite}*"
        done
        printf '\n'
      else
        printf '_No citation samples recorded._\n\n'
      fi
    done <<< "$RANKED"

    printf '## Mining Metadata\n\n'
    printf '%s\n' "- PRs in window: ${PR_COUNT}"
    printf '%s\n' "- Raw Codex comment rows: ${COMMENT_COUNT}"
    printf '%s\n' "- Parsed badge comments: ${PARSE_COUNT}"
    printf '%s\n' "- Unclassified: ${UNCLASSIFIED}"
    printf '%s\n' "- Mine date: $(date -u '+%Y-%m-%d')"

  } > "$OUTPUT_FILE"

  rm -rf "$STATS_DIR"

  >&2 echo "=== Mine complete ==="
  >&2 echo "    Output: $OUTPUT_FILE"

fi
