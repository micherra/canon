---
id: install-faithful-dev-repo
title: Plugin-Shipped Runtime Files Must Be Faithful to an Installed Layout
severity: convention
portable: false
scope:
  layers: []
  file_patterns:
    - ".mcp.json"
    - ".tool-versions"
    - ".nvmrc"
    - ".node-version"
    - "boot.sh"
    - "mcp-server/boot.sh"
    - "mcp-server/.tool-versions"
    - ".claude-plugin/*"
    - "plugin.json"
tags:
  - reliability
  - infrastructure
  - agent-behavior
---

The dev repo must faithfully model a plugin install. Because the marketplace ships the entire tracked git tree into `~/.claude/plugins/cache/...` (no allowlist or ignore mechanism exists), any tracked file can affect runtime behavior on user machines. Dev-specific assumptions in these files — toolchain version pins, path tokens that resolve to `.` when `cwd == repo` — are invisible during development but break installs silently.

**Scope:** This convention applies to plugin-shipped *runtime* files: `.mcp.json`, toolchain pin files (`.tool-versions`, `.nvmrc`, `.node-version`, `mise.toml`), `boot.sh`, and plugin manifests (`.claude-plugin/*`, `plugin.json`). It does NOT govern gitignored dev-only state (`.env`, local `.tool-versions` files after they are gitignored), nor inert-but-shipped bloat (`.github/`, `docs/`, test files — wasteful but cannot change runtime behavior).

## Why the Dev Repo Masks Install Failures

In the Canon dev repo, `cwd == plugin directory` and the maintainer's local environment matches any assumption the files encode. On a plugin install, `cwd` is the user's project directory, `CLAUDE_PLUGIN_ROOT` points to a copied tree, and the user's tool environment may differ. The combination means dev testing passes while installs fail — with poor diagnostics (typically `-32000 Connection closed`, no path information).

Two confirmed instances before this convention was written:

| PR | File | Encoded assumption | Install failure |
|----|------|-------------------|-----------------|
| #356 | `.mcp.json` `args` array | `${CLAUDE_PLUGIN_ROOT:-.}` — `:-.` fallback → `.` (dev cwd, which equals plugin dir in dev repo) | On install, `cwd` ≠ plugin dir → `bash ./mcp-server/boot.sh` ran against the wrong directory → `-32000` |
| #361 | `.tool-versions` (root + `mcp-server/`) | `nodejs 25.8.0` exact pin | asdf users with `nodejs 20.x`/`22.x`/`24.x` had wrong Node shim resolved at boot → exit 126 → `-32000` |

In both cases the file functioned correctly in the dev repo. The failure surface was reachable only from a non-dev cwd or a different tool environment.

## The Two Failure Classes to Prevent

### Class A — Unsubstituted path tokens in `args`

Claude Code substitutes `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` in the MCP server config's `env` block. It does **not** substitute inside `args` arrays in all versions. A token in `args` with a fallback to `.` (e.g., `${CLAUDE_PLUGIN_ROOT:-.}`) resolves to the repo root in dev (correct) and to the user's project cwd on install (wrong).

### Class B — Tracked toolchain version pins

Version manager pin files (`.tool-versions`, `.nvmrc`, `.node-version`) in tracked paths ship to every install. An asdf, nvm, or mise user whose local environment does not match the pinned version silently gets the pinned (or wrong) version resolved at boot, bypassing the system Node entirely.

## Examples

### Class A — Path tokens in `.mcp.json` args

**Bad — token in `args` with cwd fallback:**

```json
{
  "mcpServers": {
    "canon": {
      "command": "bash",
      "args": ["${CLAUDE_PLUGIN_ROOT:-.}/mcp-server/boot.sh"],
      "env": {}
    }
  }
}
```

`${CLAUDE_PLUGIN_ROOT:-.}` in `args` resolves to `.` when `CLAUDE_PLUGIN_ROOT` is unset (as in some Claude Code versions or on first launch). In dev, `.` is the repo root (correct). On install, `.` is the user's project cwd (wrong path → boot failure).

**Good — path-bearing variable routed through `env`, or self-resolving launcher:**

```json
{
  "mcpServers": {
    "canon": {
      "command": "bash",
      "args": ["/absolute/path/to/mcp-server/boot.sh"],
      "env": {
        "CLAUDE_PLUGIN_ROOT": "${CLAUDE_PLUGIN_ROOT}"
      }
    }
  }
}
```

Or use a launcher that resolves its own location via `BASH_SOURCE`:

