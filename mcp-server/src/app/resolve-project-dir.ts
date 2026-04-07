import { resolve } from "node:path";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

/**
 * Resolve the project directory by querying the MCP client's workspace roots.
 *
 * After `server.connect(transport)`, the client may expose its open workspace
 * directories via `roots/list`. If a file-URI root is available, we use its
 * path as the project directory (the first root wins). If the request times
 * out, fails, or returns no file roots, we fall back to `fallback` (which is
 * derived from CANON_PROJECT_DIR or process.cwd() at startup time).
 *
 * The AbortController is used to cancel the in-flight `listRoots` request when
 * the timeout fires, preventing the pending MCP request from keeping the Node.js
 * event loop alive indefinitely (the MCP SDK's default request timeout is 60s).
 *
 * @param server     - The underlying MCP `Server` instance (McpServer.server)
 * @param fallback   - Path to use when roots cannot be resolved
 * @param timeoutMs  - Maximum wait time for the roots/list round-trip (default 1000ms)
 */
export const resolveProjectDir = async (
  server: Server,
  fallback: string,
  timeoutMs = 1000,
): Promise<string> => {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeoutPromise = new Promise<null>((res) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        res(null);
      }, timeoutMs);
    });

    const rootsPromise = server.listRoots(undefined, { signal: controller.signal });
    const result = await Promise.race([rootsPromise, timeoutPromise]);

    if (result === null) {
      // Timed out — use fallback
      console.error(
        `[canon] roots/list timed out after ${timeoutMs}ms — using fallback project dir: ${fallback}`,
      );
      return fallback;
    }

    // Got a response before timeout — cancel the timeout timer.
    clearTimeout(timeoutHandle);

    const fileRoot = result.roots.find((r) => r.uri.startsWith("file://"));
    if (!fileRoot) {
      // No file roots — use fallback
      return fallback;
    }

    // Convert file URI to an absolute path and make it absolute just in case.
    const fromUri = new URL(fileRoot.uri).pathname;
    return resolve(fromUri);
  } catch (err) {
    clearTimeout(timeoutHandle);
    // AbortError means the timeout fired and cancelled the in-flight request.
    // Log the same "timed out" message so callers get consistent diagnostics.
    const isAbort =
      err instanceof Error && (err.name === "AbortError" || err.message === "Aborted");
    if (isAbort) {
      console.error(
        `[canon] roots/list timed out after ${timeoutMs}ms — using fallback project dir: ${fallback}`,
      );
    }
    return fallback;
  }
};
