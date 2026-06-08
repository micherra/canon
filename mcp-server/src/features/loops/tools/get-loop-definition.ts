/**
 * get_loop_definition MCP tool handler.
 *
 * Pure query (command-query-separation) — no side effects.
 * Returns the parsed definition + markdown body for a single loop by id.
 * Used by the /canon:loop-tick runner.
 *
 * WORKSPACE-independent: reads from loopsDir/<id>.md.
 * Not-found id → ToolResult INVALID_INPUT error (not a throw).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import matter from "gray-matter";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { parseLoopDefinition, type LoopDefinition } from "../loop-schema.ts";

export type GetLoopDefinitionInput = {
  id: string;
};

export type GetLoopDefinitionOutput = {
  definition: LoopDefinition;
  /** The markdown body of the loop file — the re-fired action prompt. */
  body: string;
};

/**
 * Core handler — accepts the loopsDir directly (the loops/ registry directory).
 * Separated from MCP registration so it's directly testable without MCP infra.
 * In MCP registration, pass join(pluginDir, "loops") as the first argument.
 */
export async function getLoopDefinitionHandler(
  loopsDir: string,
  input: GetLoopDefinitionInput,
): Promise<ToolResult<GetLoopDefinitionOutput>> {
  const filePath = join(loopsDir, `${input.id}.md`);

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return toolError("INVALID_INPUT", `loop '${input.id}' not found at ${filePath}`, false);
    }
    return toolError(
      "INVALID_INPUT",
      `failed to read loop file: ${err instanceof Error ? err.message : String(err)}`,
      false,
    );
  }

  let parsed: ReturnType<typeof matter>;
  try {
    parsed = matter(content);
  } catch (err) {
    return toolError(
      "INVALID_INPUT",
      `failed to parse loop frontmatter: ${err instanceof Error ? err.message : String(err)}`,
      false,
    );
  }

  const result = parseLoopDefinition(parsed.data, { idFromFilename: input.id });
  if (!result.ok) {
    return toolError(
      "INVALID_INPUT",
      `invalid loop definition '${input.id}': ${result.error}`,
      false,
    );
  }

  return toolOk({
    body: parsed.content.trim(),
    definition: result.definition,
  });
}
