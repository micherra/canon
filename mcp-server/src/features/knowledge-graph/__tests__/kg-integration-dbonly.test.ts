/**
 * Knowledge Graph — DB-Only Workflow Integration Tests
 *
 * Risk mitigation for ADR-005 combined migration state:
 * Verifies "KG present, DB-only summaries, no JSON files" works end-to-end.
 * All three tools (get_file_context, store_summaries) must return correct data
 * when the KG DB is the sole data source and no JSON artifact files exist on disk.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeSummaries } from "@features/diagnostics/tools/store-summaries.ts";
import { getFileContext } from "@features/file-context/tools/get-file-context.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import { CANON_FILES } from "@shared/constants.ts";
import { randomEmbedding } from "@tests/helpers/embedding-test-helpers.ts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock EmbeddingService so storeSummaries does not trigger a HuggingFace model
// download during tests. Without this mock, the first call to storeSummaries that
// actually writes summaries (triggering the embedSummaries path) lazy-loads an ONNX
// transformer model, adding 1–3s of non-deterministic latency. On slower CI hosts
// this pushes individual test durations past vitest's default 5000ms timeout,
// causing intermittent failures. The mock returns fast deterministic vectors so
// all DB-state assertions remain valid — embeddings are not tested here.
let _mockSeed = 0;
vi.mock("@graph/kg-embedding.ts", () => ({
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

// 11. DB-only workflow integration — risk mitigation for combined migration state
//
// Verifies: "KG present, DB-only summaries, no JSON files" works end-to-end.
// This is the primary risk mitigation test for the ADR-005 consolidation.
// All three tools (get_file_context, store_summaries) must return correct data
// when the KG DB is the sole data source and no JSON artifact files exist on disk.

describe("DB-only workflow — get_file_context + store_summaries without JSON artifacts", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: ReturnType<typeof initDatabase>;
  let store: KgStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-kg-db-only-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    await mkdir(join(tmpDir, "src", "api"), { recursive: true });

    // Create a real source file that getFileContext can read
    await writeFile(
      join(tmpDir, "src", "api", "handler.ts"),
      `export function handleRequest() {}\nexport const MAX_RETRIES = 3;`,
    );

    // Set up KG DB with the file registered and a summary stored
    dbPath = join(tmpDir, ".canon", CANON_FILES.KNOWLEDGE_DB);
    db = initDatabase(dbPath);
    store = new KgStore(db);

    const fileRow = store.upsertFile({
      content_hash: "abc123",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "api",
      mtime_ms: Date.now(),
      path: "src/api/handler.ts",
    });

    // Pre-seed a summary directly into the DB (no JSON file)
    store.upsertSummary({
      content_hash: "abc123",
      entity_id: null,
      file_id: fileRow.file_id!,
      model: null,
      scope: "file",
      summary: "DB-only summary for handler",
      updated_at: new Date().toISOString(),
    });

    db.close();
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  test("get_file_context returns DB summary when no summaries.json exists", async () => {
    // Verify no JSON files exist on disk before calling the tool
    expect(existsSync(join(tmpDir, ".canon", "summaries.json"))).toBe(false);
    expect(existsSync(join(tmpDir, ".canon", "graph-data.json"))).toBe(false);
    expect(existsSync(join(tmpDir, ".canon", "reverse-deps.json"))).toBe(false);

    const result = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);

    // Tool must succeed
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);

    // Summary must come from DB, not from any JSON file
    expect(result.summary).toBe("DB-only summary for handler");
    expect(result.file_path).toBe("src/api/handler.ts");
    expect(result.layer).toBe("api");
    expect(result.content).toContain("handleRequest");
  });

  test("get_file_context returns correct data with DB-only state (idempotent on repeated calls)", async () => {
    // Call twice — idempotent: same DB state, same result
    const result1 = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
    const result2 = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (!result1.ok || !result2.ok) throw new Error("Expected ok results");

    expect(result1.summary).toBe(result2.summary);
    expect(result1.summary).toBe("DB-only summary for handler");
  });

  test("store_summaries writes to DB when file is registered in KG (no JSON required for reading)", async () => {
    // Verify no summaries.json before the call
    expect(existsSync(join(tmpDir, ".canon", "summaries.json"))).toBe(false);

    await storeSummaries(
      { summaries: [{ file_path: "src/api/handler.ts", summary: "Updated via storeSummaries" }] },
      tmpDir,
    );

    // Open the DB and verify the summary was written
    const db2 = initDatabase(dbPath);
    const store2 = new KgStore(db2);
    const fileRow = store2.getFile("src/api/handler.ts");
    expect(fileRow).toBeDefined();
    const summaryRow = store2.getSummaryByFile(fileRow!.file_id!);
    db2.close();

    expect(summaryRow).toBeDefined();
    expect(summaryRow!.summary).toBe("Updated via storeSummaries");
    expect(summaryRow!.scope).toBe("file");
  });

  test("store_summaries is idempotent — calling twice with same data produces same DB state", async () => {
    const summaryInput = {
      summaries: [{ file_path: "src/api/handler.ts", summary: "Stable summary" }],
    };

    // Call twice
    await storeSummaries(summaryInput, tmpDir);
    await storeSummaries(summaryInput, tmpDir);

    // DB should have exactly one summary for the file (upsert behavior)
    const db2 = initDatabase(dbPath);
    const store2 = new KgStore(db2);
    const fileRow = store2.getFile("src/api/handler.ts");
    const summaryRow = store2.getSummaryByFile(fileRow!.file_id!);
    db2.close();

    expect(summaryRow).toBeDefined();
    expect(summaryRow!.summary).toBe("Stable summary");
  });

  test("get_file_context returns updated summary after store_summaries writes to DB", async () => {
    // First read shows the pre-seeded summary
    const before = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
    expect(before.ok).toBe(true);
    if (!before.ok) throw new Error(before.message);
    expect(before.summary).toBe("DB-only summary for handler");

    // Write a new summary via storeSummaries
    await storeSummaries(
      { summaries: [{ file_path: "src/api/handler.ts", summary: "Refreshed summary" }] },
      tmpDir,
    );

    // Second read picks up the updated summary from DB
    const after = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
    expect(after.ok).toBe(true);
    if (!after.ok) throw new Error(after.message);
    expect(after.summary).toBe("Refreshed summary");
  });
});
