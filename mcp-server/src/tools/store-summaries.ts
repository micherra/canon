/** Store file summaries to .canon/summaries.json — merges with existing */

import { readFile, writeFile, mkdir } from "fs/promises";
import { join, dirname } from "path";

export interface SummaryEntry {
  summary: string;
  updated_at: string;
}

export interface StoreSummariesInput {
  summaries: Array<{ file_path: string; summary: string }>;
}

export interface StoreSummariesOutput {
  stored: number;
  total: number;
  path: string;
}

/** Read summaries from disk, supporting both old (string) and new (object) formats */
export async function loadSummariesFile(
  projectDir: string,
): Promise<Record<string, SummaryEntry>> {
  const summariesPath = join(projectDir, ".canon", "summaries.json");
  try {
    const raw = await readFile(summariesPath, "utf-8");
    const parsed = JSON.parse(raw);
    // Migrate old format: { "file": "text" } → { "file": { summary, updated_at } }
    const result: Record<string, SummaryEntry> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        result[key] = { summary: value, updated_at: "" };
      } else {
        result[key] = value as SummaryEntry;
      }
    }
    return result;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

/** Extract just the summary text for consumers that don't need timestamps */
export function flattenSummaries(
  entries: Record<string, SummaryEntry>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(entries)) {
    result[key] = entry.summary;
  }
  return result;
}

export async function storeSummaries(
  input: StoreSummariesInput,
  projectDir: string,
): Promise<StoreSummariesOutput> {
  const summariesPath = join(projectDir, ".canon", "summaries.json");

  // Load existing summaries
  const existing = await loadSummariesFile(projectDir);

  // Merge new summaries with current timestamp
  const now = new Date().toISOString();
  for (const { file_path, summary } of input.summaries) {
    existing[file_path] = { summary, updated_at: now };
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
