/** Store file summaries to the KG SQLite database (DB-only since ADR-005) */

import { existsSync } from "node:fs";
import { join } from "node:path";
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
 * Infer a programming language from the file extension.
 * Used by the KG store when upserting file rows.
 */
export function inferLanguageFromExtension(filePath: string): string {
  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) return "typescript";
  if (filePath.endsWith(".js") || filePath.endsWith(".jsx")) return "javascript";
  if (filePath.endsWith(".py")) return "python";
  if (filePath.endsWith(".md")) return "markdown";
  return "unknown";
}

export async function storeSummaries(input: StoreSummariesInput, projectDir: string): Promise<StoreSummariesOutput> {
  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  const now = new Date().toISOString();

  const db = initDatabase(dbPath);
  let stored = 0;
  try {
    const store = new KgStore(db);

    // Track which summaries were written so we can embed them
    const writtenSummaries: Array<{ summary: string; summaryId: number }> = [];

    for (const { file_path, summary } of input.summaries) {
      // Auto-stub missing file rows so summaries can always be stored
      let fileRow = store.getFile(file_path);
      if (!fileRow) {
        store.upsertFile({
          path: file_path,
          language: inferLanguageFromExtension(file_path),
          content_hash: "",
          mtime_ms: Date.now(),
          layer: null as unknown as string,
          last_indexed_at: Date.now(),
        });
        fileRow = store.getFile(file_path);
      }
      if (fileRow?.file_id === undefined) continue;

      const summaryRow = store.upsertSummary({
        file_id: fileRow.file_id,
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
      stored++;
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
  } finally {
    db.close();
  }

  return {
    stored,
    total: stored,
    path: dbPath,
  };
}
