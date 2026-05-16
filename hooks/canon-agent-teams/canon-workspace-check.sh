#!/usr/bin/env bash
# canon-workspace-check.sh — PreToolUse hook: L4 hard-enforcement layer.
#
# Bootstrap contract: L4 fires only on Edit / Write / tracked-Bash calls.
# MCP tool calls (init_workspace, etc.) are not Edit/Write/Bash and are
# never blocked by this hook.
#
# Decision table:
#   CANON_BYPASS_WORKSPACE_CHECK=1  → allow (explicit escape hatch)
#   target file is gitignored       → allow (always safe)
#   Bash with no file targets       → allow (no write detected)
#   active workspace on branch      → allow
#   parent workspace active (worktree) → allow
#   none of the above               → block (exit 2)

set -euo pipefail

# ── 1. Bypass gate ────────────────────────────────────────────────────────────
if [[ "${CANON_BYPASS_WORKSPACE_CHECK:-0}" == "1" ]]; then
  exit 0
fi

# ── 2. Read tool input from stdin ─────────────────────────────────────────────
TOOL_INPUT_JSON=$(cat)

# Extract field using jq if available, otherwise fall back to grep/sed.
_jq_field() {
  local field="$1"
  if command -v jq >/dev/null 2>&1; then
    echo "$TOOL_INPUT_JSON" | jq -r ".$field // empty" 2>/dev/null || true
  else
    # Minimal grep fallback: extract simple string values only.
    echo "$TOOL_INPUT_JSON" | grep -o "\"${field}\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" \
      | sed "s/\"${field}\"[[:space:]]*:[[:space:]]*\"//;s/\"$//" | head -1 || true
  fi
}

# ── 3. Resolve target file path(s) ────────────────────────────────────────────
declare -a TARGETS=()

