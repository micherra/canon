#!/bin/bash
# tail-enforcement-gate.sh — Stop hook: deterministic tail-enforcement gate (delta D3)
#
# SAFETY gate. Blocks a Canon build session from ending when its tail steps
# (context-sync, learn) did not run and were not legitimately skipped — a
# harness-fired backstop that holds regardless of orchestrator cooperation
# (see ADR-0038 / decisions/d3-01.md, d3-02.md).
#
# Registered under the "Stop" event in hooks.json — fires at the end of
# EVERY main-agent turn (not just at build completion). False positives on
# chat / mid-build / other-session stops are avoided by a deliberately
# conservative (fail-OPEN) detection posture: only a session-matched, shipped
# build with a resolvable, non-doc-only diff reaches the tail check. The
# tail-check ENFORCEMENT itself fails CLOSED: any inability to prove the tail
# ran (missing jq, unparseable journal, unreadable allowlist, missing/empty/
# non-accepted skip_reason, missing tail step) blocks.
#
# Gate logic (see PLAN §Action / DESIGN.md for full rationale):
#   1. Loop-guard: stop_hook_active == true → exit 0 (never re-block).
#   2. Resolve project root via `git -C "$cwd" rev-parse --show-toplevel`.
#      Not a git repo → exit 0 (fail-open: nothing to guard).
#   3. Scan .canon/workspaces/*/*/journal.json for one whose OWN persisted
#      session_id matches the Stop event's session_id (journal.json survives
#      finalize_workspace's unconditional .lock release — see DESIGN.md "Why
#      journal.json is the right carrier" — so it, not .lock, is the durable
#      signal). No match → exit 0 (fail-open: non-build / chat / other-session
#      stop, OR a session-matched journal that is itself unparseable — an
#      accepted identity gap ADR-0038 already documents).
#   4. Read the matched journal. ship != completed → exit 0 (fail-open:
#      mid-build, including every plan-approval / review HITL pause).
#   5. Doc-only diff skip: worktree diff against the default branch is
#      entirely .md/.txt → exit 0. Worktree missing → skip this check and
#      proceed to enforce (fail-CLOSED: cannot prove doc-only).
#   6. Tail check: context-sync and learn must each be status=="completed",
#      OR status=="skipped" with a skip_reason that whole-line-matches
#      hooks/lib/accepted-skip-reasons.txt (the single machine authority —
#      no hardcoded second copy). Missing step / empty reason / non-accepted
#      reason are violations.
#   7. Violations → emit {"decision":"block","reason":"..."} and exit 0.
#      No violations → exit 0.
#
# Blocking is signalled via the JSON decision:block form (exit 0), not via
# exit code 2 — both are valid per the Stop-hook contract (PROBE-FINDINGS
# P1); this gate uses the JSON form throughout, including its fail-closed
# sites, so "exit 0" alone never implies "passed" — callers/tests must
# inspect stdout for a "decision" key.
#
# Fail-closed sites (hooks-fail-closed / hooks-observable-failures):
#   - jq not found            → CANON WARNING + block, emitted WITHOUT jq
#     (a hardcoded, JSON-special-char-free literal reason — see step 0 below;
#     block()'s own jq-based escaping cannot be used here without dying first)
#   - journal.json unparseable (post-match, TOCTOU race backstop) → CANON
#     WARNING + block
#   - allowlist file unreadable → CANON WARNING + block
#   - worktree missing at doc-only-check time → skip that check, proceed to
#     enforce (documented in step 5 above)
#
# Scope negatives: does not change which HITL gates any tier skips (that is
# a separate delta, D1); does not expand the accepted skip_reason set beyond
# hooks/lib/accepted-skip-reasons.txt.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/canon-hook-lib.sh
source "$SCRIPT_DIR/lib/canon-hook-lib.sh"

ALLOWLIST_FILE="$SCRIPT_DIR/lib/accepted-skip-reasons.txt"

# ---------------------------------------------------------------------------
# block <reason>
# Emits the Stop-hook JSON block decision and exits 0 (per the JSON-block
# form of the documented Stop-hook contract — see PROBE-FINDINGS P1).
# ---------------------------------------------------------------------------
block() {
  local reason="$1"
  local reason_json
  reason_json=$(printf '%s' "$reason" | jq -Rs .)
  printf '{"decision":"block","reason":%s}\n' "$reason_json"
  exit 0
}

