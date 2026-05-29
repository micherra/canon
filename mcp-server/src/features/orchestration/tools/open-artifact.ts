/**
 * open_artifact MCP tool.
 *
 * Reads an HTML file from `${workspace}/artifacts/${artifact_name}` and
 * opens it in the default browser via the Canon HTTP server. Returns
 * immediately — fire-and-forget, same pattern as present_artifact.
 *
 * ## Lifecycle
 * 1. Validate path traversal (artifact_name must stay within artifacts/).
 * 2. Validate file exists.
 * 3. Check HTTP server is running.
 * 4. Read HTML file contents.
 * 5. Register artifact with HTTP server (registerArtifact).
 * 6. Open browser URL — fire-and-forget.
 * 7. Return { url } immediately.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { getHttpPort, isHttpServerRunning, registerArtifact } from "@app/http-server.ts";
import { openBrowser } from "@platform/adapters/process-adapter.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";

const SAFE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OpenArtifactInput = {
  workspace: string;
  artifact_name: string;
};

export type OpenArtifactResult = {
  url: string;
};

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

/**
 * Opens an HTML artifact from the workspace artifacts directory in the browser.
 *
 * @param input.workspace - Absolute path to the Canon workspace directory.
 * @param input.artifact_name - Name of the artifact file (e.g. "review.html" or "review").
 *   The `.html` extension is appended automatically when not present.
 * @returns `Ok({ url })` on success with the browser URL for the artifact;
 *   `Err(INVALID_INPUT)` when path traversal is detected or the file does not exist;
 *   `Err(UNEXPECTED)` when the HTTP server is not running.
 */
export async function openArtifact(
  input: OpenArtifactInput,
): Promise<ToolResult<OpenArtifactResult>> {
  const { workspace, artifact_name } = input;

  // Normalize artifact name — append .html if missing
  const name = extname(artifact_name) === "" ? `${artifact_name}.html` : artifact_name;

  // Reject path separators and unsafe characters
  if (!SAFE_NAME_PATTERN.test(name)) {
    return toolError(
      "INVALID_INPUT",
      `Artifact name "${artifact_name}" contains invalid characters. Only alphanumeric, dots, underscores, and hyphens are allowed (no path separators).`,
      false,
    );
  }

  // Validate: resolved path must remain inside the artifacts directory
  const artifactsDir = join(workspace, "artifacts");
  const resolvedTarget = resolve(join(artifactsDir, name));

  if (!resolvedTarget.startsWith(resolve(artifactsDir)) || isAbsolute(artifact_name)) {
    return toolError(
      "INVALID_INPUT",
      `Artifact name "${artifact_name}" resolves to a path outside the workspace artifacts directory. Path traversal is not allowed.`,
      false,
    );
  }

  // Check HTTP server is running before doing filesystem work
  if (!isHttpServerRunning()) {
    return toolError(
      "UNEXPECTED",
      "Canon HTTP server is not running. The server may have failed to start (e.g., port already in use). Restart the MCP server to resolve.",
      true,
    );
  }

  // Read the HTML file
  let html: string;
  try {
    html = await readFile(resolvedTarget, "utf8");
  } catch {
    // File does not exist or is unreadable — return descriptive error to caller
    return toolError(
      "INVALID_INPUT",
      `Artifact file not found: "${artifact_name}". Check that the file exists in ${artifactsDir}.`,
      false,
    );
  }

  // Register with workspace-scoped key to avoid collisions across builds
  const wsHash = createHash("sha256").update(workspace).digest("hex").slice(0, 8);
  const slug = `${wsHash}-${basename(name, extname(name))}`;
  const key = `open-artifact/${slug}`;
  const url = `http://127.0.0.1:${getHttpPort()}/artifact/${key}`;
  registerArtifact(key, html, {});

  process.stderr.write(`[open_artifact] serving artifact at ${url}\n`);

  openBrowser(url);

  return toolOk({ url });
}