case "${TOOL_NAME:-}" in
  Edit|Write)
    fp=$(_jq_field "file_path")
    if [[ -n "$fp" ]]; then
      TARGETS+=("$fp")
    fi
    ;;
  Bash)
    cmd=$(_jq_field "command")
    if [[ -z "$cmd" ]]; then
      exit 0
    fi

    # Parse Bash command for file write targets.
    # Redirect targets: > file, >> file (with or without space after operator)
    while IFS= read -r match; do
      [[ -n "$match" ]] && TARGETS+=("$match")
    done < <(echo "$cmd" | grep -oE '>>?[[:space:]]*[^[:space:];|&>]+' \
      | sed -E 's/^>>?[[:space:]]*//' || true)

    # tee with multiple args: tee [-ai] file1 file2 ...
    while IFS= read -r match; do
      [[ -n "$match" ]] && TARGETS+=("$match")
    done < <(echo "$cmd" | grep -oE 'tee[[:space:]]+(-[ai][[:space:]]+)*[^;|&]+' \
      | sed -E 's/^tee[[:space:]]+(-[ai][[:space:]]+)*//' \
      | tr ' ' '\n' | grep -v '^$' || true)

    # sed -i: sed -i '' 's/.../.../' file  OR  sed -i 's/.../.../' file
    while IFS= read -r match; do
      [[ -n "$match" ]] && TARGETS+=("$match")
    done < <(echo "$cmd" | grep -oE "sed[[:space:]]+-i[[:space:]+'\"]*[^[:space:]'\"]*[[:space:]+'\"]*[[:space:]]+['\"]?s[^[:space:]'\"]+['\"]?[[:space:]]+[^[:space:];|&>]+" \
      | grep -oE '[^[:space:];|&>]+$' || true)

    # awk -i inplace: awk -i inplace '{...}' file
    while IFS= read -r match; do
      [[ -n "$match" ]] && TARGETS+=("$match")
    done < <(echo "$cmd" | grep -oE "awk[[:space:]]+-i[[:space:]]+inplace[[:space:]]+[^[:space:];|&>]+" \
      | grep -oE '[^[:space:];|&>]+$' || true)

    # git checkout -- file, git reset --hard
    if echo "$cmd" | grep -qE 'git[[:space:]]+(checkout[[:space:]]+--[[:space:]]+|reset[[:space:]]+--hard)'; then
      # git reset --hard has no specific file target to parse; treat whole op as tracked
      TARGETS+=("__git_destructive__")
    fi

    # No file targets found → allow
    if [[ ${#TARGETS[@]} -eq 0 ]]; then
      exit 0
    fi
    ;;
  *)
    # Unknown tool — allow
    exit 0
    ;;
esac

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  exit 0
fi

# ── 5 & 6. Check gitignore for each target ────────────────────────────────────
GIT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)

has_tracked=0
for target in "${TARGETS[@]}"; do
  # Special sentinel for git destructive ops — always treated as tracked
  if [[ "$target" == "__git_destructive__" ]]; then
    has_tracked=1
    break
  fi

  # Resolve absolute path for git check-ignore
  if [[ "$target" = /* ]]; then
    abs_target="$target"
  elif [[ -n "$GIT_ROOT" ]]; then
    abs_target="${GIT_ROOT}/${target}"
  else
    abs_target="$target"
  fi

  if git check-ignore -q "$abs_target" 2>/dev/null; then
    # Gitignored — skip this target
    continue
  else
    # Not gitignored — tracked file, needs workspace validation
    has_tracked=1
    break
  fi
done

# All targets gitignored → allow
if [[ "$has_tracked" -eq 0 ]]; then
  exit 0
fi

# ── 6. Workspace check — find active workspace for current branch ──────────────
CURRENT_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || git rev-parse --short HEAD 2>/dev/null || true)

# Determine all candidate .canon/workspaces/ roots to search.
# Worktrees share the main repo's .canon/ since .canon/ lives in the working tree,
# not the .git dir. We must search from the main working tree root.
GIT_DIR=$(git rev-parse --git-dir 2>/dev/null || true)
GIT_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null || true)
IN_WORKTREE=0

SEARCH_ROOTS=("$GIT_ROOT")
if [[ -n "$GIT_DIR" && -n "$GIT_COMMON_DIR" && "$GIT_DIR" != "$GIT_COMMON_DIR" ]]; then
  IN_WORKTREE=1
  # Derive the main working tree root from GIT_COMMON_DIR (which points to main .git/)
  main_root=$(dirname "$GIT_COMMON_DIR")
  if [[ -n "$main_root" && "$main_root" != "$GIT_ROOT" ]]; then
    SEARCH_ROOTS+=("$main_root")
  fi
fi

_find_active_workspace() {
  local branch="$1"

  for search_root in "${SEARCH_ROOTS[@]}"; do
    local ws_dir="${search_root}/.canon/workspaces"
    if [[ ! -d "$ws_dir" ]]; then
      continue
    fi

    # Scan all session.json files for a matching branch + active status
    while IFS= read -r session_file; do
      if [[ ! -f "$session_file" ]]; then
        continue
      fi

      if command -v jq >/dev/null 2>&1; then
        ws_branch=$(jq -r '.branch // empty' "$session_file" 2>/dev/null || true)
        ws_status=$(jq -r '.status // empty' "$session_file" 2>/dev/null || true)
      else
        ws_branch=$(grep -o '"branch"[[:space:]]*:[[:space:]]*"[^"]*"' "$session_file" \
          | sed 's/"branch"[[:space:]]*:[[:space:]]*"//;s/"//' | head -1 || true)
        ws_status=$(grep -o '"status"[[:space:]]*:[[:space:]]*"[^"]*"' "$session_file" \
          | sed 's/"status"[[:space:]]*:[[:space:]]*"//;s/"//' | head -1 || true)
      fi

      if [[ "$ws_branch" == "$branch" && "$ws_status" == "active" ]]; then
        return 0
      fi
    done < <(find "$ws_dir" -name "session.json" -maxdepth 3 2>/dev/null)
  done

  return 1
}

if _find_active_workspace "$CURRENT_BRANCH"; then
  exit 0
fi

# ── 7. Parent-workspace lookup (ISSUE-3) ─────────────────────────────────────
# If in a worktree, check CANON_PARENT_WORKSPACE env var for a parent workspace.
if [[ "$IN_WORKTREE" -eq 1 && -n "${CANON_PARENT_WORKSPACE:-}" ]]; then
  for search_root in "${SEARCH_ROOTS[@]}"; do
    parent_session="${search_root}/.canon/workspaces/${CANON_PARENT_WORKSPACE}/session.json"
    if [[ -f "$parent_session" ]]; then
      if command -v jq >/dev/null 2>&1; then
        parent_status=$(jq -r '.status // empty' "$parent_session" 2>/dev/null || true)
      else
        parent_status=$(grep -o '"status"[[:space:]]*:[[:space:]]*"[^"]*"' "$parent_session" \
          | sed 's/"status"[[:space:]]*:[[:space:]]*"//;s/"//' | head -1 || true)
      fi

      if [[ "$parent_status" == "active" ]]; then
        exit 0
      fi
    fi
  done
fi

# ── 8. Block ──────────────────────────────────────────────────────────────────
echo "No active Canon workspace for this branch. Route the request through the planner to create a workspace before editing tracked files." >&2
exit 2
