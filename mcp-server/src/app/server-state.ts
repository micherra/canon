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
// is exactly one connection so setProjectDir() writes here and resolveScope()
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

// Plugin dir: the repo root that contains the `principles/` directory.
// __filename → src/index.ts (or dist/index.js), dirname twice → mcp-server/, once more → repo root.
// Using dirname(fileURLToPath(...)) is more explicit than URL("..") traversal.
const thisFile = fileURLToPath(import.meta.url);
const mcpServerRoot = dirname(dirname(thisFile));
export const pluginDir = resolve(process.env.CANON_PLUGIN_DIR || dirname(mcpServerRoot));

// ── MCP server instance ───────────────────────────────────────────────────────

export const server = new McpServer({
  name: "canon",
  version: "2.4.1", // x-release-please-version
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
