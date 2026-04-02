import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";
import type { FileRow } from "../graph/kg-types.ts";
import { KgVectorStore } from "../graph/kg-vector-store.ts";
import { inferLanguageFromExtension, storeSummaries } from "../tools/store-summaries.ts";
import { randomEmbedding } from "./embedding-test-helpers.ts";

// ---------------------------------------------------------------------------
// Mock EmbeddingService — fast random vectors, no model download
// This is applied to all tests in this file so that storeSummaries never
// tries to download a real embedding model during the DB write path.
// ---------------------------------------------------------------------------

let mockSeed = 0;

vi.mock("../graph/kg-embedding.ts", () => ({
  EmbeddingService: class MockEmbeddingService {
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((_, i) => randomEmbedding(mockSeed + i));
    }
    async embedOne(_text: string): Promise<Float32Array> {
      return randomEmbedding(mockSeed++);
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
    mockSeed = 0;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("creates DB and writes summary to DB when KG DB does not exist", async () => {
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");

    const result = await storeSummaries(
      { summaries: [{ file_path: "src/api/handler.ts", summary: "Handles HTTP requests" }] },
      tmpDir,
    );

    expect(result.stored).toBe(1);
    expect(result.total).toBe(1);
    expect(result.path).toBe(dbPath);

    // DB should be created and have a stub file row + summary
    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    const fileRow = store.getFile("src/api/handler.ts");
    expect(fileRow).toBeDefined();
    expect(fileRow?.file_id).toBeDefined();
    const summaryRow = store.getSummaryByFile(fileRow!.file_id!);
    expect(summaryRow).toBeDefined();
    expect(summaryRow?.summary).toBe("Handles HTTP requests");
    db.close();
  });

  it("does not throw when KG DB does not exist", async () => {
    await expect(
      storeSummaries({ summaries: [{ file_path: "src/api/handler.ts", summary: "Handles HTTP requests" }] }, tmpDir),
    ).resolves.not.toThrow();
  });

  it("writes summary to DB when KG DB exists and file is in KG", async () => {
    // Set up KG DB with a file registered
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

    // Check DB was written
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

  it("creates stub file row in DB and writes summary when file is NOT in KG", async () => {
    // Set up KG DB but don't register the file
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    const db = initDatabase(dbPath);
    db.close();

    await storeSummaries(
      { summaries: [{ file_path: "src/api/handler.ts", summary: "Handles HTTP requests" }] },
      tmpDir,
    );

    // DB should have a stub file row AND a summary (auto-indexed)
    const db2 = initDatabase(dbPath);
    const store2 = new KgStore(db2);
    const insertedFileRow = store2.getFile("src/api/handler.ts");
    expect(insertedFileRow).toBeDefined();
    expect(insertedFileRow?.layer).toBe("unknown");
    expect(insertedFileRow?.language).toBe("typescript");
    expect(insertedFileRow?.content_hash).toBe("stub");
    const summaryRow = store2.getSummaryByFile(insertedFileRow!.file_id!);
    expect(summaryRow).toBeDefined();
    expect(summaryRow?.summary).toBe("Handles HTTP requests");
    db2.close();
  });

  it("throws when DB file is corrupted — DB is now the sole data path", async () => {
    // Create an invalid DB file
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    await writeFile(dbPath, "not-a-valid-sqlite-db");

    // Now that DB is the sole write path, a corrupt DB causes rejection
    await expect(
      storeSummaries({ summaries: [{ file_path: "src/api/handler.ts", summary: "Handles HTTP requests" }] }, tmpDir),
    ).rejects.toThrow();
  });

  it("stores multiple summaries in DB — path is DB path", async () => {
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");

    const result = await storeSummaries(
      {
        summaries: [
          { file_path: "src/a.ts", summary: "File A" },
          { file_path: "src/b.ts", summary: "File B" },
        ],
      },
      tmpDir,
    );

    expect(result.stored).toBe(2);
    expect(result.total).toBe(2);
    expect(result.path).toBe(dbPath);

    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    const rowA = store.getFile("src/a.ts");
    const rowB = store.getFile("src/b.ts");
    expect(store.getSummaryByFile(rowA!.file_id!)?.summary).toBe("File A");
    expect(store.getSummaryByFile(rowB!.file_id!)?.summary).toBe("File B");
    db.close();
  });

  it("storeSummaries is idempotent — calling twice with same input produces same DB state", async () => {
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");

    await storeSummaries(
      { summaries: [{ file_path: "src/api/handler.ts", summary: "Handles HTTP requests" }] },
      tmpDir,
    );
    await storeSummaries(
      { summaries: [{ file_path: "src/api/handler.ts", summary: "Handles HTTP requests" }] },
      tmpDir,
    );

    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    const fileRow = store.getFile("src/api/handler.ts");
    expect(fileRow).toBeDefined();
    // Only one file row should exist (upsert, not insert)
    const summaryRow = store.getSummaryByFile(fileRow!.file_id!);
    expect(summaryRow).toBeDefined();
    expect(summaryRow?.summary).toBe("Handles HTTP requests");
    db.close();
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
      const embedSpy = vi
        .spyOn(EmbeddingService.prototype, "embed")
        .mockRejectedValue(new Error("simulated embedding failure"));

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
        storeSummaries({ summaries: [{ file_path: "src/api/handler.ts", summary: "Handles HTTP requests" }] }, tmpDir),
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

describe("inferLanguageFromExtension", () => {
  it("returns typescript for .ts files", () => {
    expect(inferLanguageFromExtension("src/foo.ts")).toBe("typescript");
  });

  it("returns typescript for .tsx files", () => {
    expect(inferLanguageFromExtension("src/Foo.tsx")).toBe("typescript");
  });

  it("returns javascript for .js files", () => {
    expect(inferLanguageFromExtension("src/foo.js")).toBe("javascript");
  });

  it("returns javascript for .jsx files", () => {
    expect(inferLanguageFromExtension("src/Foo.jsx")).toBe("javascript");
  });

  it("returns python for .py files", () => {
    expect(inferLanguageFromExtension("src/foo.py")).toBe("python");
  });

  it("returns markdown for .md files", () => {
    expect(inferLanguageFromExtension("docs/README.md")).toBe("markdown");
  });

  it("returns unknown for unrecognized extensions", () => {
    expect(inferLanguageFromExtension("src/foo.rb")).toBe("unknown");
  });

  it("returns unknown for files with no extension", () => {
    expect(inferLanguageFromExtension("Makefile")).toBe("unknown");
  });
});
