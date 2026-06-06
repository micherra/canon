# app/ — Entry Point and Server State

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Entry point for the Canon MCP server: tool registration, HTTP server lifecycle, project-directory resolution, and per-connection scope management.

## Architecture
<!-- last-updated: 2026-06-05 -->

**Key files:**

| File | Responsibility |
|------|---------------|
| `index.ts` | Server entry — calls `registerConnectionScope(STDIO_SESSION_ID, resolvedDir)` at startup; all `register-*.ts` wired here |
| `server-state.ts` | Per-connection scope registry (`resolveScope(extra)`), `findAnchorDir` boot helper, per-project `JobManager` map |
| `http-server.ts` | HTTP server lifecycle — `startHttpServer`, `stopHttpServer`, `resolvePidDir`, `writePidFile`, `removePidFile`, `resetStateForTesting` |
| `resolve-project-dir.ts` | `resolveGitRoot(cwd, gitTopLevelFn)` — git root or cwd fallback; never throws |
| `get-context-handler.ts` | `get_context` composite tool handler; re-exported from `register-knowledge.ts` |
| `register-*.ts` | One file per feature boundary — each file registers its MCP tools via `gatedWrapHandler` |

## Contracts
<!-- last-updated: 2026-06-05 -->

**`boot.sh`** (`mcp-server/boot.sh`) — self-resolving launcher; never uses `npx`. Key steps: resolve `SERVER_DIR` via `CLAUDE_PLUGIN_ROOT` or `BASH_SOURCE`; poll `DATA_DIR/.bin/tsx` when `CLAUDE_PLUGIN_DATA` set (timeout `CANON_BOOT_DEPS_TIMEOUT`, default 60s); ESM co-location symlink (`ln -s DATA_DIR SERVER_DIR/node_modules`) — idempotent, `ln` failure degrades gracefully; dangling-symlink guard exits 1 (skipped under `--print-resolution`); `--print-resolution` prints `SERVER_DIR NODE_PATH TSX_BIN` and exits 0. **ESM/NODE_PATH pitfall**: `NODE_PATH` is CJS-only — ESM uses the co-located symlink; missing/dangling symlink → `ERR_MODULE_NOT_FOUND`. See `references/plugin-server-boot.md`.

**`resolveScope(extra)`** (`server-state.ts`) — sole accessor for project-dir scope. Lookup order: (1) per-session registry keyed by `extra.sessionId`; (2) `STDIO_SESSION_ID = "__stdio__"` sentinel. Fails closed (throws) for unregistered sessions — closes cross-tenant cwd-leak hazard. `registerConnectionScope(sessionId, dir)` / `clearConnectionScope(sessionId)` manage the registry. `resetForTesting()` clears all mutable state.

**`findAnchorDir(startDir, markers[], existsFn?)`** (`server-state.ts`) — walks up from `startDir` until a directory containing every `markers[]` entry is found; injectable `existsFn` seam (default `existsSync`); throws with diagnostic message (names missing markers and `CANON_PLUGIN_DIR` escape hatch) when no ancestor qualifies. Boot seeds: `pluginDir = CANON_PLUGIN_DIR ?? findAnchorDir(thisDir, ["agents","principles"], isDir)` (repo/plugin root — dir-strict predicate); `mcpServerRoot = CANON_PLUGIN_DIR ? join(pluginDir, "mcp-server") : findAnchorDir(thisDir, ["boot.sh"])` — `boot.sh` marker walk (file; dir-strict NOT applied). `pluginDir` always declared before `mcpServerRoot`.

**`JobManager` per-project** (`server-state.ts`) — `job-manager.ts` holds a `Map<string, JobManager>` keyed by `path.resolve(projectDir)`; `getOrCreateJobManager(projectDir, ...)` is the sole factory; `getJobManager(projectDir)` returns `undefined` for unknown scope; `cleanupAllJobManagers()` tears down all managers at shutdown; `initJobManager` deleted (dead code). Eviction hooks `evictStoresForScope` / `evictDriftDbForScope` present but unwired — deferred to HTTP-transport sub-build per `decisions/isolation-finish-01.md`.

**`http-server.ts`** — `startHttpServer(port?, projectDir?)` seeds module-level `resolvedProjectDir` at startup. `resolvePidDir(): string | null` resolves: `CLAUDE_PLUGIN_DATA` → `{resolvedProjectDir}/.canon` → **returns `null`** (no scope resolvable; errors-as-values, never throws); no `process.cwd()` / `CANON_PROJECT_DIR` fallback. `writePidFile(pidDir?)` writes `{pid}:{port}\n`; `removePidFile` removes only if PID matches; failures WARN, never thrown; skipped in VITEST. `resetStateForTesting()` clears `resolvedProjectDir`.

**`resolveGitRoot(cwd, gitTopLevelFn)`** (`resolve-project-dir.ts`) — returns git repo root for `cwd`; falls back to `cwd` when not in a git repo or git unavailable; errors logged and swallowed (never throws).

**`get_context` tool** (`get-context-handler.ts`) — composite context tool; input: `file_paths[]` + optional `include` (5 sections: `principles`, `file_context`, `drift`, `graph`, `signals`); `file_context` errors fail-closed; graph/signals fail-open; re-exported from `register-knowledge.ts`.

## Invariants
<!-- last-updated: 2026-06-05 -->
- `resolveScope(extra)` is the sole accessor for per-session projectDir — never use `export let projectDir` global (deleted) or `process.cwd()` fallback
- `CANON_PLUGIN_DIR` env var is the first-priority short-circuit for `findAnchorDir`; when unset, marker-walk resolves it at boot
- `pluginDir` must always be declared before `mcpServerRoot` in boot seed code
- `resolvePidDir()` never throws — returns `null` when scope is unresolvable
- ESM module resolution uses co-located symlink, not `NODE_PATH` (CJS-only)
