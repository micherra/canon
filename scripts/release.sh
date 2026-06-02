#!/usr/bin/env bash
# FALLBACK ONLY — the primary release path is release-please
# (.github/workflows/release-please.yml). Use this only if GitHub Actions
# is unavailable. release-please normally owns tagging + GitHub release creation.
set -euo pipefail

# Usage: ./scripts/release.sh <version>
# Bumps the version in all 4 locations, regenerates the lockfile, and commits.
# NOTE: Tagging is normally release-please's responsibility. This script does NOT
# create a tag automatically. After running, create the tag and release manually:
#   git tag vX.Y.Z && git push && git push origin vX.Y.Z
#   gh release create vX.Y.Z --generate-notes

VERSION="${1:-}"

if [[ -z "$VERSION" ]]; then
  echo "Error: version argument required" >&2
  echo "Usage: $0 <version>  (e.g. $0 2.4.0)" >&2
  exit 1
fi

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Error: '$VERSION' does not look like a semver (expected X.Y.Z)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PLUGIN_JSON="$REPO_ROOT/.claude-plugin/plugin.json"
PACKAGE_JSON="$REPO_ROOT/mcp-server/package.json"
SERVER_STATE_TS="$REPO_ROOT/mcp-server/src/app/server-state.ts"
PACKAGE_LOCK="$REPO_ROOT/mcp-server/package-lock.json"

echo "Bumping version to $VERSION in:"
echo "  $PLUGIN_JSON"
echo "  $PACKAGE_JSON"
echo "  $SERVER_STATE_TS"
echo "  $PACKAGE_LOCK (regenerated via npm install)"

# Update .claude-plugin/plugin.json
jq --arg v "$VERSION" '.version = $v' "$PLUGIN_JSON" > "$PLUGIN_JSON.tmp" && mv "$PLUGIN_JSON.tmp" "$PLUGIN_JSON"

# Update mcp-server/package.json
jq --arg v "$VERSION" '.version = $v' "$PACKAGE_JSON" > "$PACKAGE_JSON.tmp" && mv "$PACKAGE_JSON.tmp" "$PACKAGE_JSON"

# Update the hardcoded version string in server-state.ts
# Matches:   version: "X.Y.Z",
sed -i '' "s/version: \"[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\"/version: \"$VERSION\"/" "$SERVER_STATE_TS"

# Regenerate the lockfile so both .version and .packages[""].version are correct.
# This prevents the lockfile-drift failure that occurred 3/3 times with the old process.
echo "Regenerating mcp-server/package-lock.json via npm install..."
(cd "$REPO_ROOT/mcp-server" && npm install)

# Verify both lockfile version fields are updated
LOCK_ROOT_VER="$(jq -r '.version' "$PACKAGE_LOCK")"
LOCK_PKG_VER="$(jq -r '.packages[""].version' "$PACKAGE_LOCK")"
if [[ "$LOCK_ROOT_VER" != "$VERSION" ]]; then
  echo "Error: lockfile .version is '$LOCK_ROOT_VER', expected '$VERSION'" >&2
  exit 1
fi
if [[ "$LOCK_PKG_VER" != "$VERSION" ]]; then
  echo "Error: lockfile .packages[\"\"].version is '$LOCK_PKG_VER', expected '$VERSION'" >&2
  exit 1
fi
echo "Lockfile assertions passed."

echo "Staging files..."
git -C "$REPO_ROOT" add "$PLUGIN_JSON" "$PACKAGE_JSON" "$SERVER_STATE_TS" "$PACKAGE_LOCK"

echo "Committing..."
git -C "$REPO_ROOT" commit -m "chore(release): bump version to $VERSION"

echo ""
echo "Done. Committed v$VERSION."
echo "Next steps (normally release-please handles these automatically):"
echo "  git tag v$VERSION"
echo "  git push && git push origin v$VERSION"
echo "  gh release create v$VERSION --generate-notes"
echo "  claude plugin update canon   # reconcile directory-marketplace cache"
