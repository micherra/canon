/** Return the stored summary for a file, with fallback to a line preview. */

import { readFile } from "fs/promises";
import { join } from "path";
import { z } from "zod";
import { loadSummariesFile } from "./store-summaries.js";
import { safeResolvePath } from "./get-file-content.js";

export const GetSummaryInputSchema = z.object({
  file_id: z.string().min(1).describe("Project-relative file path (used as the key in summaries.json)"),
});

export type GetSummaryInput = z.infer<typeof GetSummaryInputSchema>;

export interface GetSummaryOutput {
  summary: string | null;
  source: "summaries" | "preview" | "none";
}

export async function getSummary(
  input: GetSummaryInput,
  projectDir: string,
): Promise<GetSummaryOutput> {
  const parsed = GetSummaryInputSchema.safeParse(input);
  if (!parsed.success) return { summary: null, source: "none" };

  const { file_id } = parsed.data;

  // 1. Try summaries.json first
  try {
    const summaries = await loadSummariesFile(projectDir);
    const entry = summaries[file_id];
    if (entry?.summary) {
      return { summary: entry.summary, source: "summaries" };
    }
  } catch {
    // summaries unavailable — fall through to preview
  }

  // 2. Fallback: first 5 lines of the file (path traversal safe)
  const resolved = safeResolvePath(projectDir, file_id);
  if (!resolved) return { summary: null, source: "none" };

  try {
    const content = await readFile(resolved, "utf-8");
    const preview = content.split("\n").slice(0, 5).join("\n").trim();
    if (preview) return { summary: preview, source: "preview" };
  } catch {
    // File unreadable
  }

  return { summary: null, source: "none" };
}