```bash
#!/usr/bin/env bash
# boot-launcher.sh — self-resolving; safe from any cwd
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "${SCRIPT_DIR}/mcp-server/boot.sh" "$@"
```

The launcher resolves its own path regardless of the caller's cwd. No cwd assumption is encoded.

### Class B — Toolchain pin files

**Bad — exact Node pin tracked in git:**

```
# .tool-versions (tracked, ships to every install)
nodejs 25.8.0
```

asdf users whose local `.tool-versions` doesn't match this exact pin get this version resolved when they run from the plugin directory — overriding their system Node.

**Good — pin file gitignored; declarative version floor in `package.json`:**

```jsonc
// mcp-server/package.json
{
  "engines": {
    "node": ">=24"
  }
}
```

And in `.gitignore`:
```
.tool-versions
.nvmrc
.node-version
```

The `engines` floor is declarative and enforced by the `boot.sh` preflight (which checks `node --version` and exits with an actionable message if the major version is below the minimum). No exact pin ships to installs.

## Mechanical Enforcement

This convention is backed by two mechanical guards — reference them when raising or discussing findings:

1. **`hooks/lint.sh` — tracked-file lint** (two checks):
   - `token-in-args`: greps `.mcp.json` for `${CLAUDE_PLUGIN_ROOT` or `${CLAUDE_PLUGIN_DATA` tokens appearing in `args` array context. Fails fast at commit time on Class A.
   - `shipped-toolchain-pins`: runs `git ls-files | grep -E '(^|/)\.tool-versions$|(^|/)\.nvmrc$|(^|/)\.node-version$'` and fails if any such file is tracked. Fails fast at commit time on Class B.

2. **`install-sim` CI smoke job** — exercises the plugin against a non-dev cwd (`/tmp/test-project`) with `CLAUDE_PLUGIN_ROOT` set to a copied tree and a Node version other than the maintainer's pinned version. This is the backstop: it catches novel instances of this failure class before they reach users, including failure modes not covered by the two lint patterns above.

A change that triggers either lint check is a convention violation. A change to plugin-shipped runtime files that is not covered by either lint check should be validated manually against an install-like environment (non-repo cwd, `CLAUDE_PLUGIN_ROOT` set to a copied tree) before merge.

## Verification

Before committing any change to a plugin-shipped runtime file:

- [ ] `git ls-files | grep -E '(^|/)\.tool-versions$|(^|/)\.nvmrc$|(^|/)\.node-version$'` returns empty (no tracked toolchain pins).
- [ ] `.mcp.json` contains no `${CLAUDE_PLUGIN_ROOT` or `${CLAUDE_PLUGIN_DATA` tokens in any `args` array.
- [ ] Any new path resolution in `boot.sh` or `.mcp.json` is verified to work from a cwd that is NOT the plugin directory.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|----------------|----------------|
| "It works in dev — the CI passed." | CI runs from the repo root with the maintainer's environment. The failure surface is only reachable from a non-dev cwd or a different tool environment. | Validate against the `install-sim` job or manually with a copied tree and non-repo cwd. |
| "The `:-.` fallback is a safe default." | In dev, `.` is the plugin directory (correct). On install, `.` is the user's project cwd (wrong). The fallback encodes a dev-only assumption. | Use a self-resolving launcher (`BASH_SOURCE` pattern) or route path tokens through `env`, not `args`. |
| "We use asdf ourselves so `.tool-versions` is fine to track." | You control your local environment; your users do not. Tracking an exact pin ships a version constraint to every asdf user whose local version differs. | Gitignore pin files; use `engines.node` floor + boot preflight instead. |
| "Bloat files are the same problem — I should clean those up too." | Inert files (`.github/`, `docs/`, tests) bloat the install cache but cannot alter runtime behavior. Scope cleanup is out of scope for this convention. | Address bloat separately. This convention covers only files that can change runtime behavior. |

## Exceptions

This convention does not apply to:

- **Gitignored files.** Only tracked (shipped) files are in scope. Once `.tool-versions` is gitignored, it is a local dev artifact and outside this convention's scope.
- **CI-only pin files.** If a toolchain pin file is used exclusively by CI runners (e.g., `.tool-versions` used only in a CI `setup-node` step that is itself not shipped), and that file is tracked — add it to `.gitignore` to make the constraint explicit. The CI workflow should pin Node via `actions/setup-node` `node-version:` input instead.
- **Absolute paths in `boot.sh`.** A hardcoded absolute path in `boot.sh` is a separate defect class (platform portability), not a Class A violation. This convention covers cwd-relative path assumptions, not hardcoded paths.
