import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";
import { KgVectorStore } from "../graph/kg-vector-store.ts";
import type { FileRow } from "../graph/kg-types.ts";
import { storeSummaries } from "../tools/store-summaries.ts";
import { randomEmbedding } from "./embedding-test-helpers.ts";

// ---------------------------------------------------------------------------
// Mock EmbeddingService — fast random vectors, no model download
// This is applied to all tests in this file so that storeSummaries never
// tries to download a real embedding model during the DB write path.
// ---------------------------------------------------------------------------

let _mockSeed = 0;

vi.mock("../graph/kg-embedding.ts", () => ({
  EmbeddingService: class MockEmbeddingService {
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((_, i) => randomEmbedding(_mockSeed + i));
    }
    async embedOne(_text: string): Promise<Float32Array> {
      return randomEmbedding(_mockSeed++);
    }
    dispose(): void {
      // no-op
    }
    get isLoaded(): boolean {
      return false;
    }
  },
}));

describe("storeSummaries", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-store-summaries-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    _mockSeed = 0;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writes summaries to DB and auto-stubs missing file rows", async () => {
    // Create DB so storeSummaries can write to it
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    const db = initDatabase(dbPath);
    db.close();

    const result = await storeSummaries(
      { summaries: [{ file_path: "src/api/handler.ts", summary: "Handles HTTP requests" }] },
      tmpDir,
    );

    expect(result.stored).toBe(1);
    expect(result.total).toBe(1);
    expect(result.path).toBe(dbPath);

    // Verify DB has the summary
    const db2 = initDatabase(dbPath);
    const store2 = new KgStore(db2);
    const fileRow = store2.getFile("src/api/handler.ts");
    expect(fileRow?.file_id).toBeDefined();
    const summaryRow = store2.getSummaryByFile(fileRow!.file_id!);
    expect(summaryRow?.summary).toBe("Handles HTTP requests");
    db2.close();
  });

  it("writes summary to DB when file is already in KG", async () => {
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    const fileRow: Omit<FileRow, "file_id"> = {
      path: "src/api/handler.ts",
      mtime_ms: Date.now(),
      content_hash: "abc123",
      language: "typescript",
      layer: "api",
      last_indexed_at: Date.now(),
    };
    store.upsertFile(fileRow);
    db.close();

    await storeSummaries(
      { summaries: [{ file_path: "src/api/handler.ts", summary: "Handles HTTP requests" }] },
      tmpDir,
    );

    const db2 = initDatabase(dbPath);
    const store2 = new KgStore(db2);
    const insertedFileRow = store2.getFile("src/api/handler.ts");
    expect(insertedFileRow?.file_id).toBeDefined();
    const summaryRow = store2.getSummaryByFile(insertedFileRow!.file_id!);
    expect(summaryRow).toBeDefined();
    expect(summaryRow?.summary).toBe("Handles HTTP requests");
    expect(summaryRow?.scope).toBe("file");
    db2.close();
  });

  it("stores multiple summaries in a single call", async () => {
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    const db = initDatabase(dbPath);
    db.close();

    const result = await storeSummaries(
      {
        summaries: [
          { file_path: "src/a.ts", summary: "Module A" },
          { file_path: "src/b.ts", summary: "Module B" },
        ],
      },
      tmpDir,
    );

    expect(result.stored).toBe(2);
    expect(result.total).toBe(2);

    const db2 = initDatabase(dbPath);
    const store2 = new KgStore(db2);
    const rowA = store2.getFile("src/a.ts");
    const rowB = store2.getFile("src/b.ts");
    expect(store2.getSummaryByFile(rowA!.file_id!)?.summary).toBe("Module A");
    expect(store2.getSummaryByFile(rowB!.file_id!)?.summary).toBe("Module B");
    db2.close();
  });

  // -------------------------------------------------------------------------
  // Embedding trigger tests
  // -------------------------------------------------------------------------

  describe("embedding trigger (best-effort)", () => {
    it("writes a summary_vectors row after storeSummaries when file is in KG", async () => {
      const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
      const db = initDatabase(dbPath);
      const store = new KgStore(db);

      store.upsertFile({
        path: "src/api/handler.ts",
        mtime_ms: Date.now(),
        content_hash: "abc123",
        language: "typescript",
        layer: "api",
        last_indexed_at: Date.now(),
      });
      db.close();

      await storeSummaries(
        { summaries: [{ file_path: "src/api/handler.ts", summary: "Handles HTTP requests" }] },
        tmpDir,
      );

      // Verify that a summary vector was created
      const db2 = initDatabase(dbPath);
      const store2 = new KgStore(db2);
      const fileRow = store2.getFile("src/api/handler.ts");
      expect(fileRow?.file_id).toBeDefined();
      const summaryRow = store2.getSummaryByFile(fileRow!.file_id!);
      expect(summaryRow?.summary_id).toBeDefined();

      // Check summary_vector_meta has a row for this summary
      const metaRow = db2
        .prepare("SELECT * FROM summary_vector_meta WHERE summary_id = ?")
        .get(summaryRow!.summary_id!) as { summary_id: number; text_hash: string; model_id: string } | undefined;

      expect(metaRow).toBeDefined();
      expect(metaRow?.text_hash).toBe(KgVectorStore.textHash("Handles HTTP requests"));
      db2.close();
    });

    it("summaries are still written to DB even when embedding throws (best-effort)", async () => {
      // Make the mock's embed method throw for this test
      const { EmbeddingService } = await import("../graph/kg-embedding.ts");
      const embedSpy = vi.spyOn(EmbeddingService.prototype, "embed").mockRejectedValue(
        new Error("simulated embedding failure"),
      );

      const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
      const db = initDatabase(dbPath);
      const store = new KgStore(db);
      store.upsertFile({
        path: "src/api/handler.ts",
        mtime_ms: Date.now(),
        content_hash: "abc123",
        language: "typescript",
        layer: "api",
        last_indexed_at: Date.now(),
      });
      db.close();

      // Should NOT throw even though embedding fails
      await expect(
        storeSummaries(
          { summaries: [{ file_path: "src/api/handler.ts", summary: "Handles HTTP requests" }] },
          tmpDir,
        ),
      ).resolves.not.toThrow();

      // Summary should still be in DB
      const db2 = initDatabase(dbPath);
      const store2 = new KgStore(db2);
      const fileRow = store2.getFile("src/api/handler.ts");
      const summaryRow = store2.getSummaryByFile(fileRow!.file_id!);
      expect(summaryRow?.summary).toBe("Handles HTTP requests");
      db2.close();

      embedSpy.mockRestore();
    });
  });
});
