/**
 * present_artifact MCP tool.
 *
 * Serves a compiled HTML artifact via the Canon HTTP server, opens it in the
 * default browser, and blocks until the user submits a decision (approve /
 * request_changes) in the browser.
 *
 * ## Lifecycle
 * 1. Validate artifact type against VIEW_MAP.
 * 2. Read compiled HTML from dist/src/ui/ (built by Vite).
 * 3. Register artifact with HTTP server (registerArtifact).
 * 4. Open browser URL — fire-and-forget (exec).
 * 5. Block on createDeferredDecision until user clicks Approve/Request Changes.
 * 6. Clean up in finally block (removeArtifact).
 * 7. Return { decision, url }.
 *
 * All logging goes to process.stderr — process.stdout is the MCP stdio transport.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDeferredDecision,
  getHttpPort,
  isHttpServerRunning,
  registerArtifact,
  removeArtifact,
} from "@app/http-server.ts";
import { openBrowser } from "@platform/adapters/process-adapter.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";

// ---------------------------------------------------------------------------
// View map — artifact type → compiled HTML filename in dist/src/ui/
// ---------------------------------------------------------------------------

const VIEW_MAP: Record<string, string> = {
  "planning-brief": "planning-brief.html",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PresentArtifactInput = {
  workspace: string;
  type: string;
  slug: string;
  data: unknown;
};

export type PresentArtifactResult = {
  decision: {
    action: "approve" | "request_changes";
    annotations: unknown[];
  };
  url: string;
};

// ---------------------------------------------------------------------------
// Browser open helpers
// ---------------------------------------------------------------------------

/** Resolve the dist/src/ui directory relative to this module's compiled location. */
function resolveUiDistDir(): string {
  // When compiled: dist/src/features/orchestration/tools/present-artifact.js
  // Walk up 5 levels → dist/, then join dist/src/ui
  const thisFile = fileURLToPath(import.meta.url);
  const distDir = dirname(dirname(dirname(dirname(dirname(thisFile)))));
  return join(distDir, "src", "ui");
}

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

  const htmlFileName = VIEW_MAP[type];
  if (!htmlFileName) {
    return toolError(
      "INVALID_INPUT",
      `Unknown artifact type "${type}". Known types: ${Object.keys(VIEW_MAP).join(", ")}`,
      false,
    );
  }

  const htmlPath = resolve(resolveUiDistDir(), htmlFileName);
  let html: string;
  try {
    html = await readFile(htmlPath, "utf-8");
  } catch {
    return toolError(
      "INVALID_INPUT",
      `Compiled HTML not found for artifact type "${type}". Expected: ${htmlPath}. Run the UI build first.`,
      true,
    );
  }

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
  const decisionPromise = createDeferredDecision(key);

  process.stderr.write(`[present_artifact] serving artifact at ${url}\n`);

  try {
    openBrowser(url);
    const decision = await decisionPromise;

    process.stderr.write(
      `[present_artifact] decision received: ${decision.action} (${decision.annotations.length} annotations)\n`,
    );

    return toolOk({ decision, url });
  } finally {
    removeArtifact(key);
  }
}
