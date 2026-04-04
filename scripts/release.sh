#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/release.sh <version>
# Bumps the version in all three places, commits, and tags.

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
INDEX_TS="$REPO_ROOT/mcp-server/src/index.ts"

echo "Bumping version to $VERSION in:"
echo "  $PLUGIN_JSON"
echo "  $PACKAGE_JSON"
echo "  $INDEX_TS"

# Update .claude-plugin/plugin.json
jq --arg v "$VERSION" '.version = $v' "$PLUGIN_JSON" > "$PLUGIN_JSON.tmp" && mv "$PLUGIN_JSON.tmp" "$PLUGIN_JSON"

# Update mcp-server/package.json
jq --arg v "$VERSION" '.version = $v' "$PACKAGE_JSON" > "$PACKAGE_JSON.tmp" && mv "$PACKAGE_JSON.tmp" "$PACKAGE_JSON"

# Update the hardcoded version string in index.ts
# Matches:   version: "X.Y.Z",
sed -i '' "s/version: \"[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\"/version: \"$VERSION\"/" "$INDEX_TS"

echo "Staging files..."
git -C "$REPO_ROOT" add "$PLUGIN_JSON" "$PACKAGE_JSON" "$INDEX_TS"

echo "Committing..."
git -C "$REPO_ROOT" commit -m "release: v$VERSION"

echo "Tagging v$VERSION..."
git -C "$REPO_ROOT" tag "v$VERSION"

echo ""
echo "Done. Committed and tagged v$VERSION."
echo "Push with: git push && git push origin v$VERSION"