# ---------------------------------------------------------------------------
# Step 0 (prerequisite): jq is required to parse the Stop payload, the
# journal, and the allowlist. Without it we cannot PROVE the tail ran —
# fail CLOSED (hooks-fail-closed).
#
# block() itself depends on jq (`jq -Rs .` to escape the reason) — calling it
# here would die at exit 127 under `set -euo pipefail` BEFORE any JSON reaches
# stdout, silently defeating the documented fail-closed behavior (the one case
# where the gate cannot verify the tail is exactly the case it would fail to
# block — see PROBE-FINDINGS.md). Emit the block JSON directly instead, with a
# hardcoded literal reason containing no JSON-special characters (no `"`, `\`,
# or control chars) so no escaping is needed.
# ---------------------------------------------------------------------------
if ! command -v jq >/dev/null 2>&1; then
  echo "CANON WARNING: [tail-enforcement-gate] jq not found — cannot verify tail; blocking fail-closed." >&2
  printf '%s\n' '{"decision":"block","reason":"jq unavailable: cannot verify context-sync/learn tail ran."}'
  exit 0
fi

INPUT=$(cat)

STOP_SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- missing session_id is treated as no active-build match below
STOP_CWD=$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- missing cwd means no repo root to resolve, handled below
STOP_HOOK_ACTIVE=$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- missing flag defaults to false (proceed to detection)

# ---------------------------------------------------------------------------
# Step 1: loop-guard — never re-block on the post-block re-fire.
# ---------------------------------------------------------------------------
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 2: resolve project root for this Stop event's cwd.
# ---------------------------------------------------------------------------
if [[ -z "$STOP_CWD" ]]; then
  exit 0 # DOCUMENTED FAIL-OPEN -- no cwd in the Stop payload; nothing to guard
fi

