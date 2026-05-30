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
import { installFuzzyValidation } from "@shared/lib/fuzzy-field-validation.ts";
import { wrapHandler } from "@shared/lib/wrap-handler.ts";

// Resolve project dir via priority chain (updated post-connect by resolveProjectDir() in main()):
//   1. CANON_PROJECT_DIR env var (only when set AND is an absolute path) — escape hatch for CI/multi-project
//   2. roots/list first root from MCP client — standard MCP mechanism for user's working directory
//   3. process.cwd() fallback — for clients that don't support roots
export let projectDir = process.cwd();

/** Update the project directory (called from main() after roots/list). */
export function setProjectDir(dir: string): void {
  projectDir = dir;
}

// Promise that resolves once the project directory has been confirmed.
// All tool handlers must await this before accessing projectDir to avoid the startup
// race where a client call arrives before roots/list has completed.
//
// We create the promise here (at module load) with an external resolve handle so
// gatedWrapHandler can safely await it before main() runs — in that edge case
// (which never happens in production) the promise stays pending until main() resolves it.
export let resolveReady!: () => void;
export const readyPromise: Promise<void> = new Promise<void>((res) => {
  resolveReady = res;
});

// Plugin dir: the repo root that contains the `principles/` directory.
// __filename → src/index.ts (or dist/index.js), dirname twice → mcp-server/, once more → repo root.
// Using dirname(fileURLToPath(...)) is more explicit than URL("..") traversal.
const thisFile = fileURLToPath(import.meta.url);
const mcpServerRoot = dirname(dirname(thisFile));
export const pluginDir = resolve(process.env.CANON_PLUGIN_DIR || dirname(mcpServerRoot));

export const server = new McpServer({
  name: "canon",
  version: "2.3.1",
});

// Patch validation to detect unknown fields with fuzzy "did you mean?" suggestions.
installFuzzyValidation(server);

/**
 * Gate all tool handlers until projectDir is resolved.
 *
 * wrapHandler delegates to the underlying handler immediately, but this
 * wrapper first awaits readyPromise so handlers never run against the wrong
 * directory during the startup race window (between server.connect() and
 * resolveProjectDir() completing).
 */
export const gatedWrapHandler = <T>(handler: (input: T) => Promise<unknown>) =>
  wrapHandler(async (input: T) => {
    await readyPromise;
    return handler(input);
  });

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
