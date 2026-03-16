/** Store file summaries to .canon/summaries.json — merges with existing */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";

export interface StoreSummariesInput {
  summaries: Array<{ file_path: string; summary: string }>;
}

export interface StoreSummariesOutput {
  stored: number;
  total: number;
  path: string;
}

export async function storeSummaries(
  input: StoreSummariesInput,
  projectDir: string,
): Promise<StoreSummariesOutput> {
  const summariesPath = join(projectDir, ".canon", "summaries.json");

  // Load existing summaries
  let existing: Record<string, string> = {};
  try {
    const raw = await readFile(summariesPath, "utf-8");
    existing = JSON.parse(raw);
  } catch {
    // no existing file
  }

  // Merge new summaries
  for (const { file_path, summary } of input.summaries) {
    existing[file_path] = summary;
  }

  // Write back
  await mkdir(dirname(summariesPath), { recursive: true });
  await writeFile(summariesPath, JSON.stringify(existing, null, 2), "utf-8");

  return {
    stored: input.summaries.length,
    total: Object.keys(existing).length,
    path: summariesPath,
  };
}
