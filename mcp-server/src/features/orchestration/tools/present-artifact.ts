/**
 * present_artifact MCP tool.
 *
 * Serves an HTML artifact via the Canon HTTP server and opens it in
 * the default browser. Returns immediately — the actual approve/reject decision
 * happens in the terminal; the browser view is display-only.
 *
 * ## Lifecycle
 * 1. Validate input (slug format, html present).
 * 2. Register artifact with HTTP server (registerArtifact).
 * 3. Open browser URL — fire-and-forget (exec).
 * 4. Return { url } immediately.
 *
 * The artifact stays registered so the user can refresh the browser tab.
 * All logging goes to process.stderr — process.stdout is the MCP stdio transport.
 */

import { getHttpPort, isHttpServerRunning, registerArtifact } from "@app/http-server.ts";
import { openBrowser } from "@platform/adapters/process-adapter.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PresentArtifactInput = {
  workspace: string;
  type: string;
  slug: string;
  data: unknown;
  /** HTML content to serve. Required — the html parameter is the only supported path. */
  html?: string;
};

export type PresentArtifactResult = {
  url: string;
};

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/** Safe slug pattern: alphanumeric, dots, underscores, hyphens only. */
const SLUG_PATTERN = /^[A-Za-z0-9._-]+$/;

type ResolvedArtifact = { html: string; key: string; url: string };

/** Validate input and resolve the artifact HTML. Returns an error result or the resolved artifact. */
async function resolveArtifact(input: PresentArtifactInput): Promise<ToolResult<ResolvedArtifact>> {
  const { type, slug } = input;

  if (!SLUG_PATTERN.test(slug)) {
    return toolError(
      "INVALID_INPUT",
      `Invalid slug "${slug}". Slug must match ^[A-Za-z0-9._-]+$ (no slashes, spaces, or special characters).`,
      false,
    );
  }

  if (input.html === undefined) {
    return toolError(
      "INVALID_INPUT",
      `No html content provided for artifact type "${type}". Pass the html parameter directly.`,
      false,
    );
  }

  const html = input.html;

  if (!isHttpServerRunning()) {
    return toolError(
      "UNEXPECTED",
      "Canon HTTP server is not running. The server may have failed to start (e.g., port already in use). Restart the MCP server to resolve.",
      true,
    );
  }

  const key = `${type}/${slug}`;
  const url = `http://127.0.0.1:${getHttpPort()}/artifact/${key}`;
  return toolOk({ html, key, url });
}

export async function presentArtifact(
  input: PresentArtifactInput,
): Promise<ToolResult<PresentArtifactResult>> {
  const resolved = await resolveArtifact(input);
  if (!resolved.ok) return resolved;

  const { html, key, url } = resolved;
  registerArtifact(key, html, input.data);

  process.stderr.write(`[present_artifact] serving artifact at ${url}\n`);

  openBrowser(url);

  return toolOk({ url });
}
