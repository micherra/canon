# Canon Release Checklist

Use this checklist every time you cut a Canon release. `scripts/release.sh` automates steps 1–3 and part of step 4 (local tag); the remaining steps are shipper-owned or manual operator actions.

Cross-reference: `scripts/release.sh` references this file in its closing output.

---

## 1. Version bump — three lockstep locations

All three must be updated in the same commit. Missing any one causes the plugin cache and the server to advertise inconsistent versions.

- [ ] `.claude-plugin/plugin.json` — `"version"` field
- [ ] `mcp-server/package.json` — `"version"` field
- [ ] `mcp-server/src/app/server-state.ts` — hardcoded `version: "X.Y.Z"` string (~line 122 in the `new McpServer({...})` call)

The `jq`/`sed` updates in `scripts/release.sh` handle all three. If bumping manually, update all three before committing.

## 2. Lockfile regeneration

The `mcp-server/package-lock.json` must reflect the new version. Run from repo root:

```bash
(cd mcp-server && npm install --package-lock-only)
```

Then assert the version matches before committing:

```bash
LOCK_VERSION=$(jq -r .version mcp-server/package-lock.json)
if [[ "$LOCK_VERSION" != "$VERSION" ]]; then
  echo "ERROR: lockfile version ($LOCK_VERSION) does not match release version ($VERSION)" >&2
  exit 1
fi
```

`scripts/release.sh` runs this regeneration and assertion automatically, and adds the lockfile to the release commit. Do NOT touch the root `package-lock.json` — it is an intentional 84-byte workspaces stub.

## 3. CHANGELOG entry

Prepend a new `## X.Y.Z (YYYY-MM-DD)` section to `CHANGELOG.md` above the previous entry. Include:

- One-line summary (commit count, theme)
- Grouped sections: **Highlights**, **Features**, **Fixes**, **Documentation and Chores**
- PR references (`#NNN`) for all notable changes

Run `git log vPREV..HEAD --pretty='%s'` to get the accurate commit list. Do not invent entries.

## 4. Commit, tag, and push the tag

`scripts/release.sh` creates the commit and local tag. After it completes:

```bash
git push && git push origin vX.Y.Z
```

**Push the tag BEFORE running `gh release create`.** A local-only tag caused the v2.3.1 never-released incident — GitHub cannot create a release for a tag it does not know about.

The script prints a reminder with these exact commands when it completes.

## 5. Create the GitHub release

After the tag is pushed:

```bash
gh release create vX.Y.Z --generate-notes
```

The Canon shipper agent runs this automatically when a `vX.Y.Z` tag is present on HEAD at the ship step. If running manually, ensure the tag is visible on GitHub first (`git ls-remote --tags origin` to verify).

## 6. Local marketplace reconcile (manual operator step)

**This step is not automated.** After the PR is merged and the release is live, each operator must refresh their local Claude plugin cache so the directory-marketplace picks up the new version:

1. Open Claude Desktop (or restart the Claude Code session).
2. Navigate to the Canon plugin settings and run the plugin update / marketplace-refresh action.
3. Verify the plugin reports version `X.Y.Z`.

**Why this step is required:** The directory-marketplace deduplicates on the `plugin.json` version string. A version that is not strictly greater than the cached version will not be pulled — the operator's local install remains on the old version even after the release. Bumping the version above the cached value (e.g., from `2.3.1` to `2.4.0`) is what triggers the pull.

This is a conscious design constraint of the marketplace; it is not a Canon bug.
