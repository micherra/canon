#!/bin/bash
# Canon Post-Merge Workspace Cleanup Hook
#
# Automatically archives and removes Canon workspaces for branches that have
# been merged into main/master. Run this after merging a feature branch to
# keep your .canon/workspaces/ directory tidy.
#
# INSTALL:
#   Run ./hooks/install-git-hooks.sh from the repo root. That script will
#   symlink this file into .git/hooks/post-merge (or append a call to it
#   if a post-merge hook already exists).
#
# MANUAL INSTALL:
#   ln -sf "$(pwd)/hooks/post-merge-cleanup.sh" .git/hooks/post-merge
#   chmod +x .git/hooks/post-merge
#
# WHAT IT DOES:
#   1. After a merge into main/master, finds local branches that are now
#      fully merged (git branch --merged).
#   2. For each merged branch, archives decisions/ and notes/ from every
#      task workspace under .canon/workspaces/{sanitized-branch}/ into
#      .canon/history/{sanitized-branch}/, generates archive-meta.json and
#      summary.md, then deletes the workspace directory.
#   3. Deletes the local branch with `git branch -d` (safe — git refuses if
#      not fully merged).
#   4. Prints a summary of everything that was cleaned.
#
# SAFETY:
#   - Only runs when the current branch is main or master.
#   - Uses `git branch -d` (not -D) so unmerged branches are never deleted.
#   - Skips branches whose workspaces are already absent (idempotent).
#   - Skips if .canon/workspaces/ does not exist.

set -euo pipefail

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Replicate the TypeScript sanitizeBranch() from workspace.ts:
#   replace / with --, replace spaces with -, strip non-alphanumeric/hyphen,
#   lowercase, truncate to 80 chars.
sanitize_branch() {
  echo "$1" \
    | sed 's|/|--|g' \
    | tr ' ' '-' \
    | tr '[:upper:]' '[:lower:]' \
    | tr -cd 'a-z0-9-' \
    | cut -c1-80
}

# Pretty timestamp
now_iso() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

# ---------------------------------------------------------------------------
# Guard: only run on main / master
# ---------------------------------------------------------------------------

CURRENT_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo "")"

if [[ "$CURRENT_BRANCH" != "main" && "$CURRENT_BRANCH" != "master" ]]; then
  # Not on a primary branch — nothing to do.
  exit 0
fi

# ---------------------------------------------------------------------------
# Guard: workspaces directory must exist
# ---------------------------------------------------------------------------

REPO_ROOT="$(git rev-parse --show-toplevel)"
WORKSPACES_DIR="${REPO_ROOT}/.canon/workspaces"
HISTORY_DIR="${REPO_ROOT}/.canon/history"

if [[ ! -d "$WORKSPACES_DIR" ]]; then
  # Canon not set up or no workspaces yet — exit silently.
  exit 0
fi

# ---------------------------------------------------------------------------
# Find fully-merged local branches (excluding HEAD, main, master)
# ---------------------------------------------------------------------------

MERGED_BRANCHES=()
while IFS= read -r branch; do
  # git branch --merged prints a leading "* " for current branch or "  " prefix
  branch="${branch#\* }"   # strip leading "* " (shouldn't appear since we're on main)
  branch="${branch#  }"    # strip leading "  "
  branch="${branch## }"    # strip any remaining leading spaces
  branch="${branch%% }"    # strip trailing spaces

  # Skip blank, main, master, and HEAD entries
  if [[ -z "$branch" ]] \
    || [[ "$branch" == "main" ]] \
    || [[ "$branch" == "master" ]] \
    || [[ "$branch" == "(HEAD detached"* ]]; then
    continue
  fi

  MERGED_BRANCHES+=("$branch")
done < <(git branch --merged 2>/dev/null || true)

