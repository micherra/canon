import { toolError } from "./tool-result.ts";

/** Standard JSON response wrapper for MCP tool results. */
function jsonResponse(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

/**
 * Wraps an MCP tool handler to:
 * 1. Detect ToolResult with ok:false and convert to MCP error response
 * 2. Catch unexpected throws and convert to typed UNEXPECTED error
 *
 * Both ok:true and ok:false results pass through jsonResponse unchanged.
 * The key value is the catch-all — unexpected throws become typed UNEXPECTED
 * errors instead of opaque MCP SDK error responses.
 */
export function wrapHandler<T>(
  handler: (input: T) => Promise<unknown>,
): (input: T) => Promise<ReturnType<typeof jsonResponse>> {
  return async (input: T) => {
    try {
      const result = await handler(input);
      return jsonResponse(result);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`MCP tool error (unexpected): ${detail}`);
      return jsonResponse(toolError("UNEXPECTED", "An unexpected error occurred"));
    }
  };
}
