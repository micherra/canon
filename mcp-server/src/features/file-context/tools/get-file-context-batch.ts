/** Batch variant of getFileContext — fetches context for multiple files at once. */

import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import type { FileContextOutput } from "./get-file-context.ts";
import { getFileContext } from "./get-file-context.ts";

export async function getFileContextBatch(
  input: { file_paths: string[] },
  projectDir: string,
): Promise<ToolResult<{ results: FileContextOutput[] }>> {
  const settled = await Promise.all(
    input.file_paths.map((fp) => getFileContext({ file_path: fp }, projectDir)),
  );

  const results: FileContextOutput[] = [];
  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    const fp = input.file_paths[i];
    if (!result.ok) {
      return toolError(result.error_code, `Error for ${fp}: ${result.message}`);
    }
    const { ok, ...data } = result;
    results.push(data as FileContextOutput);
  }
  return toolOk({ results });
}
