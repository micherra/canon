/** Progressive disclosure helpers for the get_file_context tool. */

import { join } from "node:path";
import { CANON_DIR } from "@shared/constants.ts";
import { applyDisclosure } from "@shared/lib/progressive-disclosure.ts";
import type { FileContextOutput } from "./get-file-context.ts";

/** Produce a compact summary of FileContextOutput for progressive disclosure. */
export function summarizeFileContext(data: FileContextOutput): string {
  return [
    `File: ${data.file_path} (${data.layer})`,
    data.summary ?? "",
    `Imports: ${data.imports.length}, Imported by: ${data.imported_by.length}, Exports: ${data.exports.length}`,
    `Graph: in_degree=${data.graph_metrics?.in_degree ?? 0}, out_degree=${data.graph_metrics?.out_degree ?? 0}`,
    data.graph_metrics?.is_hub ? "Hub file" : "",
    data.violations.length > 0 ? `Violations: ${data.violations.length}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Apply progressive disclosure to a FileContextOutput.
 *
 * If the serialized payload is under threshold, returns the output unchanged.
 * If over threshold, writes full JSON to .canon/artifacts/ and returns a
 * truncated output with a file pointer.
 */
export function applyFileContextDisclosure(
  output: FileContextOutput,
  projectDir: string,
): FileContextOutput {
  const disclosure = applyDisclosure(output, {
    filePrefix: "file-context",
    outputDir: join(projectDir, CANON_DIR, "artifacts"),
    summarize: summarizeFileContext,
  });

  if (!disclosure.truncated) return output;

  return {
    ...output,
    content: `[Truncated — full content at ${disclosure.full_data_path}]`,
    full_data_path: disclosure.full_data_path,
    truncated: true,
  };
}