if [[ ${#MERGED_BRANCHES[@]} -eq 0 ]]; then
  # Nothing to clean up.
  exit 0
fi

# ---------------------------------------------------------------------------
# Process each merged branch
# ---------------------------------------------------------------------------

CLEANED=()
SKIPPED=()

for BRANCH in "${MERGED_BRANCHES[@]}"; do
  SANITIZED="$(sanitize_branch "$BRANCH")"
  WORKSPACE_PATH="${WORKSPACES_DIR}/${SANITIZED}"

  echo "Canon: processing merged branch '${BRANCH}' (workspace: ${SANITIZED})"

  # ------------------------------------------------------------------
  # Archive (if workspace exists)
  # ------------------------------------------------------------------

  if [[ -d "$WORKSPACE_PATH" ]]; then
    ARCHIVE_DIR="${HISTORY_DIR}/${SANITIZED}"
    mkdir -p "${ARCHIVE_DIR}/decisions" "${ARCHIVE_DIR}/notes"

    ARCHIVED_AT="$(now_iso)"
    TASK_SLUGS=()

    # Walk every task-slug sub-directory inside the branch workspace
    for TASK_DIR in "${WORKSPACE_PATH}"/*/; do
      [[ -d "$TASK_DIR" ]] || continue
      TASK_SLUG="$(basename "$TASK_DIR")"
      TASK_SLUGS+=("$TASK_SLUG")

      # Copy decisions (merge all task slugs into shared history dir)
      if [[ -d "${TASK_DIR}decisions" ]]; then
        cp -r "${TASK_DIR}decisions/." "${ARCHIVE_DIR}/decisions/" 2>/dev/null || true
      fi

      # Copy notes
      if [[ -d "${TASK_DIR}notes" ]]; then
        cp -r "${TASK_DIR}notes/." "${ARCHIVE_DIR}/notes/" 2>/dev/null || true
      fi
    done

    # Build tasks JSON array for archive-meta.json
    TASKS_JSON="["
    FIRST=true
    for SLUG in "${TASK_SLUGS[@]}"; do
      # Read task description from session.json if available
      SESSION_FILE="${WORKSPACE_PATH}/${SLUG}/session.json"
      TASK_DESC=""
      STATUS_VAL=""
      CREATED_VAL=""
      if [[ -f "$SESSION_FILE" ]]; then
        # Portable extraction without jq dependency
        TASK_DESC="$(grep -o '"task"[[:space:]]*:[[:space:]]*"[^"]*"' "$SESSION_FILE" | head -1 | sed 's/.*"task"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)"
        STATUS_VAL="$(grep -o '"status"[[:space:]]*:[[:space:]]*"[^"]*"' "$SESSION_FILE" | head -1 | sed 's/.*"status"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)"
        CREATED_VAL="$(grep -o '"created"[[:space:]]*:[[:space:]]*"[^"]*"' "$SESSION_FILE" | head -1 | sed 's/.*"created"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)"
      fi
      TASK_DESC="${TASK_DESC:-unknown}"
      STATUS_VAL="${STATUS_VAL:-unknown}"
      CREATED_VAL="${CREATED_VAL:-unknown}"

      if [[ "$FIRST" == "true" ]]; then
        FIRST=false
      else
        TASKS_JSON+=","
      fi
      # Minimal JSON — avoid jq dependency
      TASKS_JSON+="$(printf '{"slug":"%s","task":"%s","status":"%s","created":"%s"}' \
        "$SLUG" \
        "$(echo "$TASK_DESC" | sed 's/"/\\"/g')" \
        "$STATUS_VAL" \
        "$CREATED_VAL")"
    done
    TASKS_JSON+="]"

    # Write archive-meta.json
    cat > "${ARCHIVE_DIR}/archive-meta.json" <<EOF
{
  "archived_at": "${ARCHIVED_AT}",
  "original_branch": "${BRANCH}",
  "sanitized": "${SANITIZED}",
  "tasks": ${TASKS_JSON}
}
EOF

    # Generate summary.md
    {
      echo "## Workspace Archive: ${BRANCH}"
      echo ""
      echo "**Branch**: \`${BRANCH}\`"
      echo "**Sanitized**: \`${SANITIZED}\`"
      echo "**Archived**: ${ARCHIVED_AT}"
      echo ""
      if [[ ${#TASK_SLUGS[@]} -gt 0 ]]; then
        echo "### Tasks (${#TASK_SLUGS[@]})"
        for SLUG in "${TASK_SLUGS[@]}"; do
          SESSION_FILE="${WORKSPACE_PATH}/${SLUG}/session.json"
          if [[ -f "$SESSION_FILE" ]]; then
            TASK_DESC="$(grep -o '"task"[[:space:]]*:[[:space:]]*"[^"]*"' "$SESSION_FILE" | head -1 | sed 's/.*"task"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)"
            STATUS_VAL="$(grep -o '"status"[[:space:]]*:[[:space:]]*"[^"]*"' "$SESSION_FILE" | head -1 | sed 's/.*"status"[[:space:]]*:[[:space:]]*"//;s/"$//' || true)"
            echo "- **${SLUG}**: ${TASK_DESC:-unknown} (${STATUS_VAL:-unknown})"
          else
            echo "- **${SLUG}**"
          fi
        done
        echo ""
      fi

      # Count decisions and notes
      DECISION_COUNT="$(find "${ARCHIVE_DIR}/decisions" -type f 2>/dev/null | wc -l | tr -d ' ')"
      NOTES_COUNT="$(find "${ARCHIVE_DIR}/notes" -type f 2>/dev/null | wc -l | tr -d ' ')"
      echo "### Preserved Artifacts"
      echo "- Decisions: ${DECISION_COUNT} file(s) → \`.canon/history/${SANITIZED}/decisions/\`"
      echo "- Notes: ${NOTES_COUNT} file(s) → \`.canon/history/${SANITIZED}/notes/\`"
    } > "${ARCHIVE_DIR}/summary.md"

    echo "Canon:   archived to .canon/history/${SANITIZED}/"
  else
    echo "Canon:   no workspace found at ${SANITIZED}/ (already clean)"
  fi

  # ------------------------------------------------------------------
  # Delete workspace
  # ------------------------------------------------------------------

  if [[ -d "$WORKSPACE_PATH" ]]; then
    rm -rf "$WORKSPACE_PATH"
    echo "Canon:   workspace deleted"
  fi

  # ------------------------------------------------------------------
  # Delete local branch (safe — git refuses if not fully merged)
  # ------------------------------------------------------------------

  if git branch -d "$BRANCH" 2>/dev/null; then
    echo "Canon:   branch '${BRANCH}' deleted"
    CLEANED+=("$BRANCH")
  else
    echo "Canon:   branch '${BRANCH}' could not be deleted (git refused — check manually)"
    SKIPPED+=("$BRANCH")
  fi

  echo ""
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

if [[ ${#CLEANED[@]} -gt 0 ]]; then
  echo "Canon post-merge cleanup complete:"
  for B in "${CLEANED[@]}"; do
    echo "  - ${B}"
  done
fi

if [[ ${#SKIPPED[@]} -gt 0 ]]; then
  echo "Canon: the following branches could not be fully cleaned (manual review needed):"
  for B in "${SKIPPED[@]}"; do
    echo "  - ${B}"
  done
fi
