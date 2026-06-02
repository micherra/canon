# Canon Release Checklist

release-please is the **primary** release mechanism. This checklist documents the normal flow and the manual fallback.

## Normal Flow (release-please)

1. **Conventional commits land on `main`.**
   release-please monitors `main` for commits with `feat(...)`, `fix(...)`, `chore(release):`, etc.
   The action runs automatically on every push to `main`.

2. **release-please opens (or updates) a release PR.**
   The PR updates 4 version locations plus the changelog:
   - `.claude-plugin/plugin.json` — marketplace version
   - `mcp-server/package.json` — npm package version
   - `mcp-server/src/app/server-state.ts` — MCP server version string
   - `mcp-server/package-lock.json` (both `.version` and `.packages[""].version`)
   - `CHANGELOG.md` — auto-generated from commit history (not a version location)

3. **Review the release PR.**
   - Confirm the computed version bump is correct (feat → minor, fix → patch, BREAKING → major).
   - Confirm all 4 version locations are updated in the diff.
   - Confirm `CHANGELOG.md` entries are accurate.

4. **Merge the release PR.**
   release-please automatically:
   - Creates the `vX.Y.Z` tag on the merge commit.
   - Creates a GitHub release with auto-generated notes.
   - Closes the release PR.

   > **Note on CI:** `ci.yml` does NOT run on the release PR because it is opened with
   > `GITHUB_TOKEN` (by design — prevents recursive workflow triggers). This is acceptable:
   > the release PR only edits version strings; all behavioral code was already CI-validated
   > on the contributing feature PRs.

5. **Manual step (cannot be automated): reconcile the directory-marketplace cache.**
   The Canon plugin marketplace keys on `plugin.json`'s version string. After the release PR
   merges and the tag is created, update the local install:
   ```
   claude plugin update canon
   ```
   Then restart Claude Code. This is the step that unblocks any frozen marketplace cache.

---

## Fallback (GitHub Actions unavailable)

If the release-please workflow cannot run (Actions disabled, quota exhausted, etc.):

1. Run `scripts/release.sh <version>` from the repo root.
   This bumps all 4 version locations, regenerates the lockfile, and commits.
   It does **not** create a tag (tagging is normally release-please's job).

2. Create the tag and GitHub release manually:
   ```
   git tag vX.Y.Z
   git push && git push origin vX.Y.Z
   gh release create vX.Y.Z --generate-notes
   ```

3. Follow step 5 above (marketplace reconcile) — it is required regardless of which path was used.

---

## Version locations (reference)

| File | Field | Mechanism |
|------|-------|-----------|
| `.claude-plugin/plugin.json` | `$.version` | release-please `extra-files` json updater |
| `mcp-server/package.json` | `$.version` | release-please `extra-files` json updater (root `"."` component) |
| `mcp-server/src/app/server-state.ts` | `version:` string | release-please `extra-files` generic updater (via `// x-release-please-version` annotation) |
| `mcp-server/package-lock.json` | `$.version` | release-please `extra-files` json updater |
| `mcp-server/package-lock.json` | `$.packages[""].version` | release-please `extra-files` json updater |

All 5 entries move in the same release PR. The root `/package-lock.json` is an 84-byte stub and is intentionally excluded.

---

## First managed release

The manifest is bootstrapped at `2.3.0`. The first release-please run after this workflow merges
will propose **`2.4.0`** (because there are `feat(...)` commits since `v2.3.0`).

If the first release PR proposes a different version, the stray `v2.3.1` tag on the abandoned
`canon/cut-release-v2-3-1` branch may be interfering. Resolve by deleting it:
```
git push origin :refs/tags/v2.3.1
```
Then trigger the workflow again (push any commit to `main`).
