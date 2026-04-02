/**
 * Fuzzy field name validation for MCP tool inputs.
 *
 * When the SDK's Zod validation strips unknown keys (default `strip` mode),
 * a misspelled required field surfaces as a cryptic "expected string, received
 * undefined" error. This utility detects unknown fields before Zod strips them
 * and produces actionable suggestions like:
 *
 *   Unknown field "status" in report_result — did you mean "status_keyword"?
 *
 * Usage: call `installFuzzyValidation(server)` after creating the McpServer
 * but before connecting the transport. It patches `validateToolInput` to run
 * fuzzy field checks before the standard Zod parse.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ---------------------------------------------------------------------------
// Levenshtein distance
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ---------------------------------------------------------------------------
// Suggestion logic
// ---------------------------------------------------------------------------

const MAX_DISTANCE = 3;

/**
 * For a given unknown key, find the best match among known keys.
 * Returns the suggestion or null if nothing is close enough.
 */
export function suggestField(unknown: string, knownKeys: string[]): string | null {
  let best: string | null = null;
  let bestDist = Infinity;

  for (const known of knownKeys) {
    // Substring match — catches "status" vs "status_keyword"
    if (known.includes(unknown) || unknown.includes(known)) {
      const dist = levenshtein(unknown, known);
      if (dist < bestDist) {
        bestDist = dist;
        best = known;
      }
      continue;
    }

    const dist = levenshtein(unknown, known);
    if (dist <= MAX_DISTANCE && dist < bestDist) {
      bestDist = dist;
      best = known;
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Pre-validation check
// ---------------------------------------------------------------------------

/**
 * Check raw input for unknown fields and return error messages with suggestions.
 */
export function checkUnknownFields(toolName: string, input: Record<string, unknown>, knownKeys: string[]): string[] {
  const knownSet = new Set(knownKeys);
  const errors: string[] = [];

  for (const key of Object.keys(input)) {
    if (knownSet.has(key)) continue;

    const suggestion = suggestField(key, knownKeys);
    const hint = suggestion ? ` — did you mean "${suggestion}"?` : "";
    errors.push(`Unknown field "${key}" in ${toolName}${hint}`);
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Server patch
// ---------------------------------------------------------------------------

/**
 * Extract known field names from a tool's inputSchema.
 * Works with raw shapes (Record<string, ZodSchema>) and ZodObject instances.
 */
function getSchemaKeys(inputSchema: unknown): string[] | null {
  if (!inputSchema || typeof inputSchema !== "object") return null;

  // Raw shape: Record<string, ZodSchema> — values have _def
  const entries = Object.entries(inputSchema as Record<string, unknown>);
  if (entries.length === 0) return [];

  // Check if it looks like a raw shape (all values are Zod schemas)
  const looksLikeZodSchema = (v: unknown): boolean =>
    typeof v === "object" && v !== null && ("_def" in v || typeof (v as { parse?: unknown }).parse === "function");
  const isRawShape = entries.every(([, v]) => looksLikeZodSchema(v));
  if (isRawShape) {
    return entries.map(([k]) => k);
  }

  // ZodObject — has .shape
  const asObj = inputSchema as { shape?: Record<string, unknown> };
  if (asObj.shape && typeof asObj.shape === "object") {
    return Object.keys(asObj.shape);
  }

  return null;
}

/**
 * Install fuzzy field validation on an McpServer instance.
 *
 * Patches the internal `validateToolInput` method to run a fuzzy field check
 * before the standard Zod validation. When unknown fields are detected, the
 * error message includes "did you mean" suggestions.
 *
 * The original schema, JSON schema generation, and handler types are unchanged.
 */
export function installFuzzyValidation(server: McpServer): void {
  // Patch the instance (not the prototype) so other McpServer instances are unaffected.
  // biome-ignore lint/suspicious/noExplicitAny: patching private SDK internals requires dynamic access
  const serverAny = server as any;
  const originalValidate: ((...args: unknown[]) => unknown) | undefined =
    serverAny.validateToolInput?.bind(server) ?? Object.getPrototypeOf(server).validateToolInput?.bind(server);

  if (!originalValidate) {
    // SDK version doesn't have validateToolInput — skip gracefully
    return;
  }

  serverAny.validateToolInput = async (
    tool: { inputSchema?: unknown },
    args: Record<string, unknown> | undefined,
    toolName: string,
  ) => {
    // Run fuzzy check before Zod validation
    if (args && tool.inputSchema) {
      const knownKeys = getSchemaKeys(tool.inputSchema);
      if (knownKeys) {
        const errors = checkUnknownFields(toolName, args, knownKeys);
        if (errors.length > 0) {
          const { McpError, ErrorCode } = await import("@modelcontextprotocol/sdk/types.js");
          throw new McpError(
            ErrorCode.InvalidParams,
            `Input validation error: Invalid arguments for tool ${toolName}: ${errors.join("; ")}`,
          );
        }
      }
    }

    // Delegate to original validation
    return originalValidate(tool, args, toolName);
  };
}
