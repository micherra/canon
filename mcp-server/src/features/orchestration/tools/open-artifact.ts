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

import { readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { getHttpPort, isHttpServerRunning, registerArtifact } from "@app/http-server.ts";
import { openBrowser } from "@platform/adapters/process-adapter.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";

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

  // Validate: artifact_name must not escape the artifacts directory
  const artifactsDir = join(workspace, "artifacts");
  const resolvedArtifactsDir = resolve(artifactsDir);
  const resolvedTarget = resolve(join(artifactsDir, name));

  const rel = relative(resolvedArtifactsDir, resolvedTarget);
  if (rel.startsWith("..") || rel.startsWith("/")) {
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
    return toolError(
      "INVALID_INPUT",
      `Artifact file not found: "${artifact_name}". Check that the file exists in ${artifactsDir}.`,
      false,
    );
  }

  // Register and serve the artifact
  const key = `open-artifact/${name}`;
  const url = `http://127.0.0.1:${getHttpPort()}/artifact/${key}`;
  registerArtifact(key, html, {});

  process.stderr.write(`[open_artifact] serving artifact at ${url}\n`);

  openBrowser(url);

  return toolOk({ url });
}
