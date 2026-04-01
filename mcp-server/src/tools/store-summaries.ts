/** Store file summaries to the KG SQLite database (sole write path — ADR-005). */

import { mkdir } from "node:fs/promises";
import { extname } from "node:path";
import { dirname, join } from "node:path";
import { CANON_DIR, CANON_FILES } from "../constants.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";

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

export async function storeSummaries(input: StoreSummariesInput, projectDir: string): Promise<StoreSummariesOutput> {
  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  const now = new Date().toISOString();

  // Ensure .canon directory exists
  await mkdir(dirname(dbPath), { recursive: true });

  // Write all summaries to DB — creates DB if absent
  const db = initDatabase(dbPath);
  let stored = 0;
  try {
    const store = new KgStore(db);
    for (const { file_path, summary } of input.summaries) {
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
      stored += 1;
    }
  } finally {
    db.close();
  }

  return {
    stored,
    total: stored,
    path: dbPath,
  };
}
