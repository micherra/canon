/** Store file summaries to the KG SQLite database (sole write path — ADR-005). */

import { mkdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { CANON_DIR, CANON_FILES } from "../shared/constants.ts";
import { EmbeddingService } from "../graph/kg-embedding.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";
import { KgVectorStore } from "../graph/kg-vector-store.ts";

export type SummaryEntry = {
  summary: string;
  updated_at: string;
};

export type StoreSummariesInput = {
  summaries: Array<{ file_path: string; summary: string }>;
};

export type StoreSummariesOutput = {
  stored: number;
  total: number;
  path: string;
};

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

/** Best-effort embedding of written summaries into vector store. */
async function embedSummaries(
  db: ReturnType<typeof initDatabase>,
  writtenSummaries: Array<{ summary: string; summaryId: number }>,
): Promise<void> {
  if (writtenSummaries.length === 0) return;
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
    console.warn("[store-summaries] embedding failed (non-fatal):", err);
  } finally {
    embeddingService.dispose();
  }
}

export async function storeSummaries(
  input: StoreSummariesInput,
  projectDir: string,
): Promise<StoreSummariesOutput> {
  const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  const now = new Date().toISOString();

  await mkdir(dirname(dbPath), { recursive: true });

  const db = initDatabase(dbPath);
  let stored = 0;
  let total = 0;
  try {
    const store = new KgStore(db);
    const writtenSummaries: Array<{ summary: string; summaryId: number }> = [];

    for (const { file_path, summary } of input.summaries) {
      const normalizedPath = file_path.replace(/\\/g, "/");
      let fileRow = store.getFile(normalizedPath);
      if (fileRow?.file_id === undefined) {
        fileRow = store.upsertFile({
          content_hash: "stub",
          language: inferLanguageFromExtension(normalizedPath),
          last_indexed_at: Date.now(),
          layer: "unknown",
          mtime_ms: Date.now(),
          path: normalizedPath,
        });
      }
      const summaryRow = store.upsertSummary({
        content_hash: fileRow.content_hash,
        entity_id: null,
        file_id: fileRow.file_id!,
        model: null,
        scope: "file",
        summary,
        updated_at: now,
      });

      if (summaryRow.summary_id !== undefined) {
        writtenSummaries.push({ summary, summaryId: summaryRow.summary_id });
      }
      stored += 1;
    }

    await embedSummaries(db, writtenSummaries);

    const totalRow = db
      .prepare("SELECT COUNT(*) as count FROM summaries WHERE scope = 'file'")
      .get() as { count: number };
    total = totalRow.count;
  } finally {
    db.close();
  }

  return { path: dbPath, stored, total };
}
