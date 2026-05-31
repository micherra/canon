import { toolError } from "./tool-result.ts";

/** Standard JSON response wrapper for MCP tool results. */
function jsonResponse(result: unknown) {
  return { content: [{ text: JSON.stringify(result), type: "text" as const }] };
}

/**
 * Classify a caught error and return the appropriate typed tool-error response.
 *
 * Shared between wrapHandler and gatedWrapHandler so the error-classification
 * logic lives in one place. The `err` parameter is `unknown` only because it
 * mirrors the catch-clause signature — no new `unknown` usage is introduced
 * elsewhere.
 *
 * Observable behavior (error codes, messages, log strings) is identical to the
 * inline catch bodies it replaces.
 */
export function toToolErrorResponse(err: unknown): ReturnType<typeof jsonResponse> {
  const detail = err instanceof Error ? err.message : String(err);
  if (detail.includes("directory does not exist")) {
    console.error(`MCP tool error (workspace not found): ${detail}`);
    return jsonResponse(
      toolError("WORKSPACE_NOT_FOUND", `Workspace directory does not exist`, false, {
        detail,
      }),
    );
  }
  console.error(`MCP tool error (unexpected): ${detail}`);
  return jsonResponse(toolError("UNEXPECTED", "An unexpected error occurred", false, { detail }));
}

/**
 * Wraps an MCP tool handler to:
 * 1. Pass both ok:true and ok:false ToolResult values through jsonResponse unchanged
 * 2. Catch unexpected throws and convert to typed UNEXPECTED error
 *
 * Both ok:true and ok:false results pass through jsonResponse unchanged — the
 * caller (MCP client) receives the typed CanonToolError structure and can inspect
 * error_code/message directly. The key value of this wrapper is the catch-all:
 * unexpected throws become typed UNEXPECTED errors instead of opaque MCP SDK
 * error responses.
 */
export function wrapHandler<T>(
  handler: (input: T) => Promise<unknown>,
): (input: T) => Promise<ReturnType<typeof jsonResponse>> {
  return async (input: T) => {
    try {
      const result = await handler(input);
      return jsonResponse(result);
    } catch (err) {
      return toToolErrorResponse(err);
    }
  };
}
