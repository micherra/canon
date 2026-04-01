/** Store file summaries to .canon/summaries.json and knowledge-graph.db */

import { mkdir, readFile } from "node:fs/promises";
import { extname } from "node:path";
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

/**
 * Infer language string from a file path's extension.
 * Used when auto-creating stub file rows for files not yet in the KG.
 */
export function inferLanguageFromExtension(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
      return "javascript";
    case ".py":
      return "python";
    case ".md":
      return "markdown";
    default:
      return "unknown";
  }
}

/**
 * Read summaries from disk, supporting both old (string) and new (object) formats.
 * @deprecated Will be removed in Wave 3 when summaries.json is retired.
 */
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

/**
 * Write summaries to the KG database.
 * Creates the DB if it does not exist (init-if-absent).
 * Auto-creates stub file rows for files not yet in the KG so no summary is silently dropped.
 * Never throws — DB failures are logged and the caller falls back to JSON.
 */
async function writeSummariesToDb(
  summaries: Array<{ file_path: string; summary: string }>,
  projectDir: string,
  now: string,
): Promise<void> {
  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);

  // Init DB if absent — ensures store_summaries works even without a prior codebase_graph run
  const db = initDatabase(dbPath);
  try {
    const store = new KgStore(db);
    for (const { file_path, summary } of summaries) {
      let fileRow = store.getFile(file_path);
      if (fileRow?.file_id === undefined) {
        // File not in KG yet — auto-create a stub row so the summary is never silently dropped
        fileRow = store.upsertFile({
          path: file_path,
          mtime_ms: Date.now(),
          content_hash: "stub",
          language: inferLanguageFromExtension(file_path),
          layer: "unknown",
          last_indexed_at: Date.now(),
        });
      }
      store.upsertSummary({
        file_id: fileRow.file_id!,
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

  const now = new Date().toISOString();

  // Primary: write to DB first
  try {
    await writeSummariesToDb(input.summaries, projectDir, now);
  } catch (err) {
    // DB write failed — JSON write below is the fallback during transition
    console.error("[store-summaries] DB write failed (non-fatal):", err);
  }

  // Secondary: write to summaries.json (backward-compat, to be removed in Wave 3)
  const existing = await loadSummariesFile(projectDir);
  for (const { file_path, summary } of input.summaries) {
    existing[file_path] = { summary, updated_at: now };
  }
  await mkdir(dirname(summariesPath), { recursive: true });
  await atomicWriteFile(summariesPath, JSON.stringify(existing, null, 2));

  return {
    stored: input.summaries.length,
    total: Object.keys(existing).length,
    path: summariesPath,
  };
}
