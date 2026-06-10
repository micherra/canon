# app/ — Entry Point and Server State

<!-- Managed by Canon. Manual edits are preserved. -->

## Purpose
Entry point for the Canon MCP server: tool registration, HTTP server lifecycle, project-directory resolution, and per-connection scope management.

## Architecture
<!-- last-updated: 2026-06-08 -->

**Key files:**

| File | Responsibility |
|------|---------------|
| `index.ts` | Server entry — calls `registerConnectionScope(STDIO_SESSION_ID, resolvedDir)` at startup; all `register-*.ts` wired here via `createCanonServer()` |
| `create-server.ts` | `createCanonServer()` per-session factory — creates, fuzzy-validates, and fully-wires a new `McpServer`; exports `CANON_SERVER_NAME` / `CANON_SERVER_VERSION` (x-release-please-version marker) |
| `server-state.ts` | Per-connection scope registry (`resolveScope(extra)`), `findAnchorDir` boot helper; per-session ready gates (`createSessionReadyGate`/`resolveSessionReady`/`clearSessionReady`/`readyPromiseFor`); `getScopeForSession`/`hasOtherSessionsForDir` for refcount eviction |
| `daemon.ts` | HTTP daemon on `:3142` (`CANON_DAEMON_PORT`); auth-gated `POST /mcp` (503 on token-missing fail-closed); `/health` `{ok,port,version,transport:"http"}`; PID file `canon-daemon.pid` (pid\nport); `probeExistingDaemon`; SIGTERM teardown; flag-dark (`CANON_HTTP_DAEMON=1`) |
| `http-routes.ts` | `handleArtifactRoutes(req,res,RouteContext)` — extracted from `http-server.ts`; handles artifact and health routes; loopback Host guard applied by callers (`http-server.ts`, daemon) via `mcp-http/loopback-host.ts` before routing |
| `http-server.ts` | Sidecar HTTP server on `:3141` — `startHttpServer`, `stopHttpServer`, lifecycle management; Host-header guard (F2: rejects non-loopback/missing Host with 403 via `isLoopbackHostRequest`); no `Access-Control-Allow-Origin` header (F2: ACAO `*` removed) |
| `resolve-project-dir.ts` | `resolveGitRoot(cwd, gitTopLevelFn)` — git root or cwd fallback; never throws |
| `get-context-handler.ts` | `get_context` composite tool handler; re-exported from `register-knowledge.ts` |
| `register-*.ts` | One file per feature boundary — each takes `server: McpServer` as first param and registers its MCP tools via `gatedWrapHandler` |
| `mcp-http/` | HTTP transport auth + session management subsystem (flag-dark). See `mcp-http/.claude/CLAUDE.md`. |

## Contracts
<!-- last-updated: 2026-06-09 -->

**`createCanonServer()`** (`create-server.ts`) — per-session factory; creates and fully-wires a new `McpServer` instance (calls all 16 `register-*.ts` in order); uses `WeakMap<McpServer, Set<string>>` for per-server resource dedup in `registerToolWithUi`. `CANON_SERVER_NAME = "canon"` and `CANON_SERVER_VERSION` (x-release-please-version) exported here (moved from `server-state.ts`).

**`boot.sh`** (`mcp-server/boot.sh`) — self-resolving launcher; never uses `npx`. Key steps: resolve `SERVER_DIR` via `CLAUDE_PLUGIN_ROOT` or `BASH_SOURCE`; poll `DATA_DIR/.bin/tsx` when `CLAUDE_PLUGIN_DATA` set (timeout `CANON_BOOT_DEPS_TIMEOUT`, default 60s); ESM co-location symlink (`ln -s DATA_DIR SERVER_DIR/node_modules`) — idempotent, `ln` failure degrades gracefully; dangling-symlink guard exits 1 (skipped under `--print-resolution`); **Step 12.5 Node-version preflight**: resolves node via `(cd "$SERVER_DIR" && node -v)`, exits 1 with a clear actionable message if node is absent or major < 24 (fail-closed; skipped under `--print-resolution`); `--print-resolution` prints `SERVER_DIR NODE_PATH TSX_BIN` and exits 0. **ESM/NODE_PATH pitfall**: `NODE_PATH` is CJS-only — ESM uses the co-located symlink; missing/dangling symlink → `ERR_MODULE_NOT_FOUND`. See `references/plugin-server-boot.md`.