ROOT=$(git -C "$STOP_CWD" rev-parse --show-toplevel 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- not a git repo, no build to guard
if [[ -z "$ROOT" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 3: find the active build for THIS session via journal.session_id
# match. journal.json (not .lock) is the durable signal — finalize_workspace
# releases .lock unconditionally BEFORE this gate's ship==completed trigger
# can ever fire, but never deletes journal.json (only copies it to the
# archive) — see DESIGN.md "Why journal.json is the right carrier".
# ---------------------------------------------------------------------------
shopt -s nullglob
JOURNALS=("$ROOT"/.canon/workspaces/*/*/journal.json)
shopt -u nullglob

MATCHED_WORKSPACE=""
if [[ -n "$STOP_SESSION_ID" ]]; then
  for j in "${JOURNALS[@]+"${JOURNALS[@]}"}"; do
    journal_session=$(jq -r '.session_id // empty' < "$j" 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- unparseable/absent journal session_id treated as no-match
    if [[ -n "$journal_session" ]] && [[ "$journal_session" == "$STOP_SESSION_ID" ]]; then
      MATCHED_WORKSPACE="$(dirname "$j")"
      break
    fi
  done
fi

if [[ -z "$MATCHED_WORKSPACE" ]]; then
  exit 0 # AC#3: no session-matched build — non-build / chat / other-session stop, or an unresolvable (unparseable) journal identity, no-op
fi

JOURNAL_FILE="$MATCHED_WORKSPACE/journal.json"

# ---------------------------------------------------------------------------
# Journal parseability: a session-matched workspace whose journal cannot be
# parsed means we cannot PROVE the tail ran (or that the build isn't shipped
# yet) — fail CLOSED.
# ---------------------------------------------------------------------------
if ! jq -e . "$JOURNAL_FILE" >/dev/null 2>&1; then
  echo "CANON WARNING: [tail-enforcement-gate] journal.json unparseable at $JOURNAL_FILE — blocking fail-closed." >&2
  block "journal.json is unparseable — cannot verify context-sync/learn tail ran."
fi

# ---------------------------------------------------------------------------
# Step 4: terminal-moment trigger — only act once ship has completed.
# ---------------------------------------------------------------------------
SHIP_STATUS=$(jq -r '(.steps[]? | select(.step_id == "ship") | .status) // empty' "$JOURNAL_FILE" 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- absent ship step treated as not-completed (mid-build no-op)

if [[ "$SHIP_STATUS" != "completed" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 5: doc-only diff skip.
# ---------------------------------------------------------------------------
WT="$MATCHED_WORKSPACE/worktree"
DOC_ONLY=0

if [[ -d "$WT" ]]; then
  DEFAULT_BRANCH=$(git -C "$WT" rev-parse --abbrev-ref origin/HEAD 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- unresolved origin/HEAD falls back to the "main" literal below
  DEFAULT_BRANCH="${DEFAULT_BRANCH#origin/}"
  if [[ -z "$DEFAULT_BRANCH" ]] || [[ "$DEFAULT_BRANCH" == "HEAD" ]]; then
    DEFAULT_BRANCH="main"
  fi

  MERGE_BASE=$(git -C "$WT" merge-base HEAD "$DEFAULT_BRANCH" 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- unresolvable merge-base treated as non-doc-only (proceed to enforce)

  if [[ -n "$MERGE_BASE" ]]; then
    CHANGED_FILES=$(git -C "$WT" diff --name-only "$MERGE_BASE"..HEAD 2>/dev/null || true) # DOCUMENTED FAIL-OPEN -- diff failure treated as non-doc-only (proceed to enforce)
    if [[ -n "$CHANGED_FILES" ]]; then
      DOC_ONLY=1
      while IFS= read -r f; do
        [[ -z "$f" ]] && continue
        if ! [[ "$f" =~ \.(md|txt)$ ]]; then
          DOC_ONLY=0
          break
        fi
      done <<< "$CHANGED_FILES"
    fi
  fi
else
  : # DOCUMENTED FAIL-CLOSED -- worktree gone, cannot prove doc-only; DOC_ONLY stays 0, proceed to enforce
fi

if [[ "$DOC_ONLY" -eq 1 ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Step 6: tail check (fail-closed).
# ---------------------------------------------------------------------------
if [[ ! -r "$ALLOWLIST_FILE" ]]; then
  echo "CANON WARNING: [tail-enforcement-gate] allowlist file unreadable at $ALLOWLIST_FILE — blocking fail-closed." >&2
  block "accepted skip_reason allowlist unreadable — cannot verify context-sync/learn tail ran."
fi

VIOLATIONS=()

for step_id in context-sync learn; do
  STEP_JSON=$(jq -c --arg sid "$step_id" '(.steps[]? | select(.step_id == $sid))' "$JOURNAL_FILE" 2>/dev/null || true) # DOCUMENTED FAIL-CLOSED -- unparseable step selection treated as a missing step (violation) below

  if [[ -z "$STEP_JSON" ]]; then
    VIOLATIONS+=("$step_id: missing")
    continue
  fi

  STATUS=$(printf '%s' "$STEP_JSON" | jq -r '.status // empty')

  if [[ "$STATUS" == "completed" ]]; then
    continue
  fi

  if [[ "$STATUS" == "skipped" ]]; then
    SKIP_REASON=$(printf '%s' "$STEP_JSON" | jq -r '.skip_reason // empty')
    if [[ -z "$SKIP_REASON" ]]; then
      VIOLATIONS+=("$step_id: empty skip_reason")
    elif grep -qxF "$SKIP_REASON" "$ALLOWLIST_FILE"; then
      continue
    else
      VIOLATIONS+=("$step_id: non-accepted skip_reason \"$SKIP_REASON\"")
    fi
    continue
  fi

  VIOLATIONS+=("$step_id: status=${STATUS:-missing}")
done

# ---------------------------------------------------------------------------
# Step 7: decision.
# ---------------------------------------------------------------------------
if [[ "${#VIOLATIONS[@]}" -gt 0 ]]; then
  JOINED=""
  for v in "${VIOLATIONS[@]+"${VIOLATIONS[@]}"}"; do
    if [[ -z "$JOINED" ]]; then
      JOINED="$v"
    else
      JOINED="$JOINED; $v"
    fi
  done
  block "Canon tail incomplete: ${JOINED}. Run context-sync/learn or record an accepted skip_reason before ending."
fi

exit 0
