import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESOURCE_MIME_TYPE,
  RESOURCE_URI_META_KEY,
  registerAppResource,
} from "@modelcontextprotocol/ext-apps/server";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { installFuzzyValidation } from "@shared/lib/fuzzy-field-validation.ts";
import { toToolErrorResponse } from "@shared/lib/wrap-handler.ts";

// ── Per-connection scope registry ─────────────────────────────────────────────
//
// Sentinel session ID used for the single stdio connection.  Under stdio there
// is exactly one connection so registerConnectionScope(STDIO_SESSION_ID, ...) writes here and resolveScope()
// reads back the same value — behaviorally identical to the old module global.
//
// Under HTTP (Phase 2) each connection will have its own sessionId and will
// call registerConnectionScope() after resolving roots/list.
export const STDIO_SESSION_ID = "__stdio__";

// Map<sessionId, projectDir> — the per-connection memoisation table.
// Module-private; callers outside this file must use the helper functions.
const scopeRegistry = new Map<string, string>();

/**
 * Register a resolved project directory for a specific MCP session/connection.
 * Overwrites any previous value for the same session (idempotent re-connect).
 */
export function registerConnectionScope(sessionId: string, dir: string): void {
  scopeRegistry.set(sessionId, dir);
}

/**
 * Remove the scope entry for a session that has disconnected.
 * No-op for unknown session IDs.
 *
 * // Phase 2: call evictStoresForScope/evictDriftDbForScope from the connection-end handler
 */
export function clearConnectionScope(sessionId: string): void {
  scopeRegistry.delete(sessionId);
}

/**
 * Resolve the project directory for the current request context.
 *
 * Lookup order:
 *   1. Per-session entry keyed by extra.sessionId (present under HTTP)
 *   2. Stdio sentinel entry (keyed by STDIO_SESSION_ID) — seeded in main() via
 *      registerConnectionScope(STDIO_SESSION_ID, resolvedDir)
 *
 * Under stdio the sentinel is always present after startup, so this never throws
 * in production. Under HTTP an unregistered session fails closed instead of
 * leaking the daemon cwd — closing the TODO(1b) cross-tenant leak hazard.
 *
 * Startup seed: call registerConnectionScope(STDIO_SESSION_ID, resolvedDir) in
 * main() after resolveProjectDir() completes. Under HTTP (Phase 2) each
 * connection will call registerConnectionScope() with its own resolved dir.
 */
export function resolveScope(
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
): string {
  const sessionId = extra.sessionId;
  if (sessionId) {
    const perSession = scopeRegistry.get(sessionId);
    if (perSession !== undefined) return perSession;
  }
  // Fall back to the stdio sentinel.
  const sentinel = scopeRegistry.get(STDIO_SESSION_ID);
  if (sentinel !== undefined) return sentinel;
  throw new Error(
    `resolveScope: no project scope for session ${sessionId ?? "(none)"} — ` +
      `connection not registered (registerConnectionScope was never called)`,
  );
}

// ── Ready gate ────────────────────────────────────────────────────────────────
//
// Promise that resolves once the project directory has been confirmed.
// All tool handlers must await this before accessing projectDir to avoid the startup
// race where a client call arrives before roots/list has completed.
//
// We create the promise here (at module load) with an external resolve handle so
// gatedWrapHandler can safely await it before main() runs — in that edge case
// (which never happens in production) the promise stays pending until main() resolves it.
export let resolveReady!: () => void;
export let readyPromise: Promise<void> = new Promise<void>((res) => {
  resolveReady = res;
});

// ── Plugin dir ────────────────────────────────────────────────────────────────

/**
 * Walk up from `startDir` until a directory containing every `markers` entry is found.
 * Returns the first matching ancestor directory.
 *
 * Pure function with an injectable `existsFn` seam for unit testing — callers pass a
 * fake existsFn to drive the walk without real filesystem stat calls.
 *
 * Throws a clear diagnostic error if no matching ancestor is found and the env override
 * is not set — fail-closed so a misconfigured install fails loudly at boot rather than
 * silently producing a wrong path that ENOENTs later at an opaque call site.
 */