**`resolveScope(extra)`** (`server-state.ts`) — sole accessor for project-dir scope. Lookup order: (1) per-session registry keyed by `extra.sessionId`; (2) `STDIO_SESSION_ID = "__stdio__"` sentinel. Fails closed (throws) for unregistered sessions. `registerConnectionScope` / `clearConnectionScope` manage the registry. Per-session ready gates: `createSessionReadyGate(sessionId)` / `resolveSessionReady(sessionId)` / `clearSessionReady(sessionId)` / `readyPromiseFor(extra)` (falls back to global gate when `sessionId` absent — preserves stdio path). `getScopeForSession(sessionId)` reads scope without removing. `hasOtherSessionsForDir(dir)` scans registry for refcount eviction. `resetForTesting()` clears all mutable state including the `sessionReady` map.

**`findAnchorDir(startDir, markers[], existsFn?)`** (`server-state.ts`) — walks up from `startDir` until a directory containing every `markers[]` entry is found; injectable `existsFn` seam (default `existsSync`); throws with diagnostic message (names missing markers and `CANON_PLUGIN_DIR` escape hatch) when no ancestor qualifies. Boot seeds: `pluginDir = CANON_PLUGIN_DIR ?? findAnchorDir(thisDir, ["agents","principles"], isDir)` (repo/plugin root — dir-strict predicate); `mcpServerRoot = CANON_PLUGIN_DIR ? join(pluginDir, "mcp-server") : findAnchorDir(thisDir, ["boot.sh"])` — `boot.sh` marker walk (file; dir-strict NOT applied). `pluginDir` always declared before `mcpServerRoot`.

**`JobManager` per-project** (`src/platform/jobs/job-manager.ts`) — holds a `Map<string, JobManager>` keyed by `path.resolve(projectDir)`; `getOrCreateJobManager(projectDir, ...)` is the sole factory; `getJobManager(projectDir)` returns `undefined` for unknown scope; `cleanupAllJobManagers()` tears down all managers at shutdown; `evictJobManagerForScope(projectDir)` — cleanup + delete in try/finally for HTTP session teardown (isolation-finish-01).

**`http-server.ts`** — `startHttpServer(port?, projectDir?)` seeds module-level `resolvedProjectDir` at startup. Host-header guard: `handleRequest` calls `isLoopbackHostRequest(req)` (from `mcp-http/loopback-host.ts`) before routing; non-loopback or missing Host → 403 `{ error: "Host header rejected" }` (F2 fix, fail-closed). No `Access-Control-Allow-Origin` header set — artifacts opened via direct browser navigation, not cross-origin fetch (F2 fix). `resolvePidDir(): string | null` resolves: `CLAUDE_PLUGIN_DATA` → `{resolvedProjectDir}/.canon` → **returns `null`** (no scope resolvable; errors-as-values, never throws); no `process.cwd()` / `CANON_PROJECT_DIR` fallback. `writePidFile(pidDir?)` writes `{pid}:{port}\n`; `removePidFile` removes only if PID matches; failures WARN, never thrown; skipped in VITEST. `resetStateForTesting()` clears `resolvedProjectDir`.

**`resolveGitRoot(cwd, gitTopLevelFn)`** (`resolve-project-dir.ts`) — returns git repo root for `cwd`; falls back to `cwd` when not in a git repo or git unavailable; errors logged and swallowed (never throws).

**`get_context` tool** (`get-context-handler.ts`) — composite context tool; input: `file_paths[]` + optional `include` (5 sections: `principles`, `file_context`, `drift`, `graph`, `signals`); `file_context` errors fail-closed; graph/signals fail-open; re-exported from `register-knowledge.ts`.

## Invariants
<!-- last-updated: 2026-06-08 -->
- Sidecar `:3141` (`http-server.ts`) rejects requests with missing or non-loopback Host headers with 403 before routing — fail-closed; `isLoopbackHostRequest` from `mcp-http/loopback-host.ts` is the sole guard implementation
- Sidecar `:3141` does not set `Access-Control-Allow-Origin` — artifacts served via direct browser navigation, never cross-origin fetch; ACAO `*` would be a data-exfiltration risk
- `resolveScope(extra)` is the sole accessor for per-session projectDir — never use `export let projectDir` global (deleted) or `process.cwd()` fallback
- `createCanonServer()` is the sole factory for `McpServer` instances — module-level singleton export deleted; each HTTP session gets its own instance
- `CANON_PLUGIN_DIR` env var is the first-priority short-circuit for `findAnchorDir`; when unset, marker-walk resolves it at boot
- `pluginDir` must always be declared before `mcpServerRoot` in boot seed code
- `resolvePidDir()` never throws — returns `null` when scope is unresolvable
- ESM module resolution uses co-located symlink, not `NODE_PATH` (CJS-only)
- HTTP daemon (`daemon.ts`) is flag-dark until Phase 3 — active only when `CANON_HTTP_DAEMON=1`; stdio transport path is unchanged
- `daemon.ts` calls `resolveReady()` at boot (global gate) — per-session gates still govern tool handlers; no sentinel scope registered
