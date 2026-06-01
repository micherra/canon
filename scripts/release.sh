#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/release.sh <version>
# Bumps the version in all three places, regenerates the lockfile,
# commits, and tags. See docs/reference/release-checklist.md for
# the full release sequence (tag-push, gh release, marketplace reconcile).

VERSION="${1:-}"

if [[ -z "$VERSION" ]]; then
  echo "Error: version argument required" >&2
  echo "Usage: $0 <version>  (e.g. $0 1.4.0)" >&2
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
LOCK_FILE="$REPO_ROOT/mcp-server/package-lock.json"

echo "Bumping version to $VERSION in:"
echo "  $PLUGIN_JSON"
echo "  $PACKAGE_JSON"
echo "  $SERVER_STATE_TS"

# Update .claude-plugin/plugin.json
jq --arg v "$VERSION" '.version = $v' "$PLUGIN_JSON" > "$PLUGIN_JSON.tmp" && mv "$PLUGIN_JSON.tmp" "$PLUGIN_JSON"

# Update mcp-server/package.json
jq --arg v "$VERSION" '.version = $v' "$PACKAGE_JSON" > "$PACKAGE_JSON.tmp" && mv "$PACKAGE_JSON.tmp" "$PACKAGE_JSON"

# Update the hardcoded version string in server-state.ts
# Matches:   version: "X.Y.Z",
sed -i '' "s/version: \"[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\"/version: \"$VERSION\"/" "$SERVER_STATE_TS"

# Regenerate the lockfile so it stays in lockstep with package.json
echo "Regenerating $LOCK_FILE..."
(cd "$REPO_ROOT/mcp-server" && npm install --package-lock-only)

# Fail-closed: assert the lockfile's top-level version matches the requested version
LOCK_VERSION="$(jq -r .version "$LOCK_FILE")"
if [[ "$LOCK_VERSION" != "$VERSION" ]]; then
  echo "" >&2
  echo "ERROR: lockfile version mismatch after regeneration." >&2
  echo "  Expected : $VERSION" >&2
  echo "  Got      : $LOCK_VERSION" >&2
  echo "The lockfile ($LOCK_FILE) was not updated correctly." >&2
  echo "Fix the discrepancy before committing." >&2
  exit 1
fi
echo "Lockfile version verified: $LOCK_VERSION"

echo "Staging files..."
git -C "$REPO_ROOT" add "$PLUGIN_JSON" "$PACKAGE_JSON" "$SERVER_STATE_TS" "$LOCK_FILE"

echo "Committing..."
git -C "$REPO_ROOT" commit -m "release: v$VERSION"

echo "Tagging v$VERSION..."
git -C "$REPO_ROOT" tag "v$VERSION"

echo ""
echo "Done. Committed and tagged v$VERSION locally."
echo ""
echo "Next steps — see docs/reference/release-checklist.md for full details:"
echo "  1. Push branch and tag:  git push && git push origin v$VERSION"
echo "  2. Create GitHub release: gh release create v$VERSION --generate-notes"
echo "  3. After merge, remind operators to refresh the local Canon marketplace plugin."
