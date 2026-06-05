---
id: per-connection-scope-threading
title: MCP Handler Registration Boundaries Thread Project Scope via resolveScope
severity: convention
scope:
  layers:
    - features
  file_patterns:
    - "mcp-server/src/app/register-*.ts"
    - "mcp-server/src/features/**/tools/*.ts"
    - "mcp-server/src/features/**/services/*.ts"
tags:
  - architecture
  - concurrency
  - mcp
  - scope
---

MCP handler registration boundaries obtain project scope via `resolveScope(extra)` from `@app/server-state.ts`. Services and tools receive scope as an explicit `projectDir: string` parameter. No handler, service, or tool may read `process.cwd()`, `process.env.CANON_PROJECT_DIR`, or any module-global state for per-request project scope.

**Registration shape (gated tools):**
```typescript
gatedWrapHandler(async (input, extra) => tool(input, resolveScope(extra), ...))
```

**Registration shape (journal tools):**
```typescript
wrapHandler(async (input, extra) => logStep(input, resolveScope(extra), ...))
```

**Service/tool signature:**
```typescript
async function tool(input: ToolInput, projectDir: string, ...): Promise<Result>
```

The `projectDir` parameter is used directly; never re-read from module state inside the function body.

## Rationale

The MCP server previously resolved project scope via a module-global `projectDir` set at process startup. Under stdio transport — one process per session — this is correct. Under HTTP transport — multiple concurrent connections in one process — it is a concurrency hazard: two connections from different projects share the same global, and the second connection to arrive overwrites the first's scope mid-request.

Threading `projectDir` explicitly through the registration boundary into each service call eliminates the hazard at the seam where it must be resolved: the handler entry point, where `extra.sessionId` is available to look up the connection's registered scope.

**Behavioral guarantee under stdio:** `resolveScope(extra)` returns the same path as the old `projectDir` global via the `STDIO_SESSION_ID` sentinel registered at startup. This is a behavioral no-op for all existing callers.

**Behavioral guarantee under HTTP (Phase 2):** Each connection's `extra.sessionId` maps to that connection's registered scope via `scopeRegistry`. No cross-project `.canon/` bleed is possible because scope is per-connection, not per-process.

This pattern is the specific *implementation shape* of `minimize-client-side-state` and `information-hiding` in the MCP handler context: the module global is eliminated; `scopeRegistry` stays private; `resolveScope` is the sole accessor.

## Examples

**Bad — module-global consumed inside a tool function:**

```typescript
// tools/log-step.ts — reads module global; breaks under HTTP multi-connection
import { projectDir } from "@app/server-state.js";

async function logStep(input: LogStepInput): Promise<ToolResult<LogStepResult>> {
  const journal = await readJournal(projectDir); // wrong: ignores which connection called this
  // ...
}
```

**Bad — process.cwd() or env var inside a handler:**

```typescript
// register-journal.ts — implicit scope; breaks under HTTP
server.tool("log_step", schema, async (input) => {
  const dir = process.env.CANON_PROJECT_DIR ?? process.cwd(); // breaks under HTTP
  return logStep(input, dir);
});
```

**Good — scope threaded at the registration boundary:**

```typescript
// register-journal.ts
import { resolveScope } from "@app/server-state.js";

server.tool("log_step", schema, wrapHandler(async (input, extra) =>
  logStep(input, resolveScope(extra))
));
```

```typescript
// tools/log-step.ts — no module-global reads
async function logStep(
  input: LogStepInput,
  projectDir: string,    // explicit — set by the registration boundary
): Promise<ToolResult<LogStepResult>> {
  const journal = await readJournal(projectDir);
  // ...
}
```

**Good — gated tool with scope threading:**

```typescript
// register-artifacts.ts
server.tool("store_summaries", schema, gatedWrapHandler(async (input, extra) =>
  storeSummaries(input, resolveScope(extra))
));
```

**Confirmed instances in this codebase:**

