/** Store file summaries to the KG SQLite database (sole write path — ADR-005). */

import { mkdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { CANON_DIR, CANON_FILES } from "../constants.ts";
import { EmbeddingService } from "../graph/kg-embedding.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";
import { KgVectorStore } from "../graph/kg-vector-store.ts";

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
  let total = 0;
  try {
    const store = new KgStore(db);

    // Track which summaries were written so we can embed them
    const writtenSummaries: Array<{ summary: string; summaryId: number }> = [];

    for (const { file_path, summary } of input.summaries) {
      const normalizedPath = file_path.replace(/\\/g, "/");
      let fileRow = store.getFile(normalizedPath);
      if (fileRow?.file_id === undefined) {
        // File not in KG yet — auto-create a stub row so the summary is never silently dropped
        fileRow = store.upsertFile({
          path: normalizedPath,
          mtime_ms: Date.now(),
          content_hash: "stub",
          language: inferLanguageFromExtension(normalizedPath),
          layer: "unknown",
          last_indexed_at: Date.now(),
        });
      }
      const summaryRow = store.upsertSummary({
        file_id: fileRow.file_id!,
        entity_id: null,
        scope: "file",
        summary,
        model: null,
        content_hash: fileRow.content_hash,
        updated_at: now,
      });

      if (summaryRow.summary_id !== undefined) {
        writtenSummaries.push({ summary, summaryId: summaryRow.summary_id });
      }
      stored += 1;
    }

    // Embed written summaries — best-effort, never fatal
    if (writtenSummaries.length > 0) {
      const embeddingService = new EmbeddingService();
      try {
        const vectorStore = new KgVectorStore(db);
        const texts = writtenSummaries.map((s) => s.summary);
        const embeddings = await embeddingService.embed(texts);
        for (let i = 0; i < writtenSummaries.length; i++) {
          vectorStore.upsertSummaryVector(
            writtenSummaries[i].summaryId,
            embeddings[i],
            KgVectorStore.textHash(writtenSummaries[i].summary),
          );
        }
      } catch (err) {
        // Embedding is best-effort — never fail the summary write
        console.warn("[store-summaries] embedding failed (non-fatal):", err);
      } finally {
        embeddingService.dispose();
      }
    }

    const totalRow = db.prepare("SELECT COUNT(*) as count FROM summaries WHERE scope = 'file'").get() as {
      count: number;
    };
    total = totalRow.count;
  } finally {
    db.close();
  }

  return {
    stored,
    total,
    path: dbPath,
  };
}