export function findAnchorDir(
  startDir: string,
  markers: readonly string[],
  existsFn: (p: string) => boolean = existsSync,
): string {
  let dir = startDir;
  for (;;) {
    if (markers.every((m) => existsFn(join(dir, m)))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Canon plugin root not found from ${startDir}: no ancestor contains ` +
          `[${markers.join(", ")}]. Set CANON_PLUGIN_DIR to override.`,
      );
    }
    dir = parent;
  }
}

// Plugin dir: the repo/plugin root that contains Canon's asset directories (agents/, principles/, …).
// Resolved by walking up from this module's directory to the first ancestor containing those marker
// directories — robust to this file moving or any future dist/ layout. A fixed dirname count is what
// broke this before (the module is at src/app/, not src/ as the old comment assumed).
//
// Directory-strict predicate: agents/ and principles/ are directories. A bare existsSync check would
// match a stray file named "agents" or "principles". We use a dir-strict predicate for that walk only.
// boot.sh is a plain file, so its walk keeps the default existsSync predicate.
const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();

const thisDir = dirname(fileURLToPath(import.meta.url));

// pluginDir resolved first — mcpServerRoot may derive from it when the env override is set.
export const pluginDir = process.env.CANON_PLUGIN_DIR
  ? resolve(process.env.CANON_PLUGIN_DIR)
  : findAnchorDir(thisDir, ["agents", "principles"], isDir);

// mcpServerRoot is always the mcp-server/ subdirectory of pluginDir.
// When CANON_PLUGIN_DIR is set, derive directly from the already-resolved pluginDir so both
// roots honour the same env override without an independent boot.sh marker walk.
const mcpServerRoot = process.env.CANON_PLUGIN_DIR
  ? join(pluginDir, "mcp-server")
  : findAnchorDir(thisDir, ["boot.sh"]);

// ── MCP server instance ───────────────────────────────────────────────────────

export const server = new McpServer({
  name: "canon",
  version: "2.7.0", // x-release-please-version
});

// Patch validation to detect unknown fields with fuzzy "did you mean?" suggestions.
installFuzzyValidation(server);

// ── Standard JSON response helper (inline — keeps gatedWrapHandler self-contained) ──

function jsonResponse(result: unknown) {
  return { content: [{ text: JSON.stringify(result), type: "text" as const }] };
}

/**
 * Gate all tool handlers until projectDir is resolved.
 *
 * Wraps a handler that accepts `(input, extra)` and:
 * 1. Awaits readyPromise before calling the inner handler (startup race guard)
 * 2. Converts unexpected throws to typed UNEXPECTED errors
 * 3. Passes the MCP request context (extra) through to the inner handler so
 *    1b can use resolveScope(extra) per request
 *
 * Handlers that do not yet use extra (all existing register-*.ts handlers) are
 * valid — JavaScript ignores surplus positional arguments.
 */
export const gatedWrapHandler =
  <T>(
    handler: (
      input: T,
      extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
    ) => Promise<unknown>,
  ) =>
  async (
    input: T,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ): Promise<ReturnType<typeof jsonResponse>> => {
    try {
      await readyPromise;
      const result = await handler(input, extra);
      return jsonResponse(result);
    } catch (err) {
      return toToolErrorResponse(err);
    }
  };

// ── Test helpers ──────────────────────────────────────────────────────────────
//
// resetForTesting() resets all mutable module state so unit tests can run in
// isolation without module re-loading.  Not called in production.

export function resetForTesting(): void {
  scopeRegistry.clear();
  // Replace the ready promise with a fresh pending one and a fresh resolver.
  readyPromise = new Promise<void>((res) => {
    resolveReady = res;
  });
}

// ── MCP App UI registration ───────────────────────────────────────────────────

/** Helper to register a tool + resource pair for an MCP App UI. */
export const registeredResources = new Set<string>();

/** Options for registering a tool with an MCP App UI. */
export type RegisterToolWithUiOptions<Schema extends ZodRawShapeCompat> = {
  resourceUri: string;
  title: string;
  description: string;
  inputSchema: Schema;
  htmlFile: string;
  handler: ToolCallback<Schema>;
};

export function registerToolWithUi<Schema extends ZodRawShapeCompat>(
  toolName: string,
  options: RegisterToolWithUiOptions<Schema>,
) {
  const { resourceUri, title, description, inputSchema, htmlFile, handler } = options;
  server.registerTool(
    toolName,
    {
      _meta: { ui: { resourceUri }, [RESOURCE_URI_META_KEY]: resourceUri },
      description,
      inputSchema,
      title,
    },
    handler,
  );

  if (!registeredResources.has(resourceUri)) {
    registeredResources.add(resourceUri);
    registerAppResource(server, title, resourceUri, { mimeType: RESOURCE_MIME_TYPE }, async () => {
      const html = await readFile(join(mcpServerRoot, "dist", "src", "ui", htmlFile), "utf-8");
      return {
        contents: [{ mimeType: RESOURCE_MIME_TYPE, text: html, uri: resourceUri }],
      };
    });
  }
}
