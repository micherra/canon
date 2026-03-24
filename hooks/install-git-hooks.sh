#!/bin/bash
# Canon Git Hooks Installer
#
# Installs Canon's git hooks into .git/hooks/ by symlinking them.
# If a hook file already exists (e.g. from another tool), this script
# appends a call to the Canon hook rather than overwriting it.
#
# Usage (run from the repo root):
#   ./hooks/install-git-hooks.sh
#
# To uninstall, remove the symlinks from .git/hooks/ or delete the
# appended Canon lines from any existing hook files.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || { echo "Error: must be run from inside a git repository." >&2; exit 1; })"
HOOKS_SRC_DIR="${REPO_ROOT}/hooks"
GIT_HOOKS_DIR="${REPO_ROOT}/.git/hooks"

# Ensure the .git/hooks directory exists (it always should, but just in case)
mkdir -p "$GIT_HOOKS_DIR"

# ---------------------------------------------------------------------------
# install_hook HOOK_NAME SRC_SCRIPT
#   Installs SRC_SCRIPT as .git/hooks/HOOK_NAME.
#   - If no hook exists yet: creates a symlink.
#   - If a hook already exists and IS the Canon script: skip (already installed).
#   - If a hook already exists and is something else: append a delegating call.
# ---------------------------------------------------------------------------
install_hook() {
  local hook_name="$1"
  local src_script="$2"
  local dest="${GIT_HOOKS_DIR}/${hook_name}"
  local canon_marker="# Canon: ${hook_name}"

  if [[ ! -f "$src_script" && ! -L "$src_script" ]]; then
    echo "Skipping ${hook_name}: source script not found at ${src_script}"
    return
  fi

  # Make sure the source script is executable
  chmod +x "$src_script"

  if [[ ! -e "$dest" && ! -L "$dest" ]]; then
    # No existing hook — create a symlink
    ln -sf "$src_script" "$dest"
    echo "Installed: .git/hooks/${hook_name} -> ${src_script}"
    return
  fi

  # Resolve symlink for comparison
  local resolved=""
  if [[ -L "$dest" ]]; then
    resolved="$(readlink "$dest" || true)"
    # Normalize to absolute path for comparison
    if [[ "$resolved" != /* ]]; then
      resolved="${GIT_HOOKS_DIR}/${resolved}"
    fi
  fi

  if [[ "$resolved" == "$src_script" ]]; then
    echo "Already installed: .git/hooks/${hook_name} (symlink matches)"
    return
  fi

  # A different hook exists — check if we already appended to it
  if grep -qF "$canon_marker" "$dest" 2>/dev/null; then
    echo "Already appended: .git/hooks/${hook_name} already calls Canon hook"
    return
  fi

  # Append a delegating call to the existing hook
  echo "" >> "$dest"
  cat >> "$dest" <<APPEND
${canon_marker}
"${src_script}" "\$@"
APPEND
  echo "Appended: Canon ${hook_name} call added to existing .git/hooks/${hook_name}"
}

# ---------------------------------------------------------------------------
# Register all Canon git hooks here
# ---------------------------------------------------------------------------

install_hook "post-merge" "${HOOKS_SRC_DIR}/post-merge-cleanup.sh"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo ""
echo "Canon git hooks installed. To verify:"
echo "  ls -la ${GIT_HOOKS_DIR}/"
