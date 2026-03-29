import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { storeSummaries } from "../tools/store-summaries.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";
import type { FileRow } from "../graph/kg-types.ts";

describe("storeSummaries", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-store-summaries-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
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
      storeSummaries(
        { summaries: [{ file_path: "src/api/handler.ts", summary: "Handles HTTP requests" }] },
        tmpDir,
      ),
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
      storeSummaries(
        { summaries: [{ file_path: "src/api/handler.ts", summary: "Handles HTTP requests" }] },
        tmpDir,
      ),
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

    const result = await storeSummaries(
      { summaries: [{ file_path: "src/new.ts", summary: "New file" }] },
      tmpDir,
    );

    expect(result.stored).toBe(1);
    expect(result.total).toBe(2);

    const raw = await readFile(join(tmpDir, ".canon", "summaries.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed["src/existing.ts"].summary).toBe("Existing file");
    expect(parsed["src/new.ts"].summary).toBe("New file");
  });
});
