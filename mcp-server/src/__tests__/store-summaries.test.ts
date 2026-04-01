import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  it("writes summaries to JSON when KG DB does not exist", async () => {
    const result = await storeSummaries(
      { summaries: [{ file_path: "src/api/handler.ts", summary: "Handles HTTP requests" }] },
      tmpDir,
    );

    expect(result.stored).toBe(1);
    expect(result.total).toBe(1);

    const raw = await readFile(join(tmpDir, ".canon", "summaries.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed["src/api/handler.ts"].summary).toBe("Handles HTTP requests");
  });

  it("does not throw when KG DB does not exist", async () => {
    await expect(
      storeSummaries({ summaries: [{ file_path: "src/api/handler.ts", summary: "Handles HTTP requests" }] }, tmpDir),
    ).resolves.not.toThrow();
  });

  it("writes summary to both JSON and DB when KG DB exists and file is in KG", async () => {
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

    // Check JSON was written
    const raw = await readFile(join(tmpDir, ".canon", "summaries.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed["src/api/handler.ts"].summary).toBe("Handles HTTP requests");

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

  it("writes to JSON only when KG DB exists but file is NOT in KG", async () => {
    // Set up KG DB but don't register the file
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    const db = initDatabase(dbPath);
    db.close();

    await storeSummaries(
      { summaries: [{ file_path: "src/api/handler.ts", summary: "Handles HTTP requests" }] },
      tmpDir,
    );

    // JSON should be written
    const raw = await readFile(join(tmpDir, ".canon", "summaries.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed["src/api/handler.ts"].summary).toBe("Handles HTTP requests");

    // DB should have no summary (file not in KG)
    const db2 = initDatabase(dbPath);
    const store2 = new KgStore(db2);
    const insertedFileRow = store2.getFile("src/api/handler.ts");
    expect(insertedFileRow).toBeUndefined();
    db2.close();
  });

  it("swallows DB write failure — JSON is still written", async () => {
    // Create an invalid DB file that will cause initDatabase to fail or the write to fail
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    // Write garbage bytes so DB open will fail
    await writeFile(dbPath, "not-a-valid-sqlite-db");

    // Should not throw
    await expect(
      storeSummaries({ summaries: [{ file_path: "src/api/handler.ts", summary: "Handles HTTP requests" }] }, tmpDir),
    ).resolves.not.toThrow();

    // JSON should still be written
    const raw = await readFile(join(tmpDir, ".canon", "summaries.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed["src/api/handler.ts"].summary).toBe("Handles HTTP requests");
  });

  it("merges with existing summaries in JSON", async () => {
    // Write initial summaries
    await writeFile(
      join(tmpDir, ".canon", "summaries.json"),
      JSON.stringify({ "src/existing.ts": { summary: "Existing file", updated_at: "2025-01-01T00:00:00Z" } }),
    );

    const result = await storeSummaries({ summaries: [{ file_path: "src/new.ts", summary: "New file" }] }, tmpDir);

    expect(result.stored).toBe(1);
    expect(result.total).toBe(2);

    const raw = await readFile(join(tmpDir, ".canon", "summaries.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed["src/existing.ts"].summary).toBe("Existing file");
    expect(parsed["src/new.ts"].summary).toBe("New file");
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

    it("JSON is still written even when embedding fails (best-effort)", async () => {
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

      const raw = await readFile(join(tmpDir, ".canon", "summaries.json"), "utf-8");
      const parsed = JSON.parse(raw);
      expect(parsed["src/api/handler.ts"].summary).toBe("Handles HTTP requests");
    });
  });
});