| Build | Files migrated | Shape |
|-------|---------------|-------|
| 1a (PR #288) | `server-state.ts` — introduced `resolveScope` + STDIO_SESSION_ID sentinel | Seam introduced |
| 1b (PR #290) | `register-artifacts`, `register-file-context`, `register-knowledge`, `register-pr-review`, `register-agent-teams` | `gatedWrapHandler(async (input, extra) => ...)` |
| 1c (PR #304 wave 1) | `invoke-janitor.ts`, `insights.ts`, `codebase-graph.ts` | `gatedWrapHandler(async (input, extra) => invokeJanitor(input, resolveScope(extra)))` |
| 1d (PR #304 wave 2) | `register-journal` (3 tools), `register-report` (captureTranscript), `register-confidence-tools` (computeAutonomyTier) | `wrapHandler(async (input, extra) => logStep(input, resolveScope(extra), ...))` |

## Exceptions

The following files are permitted to reference `process.cwd()` or `CANON_PROJECT_DIR` because they are the infrastructure that establishes the scope, not consumers of it:

- `mcp-server/src/app/resolve-project-dir.ts` — computes the initial `projectDir` at process startup
- `mcp-server/src/app/http-server.ts` — registers connection scopes into `scopeRegistry` on connection open

New handlers and services added to `mcp-server/src/features/` and `mcp-server/src/app/register-*.ts` are not exceptions — they must use `resolveScope(extra)`.

## Verification

Run the following grep to catch violations (should return zero hits in production files):

```bash
grep -rn "process\.cwd()\|CANON_PROJECT_DIR\|import.*projectDir.*server-state" \
  mcp-server/src/features \
  mcp-server/src/app/register-* \
  --include="*.ts" \
  --exclude="*.test.ts" \
  --exclude-dir="__tests__"
```

Expected output: empty (zero hits) in production handler and service files. Exclude `resolve-project-dir.ts` and `http-server.ts` which are permitted infrastructure files. Test files are excluded from this check — test code legitimately passes `process.cwd()` as a `projectDir` argument.

- [ ] Every new handler in `register-*.ts` threads scope via `resolveScope(extra)` — no inline `process.cwd()` or `process.env.CANON_PROJECT_DIR`.
- [ ] Every new tool or service function in `features/**/tools/*.ts` and `features/**/services/*.ts` that needs `projectDir` accepts it as an explicit parameter.
- [ ] No function body in `features/` reads from module-global state for per-request project scope.
- [ ] The verification grep above returns zero hits after any change to handler registration or tool implementation files.

**Related:** `minimize-client-side-state` — this convention is the specific MCP-handler implementation shape of that principle: the mutable module global is eliminated; scope is explicit and per-connection. `information-hiding` — `scopeRegistry` stays private; `resolveScope` is the sole accessor, so callers never depend on the registry's internal structure. `fail-closed-by-default` — `resolveScope` throws `UnregisteredSessionError` for an unregistered HTTP session ID rather than falling back to a global or empty string.

## Anti-Rationalization

| Excuse | Why It's Wrong | Correct Action |
|--------|---------------|----------------|
| "`process.cwd()` works fine in practice — we only use stdio." | It works until the first HTTP connection. Retrofitting scope threading across all handlers after HTTP is enabled is a large migration under time pressure. | Thread scope now; the migration is already done for all existing handlers (PRs #288–#304). |
| "The `extra` parameter adds noise to every handler signature." | The `gatedWrapHandler` / `wrapHandler` wrappers absorb the `extra` parameter at the boundary. The service function receives a plain `projectDir: string`. | Use the wrapper pattern; service functions stay clean. |
| "I'll use `CANON_PROJECT_DIR` env var as a temporary workaround." | Env vars are process-global. Any workaround that reads a process global reintroduces the concurrency hazard. | There is no safe temporary workaround. Thread scope via `resolveScope(extra)`. |
| "Only my new tool needs this — I can use `process.cwd()` just for now." | One handler reading a global undermines the invariant that services are scope-safe. | Use `resolveScope(extra)` at the registration boundary. It is one line. |
