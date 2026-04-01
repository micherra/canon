/** Store file summaries to .canon/summaries.json — merges with existing */

import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CANON_DIR, CANON_FILES } from "../constants.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";
import { atomicWriteFile } from "../utils/atomic-write.ts";
import { isNotFound } from "../utils/errors.ts";

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
export async function loadSummariesFile(projectDir: string): Promise<Record<string, SummaryEntry>> {
  const summariesPath = join(projectDir, CANON_DIR, CANON_FILES.SUMMARIES);
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
    if (isNotFound(err)) return {};
    throw err;
  }
}

/** Extract just the summary text for consumers that don't need timestamps */
export function flattenSummaries(entries: Record<string, SummaryEntry>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(entries)) {
    result[key] = entry.summary;
  }
  return result;
}

/** Write summaries to the KG database if it exists. Best-effort — never throws. */
async function writeSummariesToDb(
  summaries: Array<{ file_path: string; summary: string }>,
  projectDir: string,
  now: string,
): Promise<void> {
  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  if (!existsSync(dbPath)) return;

  const db = initDatabase(dbPath);
  try {
    const store = new KgStore(db);
    for (const { file_path, summary } of summaries) {
      const fileRow = store.getFile(file_path);
      if (fileRow?.file_id === undefined) {
        // File not in KG yet — JSON is the fallback
        continue;
      }
      store.upsertSummary({
        file_id: fileRow.file_id,
        entity_id: null,
        scope: "file",
        summary,
        model: null,
        content_hash: fileRow.content_hash,
        updated_at: now,
      });
    }
  } finally {
    db.close();
  }
}

export async function storeSummaries(input: StoreSummariesInput, projectDir: string): Promise<StoreSummariesOutput> {
  const summariesPath = join(projectDir, CANON_DIR, CANON_FILES.SUMMARIES);

  // Load existing summaries
  const existing = await loadSummariesFile(projectDir);

  // Merge new summaries with current timestamp
  const now = new Date().toISOString();
  for (const { file_path, summary } of input.summaries) {
    existing[file_path] = { summary, updated_at: now };
  }

  // Write back
  await mkdir(dirname(summariesPath), { recursive: true });
  await atomicWriteFile(summariesPath, JSON.stringify(existing, null, 2));

  // Also write to DB (best-effort — JSON write always wins)
  try {
    await writeSummariesToDb(input.summaries, projectDir, now);
  } catch (err) {
    // DB write failed — JSON file already written, so just log and continue
    console.error("[store-summaries] DB write failed (non-fatal):", err);
  }

  return {
    stored: input.summaries.length,
    total: Object.keys(existing).length,
    path: summariesPath,
  };
}
