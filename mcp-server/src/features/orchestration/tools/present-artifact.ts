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

import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDeferredDecision,
  getHttpPort,
  registerArtifact,
  removeArtifact,
} from "@app/http-server.ts";
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
  html?: string; // When provided, serves this HTML directly (bypasses VIEW_MAP)
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
  // Walk up 4 levels → dist/, then join dist/src/ui
  const thisFile = fileURLToPath(import.meta.url);
  const distDir = dirname(dirname(dirname(dirname(dirname(thisFile)))));
  return join(distDir, "src", "ui");
}

/** Fire-and-forget browser open — platform-aware. */
function openBrowser(url: string): void {
  let command: string;
  if (process.platform === "darwin") {
    command = `open "${url}"`;
  } else if (process.platform === "win32") {
    command = `start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (err) => {
    if (err) {
      process.stderr.write(`[present_artifact] browser open failed: ${err.message}\n`);
    }
  });
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export async function presentArtifact(
  input: PresentArtifactInput,
): Promise<ToolResult<PresentArtifactResult>> {
  const { type, slug, data, html: providedHtml } = input;

  let html: string;

  if (providedHtml) {
    // Dynamic HTML path — skip VIEW_MAP lookup and file read
    html = providedHtml;
  } else {
    // Compiled HTML path — existing VIEW_MAP logic (unchanged)
    // 1. Validate artifact type
    const htmlFileName = VIEW_MAP[type];
    if (!htmlFileName) {
      const knownTypes = Object.keys(VIEW_MAP).join(", ");
      return toolError(
        "INVALID_INPUT",
        `Unknown artifact type "${type}". Known types: ${knownTypes}`,
        false,
      );
    }

    // 2. Read compiled HTML
    const uiDistDir = resolveUiDistDir();
    const htmlPath = resolve(uiDistDir, htmlFileName);

    try {
      html = await readFile(htmlPath, "utf-8");
    } catch {
      return toolError(
        "INVALID_INPUT",
        `Compiled HTML not found for artifact type "${type}". Expected: ${htmlPath}. Run the UI build first.`,
        true,
      );
    }
  }

  // 3. Register artifact and create deferred decision
  const key = `${type}/${slug}`;
  const port = getHttpPort();
  const url = `http://127.0.0.1:${port}/artifact/${key}`;

  registerArtifact(key, html, data);
  const decisionPromise = createDeferredDecision(key);

  process.stderr.write(`[present_artifact] serving artifact at ${url}\n`);

  try {
    // 4. Open browser — fire-and-forget
    openBrowser(url);

    // 5. Block until user submits decision
    const decision = await decisionPromise;

    process.stderr.write(
      `[present_artifact] decision received: ${decision.action} (${decision.annotations.length} annotations)\n`,
    );

    return toolOk({ decision, url });
  } finally {
    // 6. Clean up artifact regardless of outcome
    removeArtifact(key);
  }
}
