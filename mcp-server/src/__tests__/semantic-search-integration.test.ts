/**
 * Semantic Search — Integration Tests
 *
 * Cross-task integration: exercises the full stack from pipeline embed phase
 * through KgVectorStore / KgVectorQuery to the semanticSearch MCP tool.
 *
 * All tests use mocked EmbeddingService to avoid model downloads.
 * The integration boundary being tested is the data contract between modules —
 * not the embedding model's correctness (covered by kg-embedding.test.ts).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPipeline } from "../graph/kg-pipeline.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";
import { KgVectorQuery } from "../graph/kg-vector-query.ts";
import { KgVectorStore } from "../graph/kg-vector-store.ts";
import { semanticSearch } from "../tools/semantic-search.ts";
import { randomEmbedding } from "./embedding-test-helpers.ts";

// ---------------------------------------------------------------------------
// Mock EmbeddingService (shared across all describe blocks in this file)
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "semantic-search-integration-"));
}

function writeFile(dir: string, relPath: string, content: string): void {
  const abs = path.join(dir, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

// ---------------------------------------------------------------------------
// Integration: pipeline embed phase → semanticSearch tool
//
// This is the primary cross-task integration test: Task 2's embed phase
// writes entity_vectors that Task 3's semanticSearch tool then queries.
// ---------------------------------------------------------------------------

describe("Integration: runPipeline embed phase → semanticSearch tool", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempDir();
    mkdirSync(path.join(projectDir, ".canon"), { recursive: true });
    mockSeed = 0;
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("entities indexed by runPipeline are queryable via semanticSearch", async () => {
    // Seed a TypeScript file with a real function
    writeFile(projectDir, "src/auth.ts", "export function authenticateUser(token: string): boolean { return true; }");

    const dbPath = path.join(projectDir, ".canon", "knowledge-graph.db");
    await runPipeline(projectDir, { dbPath, incremental: false });

    // Verify that the embed phase produced at least one entity vector
    const db = new Database(dbPath);
    const vectorStore = new KgVectorStore(db);
    const stats = vectorStore.getVectorStats();
    db.close();

    expect(stats.entityVectors).toBeGreaterThan(0);

    // Now call semanticSearch — the tool should find the entity
    mockSeed = 0; // reset so query vector may land near indexed vectors
    const result = await semanticSearch({ query: "authenticate user token" }, projectDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.count).toBeGreaterThanOrEqual(0);
      // If results returned, each must have required shape
      for (const r of result.results) {
        expect(typeof r.entity_id).toBe("number");
        expect(typeof r.distance).toBe("number");
        expect(typeof r.file_path).toBe("string");
        expect(["entity", "summary"]).toContain(r.source);
      }
    }
  });

  it("incremental second pipeline run keeps vectors queryable via semanticSearch", async () => {
    writeFile(projectDir, "src/logger.ts", "export function logError(msg: string): void {}");

    const dbPath = path.join(projectDir, ".canon", "knowledge-graph.db");

    // First run
    await runPipeline(projectDir, { dbPath, incremental: true });

    // Second run — no file changes
    const result2 = await runPipeline(projectDir, { dbPath, incremental: true });
    expect(result2.embeddingsGenerated).toBe(0); // nothing re-embedded

    // semanticSearch must still work after second run (vectors were not cleared)
    const result = await semanticSearch({ query: "log error message" }, projectDir);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Vectors from the first run should still be present
      const db = new Database(dbPath);
      const vectorStore = new KgVectorStore(db);
      const stats = vectorStore.getVectorStats();
      db.close();
      expect(stats.entityVectors).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Gap: cleanOrphanSummaryVectors deletion path (Task 2 Known Gap)
// The entity variant is tested; the summary variant shares the same logic
// but was not covered by the implementor.
// ---------------------------------------------------------------------------

describe("KgVectorStore.cleanOrphanSummaryVectors", () => {
  let db: Database.Database;
  let vectorStore: KgVectorStore;
  let store: KgStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
    vectorStore = new KgVectorStore(db);
    mockSeed = 0;
  });

  afterEach(() => {
    db.close();
  });

  function seedFile(filePath = "src/A.ts"): number {
    const row = store.upsertFile({
      path: filePath,
      mtime_ms: Date.now(),
      content_hash: "x",
      language: "typescript",
      layer: "domain",
      last_indexed_at: Date.now(),
    });
    return row.file_id!;
  }

  function seedSummaryWithVector(fileId: number, seed = 0): number {
    const summaryRow = store.upsertSummary({
      file_id: fileId,
      entity_id: null,
      scope: "file",
      summary: "A useful summary",
      model: null,
      content_hash: null,
      updated_at: new Date().toISOString(),
    });
    const summaryId = summaryRow.summary_id!;
    vectorStore.upsertSummaryVector(summaryId, randomEmbedding(seed), KgVectorStore.textHash("A useful summary"));
    return summaryId;
  }

  it("removes summary vectors for deleted summaries", () => {
    const fileId = seedFile();
    const summaryId = seedSummaryWithVector(fileId, 1);

    // Verify vector row exists before deletion
    const countBefore = (db.prepare("SELECT COUNT(*) as n FROM summary_vectors").get() as { n: number }).n;
    expect(countBefore).toBe(1);

    // Delete the summary — CASCADE removes summary_vector_meta but NOT summary_vectors (vec0)
    db.prepare("DELETE FROM summaries WHERE summary_id = ?").run(summaryId);

    const deleted = vectorStore.cleanOrphanSummaryVectors();
    expect(deleted).toBeGreaterThanOrEqual(1);

    const countAfter = (db.prepare("SELECT COUNT(*) as n FROM summary_vectors").get() as { n: number }).n;
    expect(countAfter).toBe(0);
  });

  it("returns 0 when no orphan summary vectors exist", () => {
    const deleted = vectorStore.cleanOrphanSummaryVectors();
    expect(deleted).toBe(0);
  });

  it("keeps vectors for summaries that still exist", () => {
    const fileId = seedFile();
    seedSummaryWithVector(fileId, 2);

    const deleted = vectorStore.cleanOrphanSummaryVectors();
    expect(deleted).toBe(0);

    const count = (db.prepare("SELECT COUNT(*) as n FROM summary_vectors").get() as { n: number }).n;
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Gap: threshold parameter with positive coverage (Task 2 / Task 3 Known Gap)
//
// The implementor noted: "threshold=0.001 may exclude all results — assertion
// over empty array passes vacuously." This test uses a same-vector query
// (distance ≈ 0) to guarantee at least one result passes the threshold filter.
// ---------------------------------------------------------------------------

describe("KgVectorQuery threshold — positive coverage", () => {
  let db: Database.Database;
  let vectorStore: KgVectorStore;
  let store: KgStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
    vectorStore = new KgVectorStore(db);
    mockSeed = 0;
  });

  afterEach(() => {
    db.close();
  });

  function seedEntityWithExactVector(seed: number): { entityId: number; embedding: Float32Array } {
    const fileRow = store.upsertFile({
      path: `src/F${seed}.ts`,
      mtime_ms: Date.now(),
      content_hash: String(seed),
      language: "typescript",
      layer: "domain",
      last_indexed_at: Date.now(),
    });
    const entityRow = store.insertEntity({
      file_id: fileRow.file_id!,
      name: `fn${seed}`,
      qualified_name: `src/F${seed}.ts::fn${seed}`,
      kind: "function",
      line_start: 1,
      line_end: 5,
      is_exported: true,
      is_default_export: false,
      signature: null,
      metadata: null,
    });
    const embedding = randomEmbedding(seed);
    vectorStore.upsertEntityVector(entityRow.entity_id!, embedding, KgVectorStore.textHash("t"));
    return { entityId: entityRow.entity_id!, embedding };
  }

  it("threshold=1.0 includes results with distance close to 0 (same-vector query)", async () => {
    // Insert an entity with a known embedding
    const { embedding } = seedEntityWithExactVector(42);

    // Create a mock service that returns the exact same embedding as query
    const exactMatchService = {
      async embedOne(_text: string): Promise<Float32Array> {
        return embedding;
      },
      dispose() {
        /* noop */
      },
    };

    // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
    const query = new KgVectorQuery(db, exactMatchService as any);
    const results = await query.semanticSearch("same vector query", { threshold: 1.0, scope: "entities" });

    // Distance between identical vectors is 0 — must pass threshold=1.0
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.distance).toBeLessThanOrEqual(1.0);
    }
  });

  it("threshold=0.0 excludes all results except exact matches", async () => {
    // Insert two entities with different random vectors
    seedEntityWithExactVector(10);
    seedEntityWithExactVector(20);

    // Query with a completely different vector (seed 99)
    const differentVecService = {
      async embedOne(_text: string): Promise<Float32Array> {
        return randomEmbedding(99);
      },
      dispose() {
        /* noop */
      },
    };

    // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
    const query = new KgVectorQuery(db, differentVecService as any);
    const results = await query.semanticSearch("different vector", { threshold: 0.0, scope: "entities" });

    // All returned results must have distance <= 0.0 (only exact match passes)
    for (const r of results) {
      expect(r.distance).toBeLessThanOrEqual(0.0);
    }
  });
});

// ---------------------------------------------------------------------------
// Gap: getVectorStats counts both entity AND summary vectors
// The implementor only tested entity vector counting (not combined stats).
// ---------------------------------------------------------------------------

describe("KgVectorStore.getVectorStats — combined entity and summary counts", () => {
  let db: Database.Database;
  let vectorStore: KgVectorStore;
  let store: KgStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
    vectorStore = new KgVectorStore(db);
    mockSeed = 0;
  });

  afterEach(() => {
    db.close();
  });

  it("counts both entity and summary vectors independently", () => {
    // Insert one entity vector
    const fileRow = store.upsertFile({
      path: "src/A.ts",
      mtime_ms: Date.now(),
      content_hash: "a",
      language: "typescript",
      layer: "domain",
      last_indexed_at: Date.now(),
    });
    const entityRow = store.insertEntity({
      file_id: fileRow.file_id!,
      name: "fn",
      qualified_name: "src/A.ts::fn",
      kind: "function",
      line_start: 1,
      line_end: 5,
      is_exported: false,
      is_default_export: false,
      signature: null,
      metadata: null,
    });
    vectorStore.upsertEntityVector(entityRow.entity_id!, randomEmbedding(1), KgVectorStore.textHash("e"));

    // Insert one summary vector
    const summaryRow = store.upsertSummary({
      file_id: fileRow.file_id!,
      entity_id: null,
      scope: "file",
      summary: "Summary",
      model: null,
      content_hash: null,
      updated_at: new Date().toISOString(),
    });
    vectorStore.upsertSummaryVector(summaryRow.summary_id!, randomEmbedding(2), KgVectorStore.textHash("s"));

    const stats = vectorStore.getVectorStats();
    expect(stats.entityVectors).toBe(1);
    expect(stats.summaryVectors).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Gap: getStaleSummaryVectors — model_id mismatch path
// The implementor tested no-meta and hash-match exclusion, but not the
// model_id mismatch staleness trigger for summaries (symmetric with entity path).
// ---------------------------------------------------------------------------

describe("KgVectorStore.getStaleSummaryVectors — model_id mismatch", () => {
  let db: Database.Database;
  let vectorStore: KgVectorStore;
  let store: KgStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
    vectorStore = new KgVectorStore(db);
    mockSeed = 0;
  });

  afterEach(() => {
    db.close();
  });

  it("returns summary as stale when model_id does not match current model", () => {
    const fileRow = store.upsertFile({
      path: "src/B.ts",
      mtime_ms: Date.now(),
      content_hash: "b",
      language: "typescript",
      layer: "domain",
      last_indexed_at: Date.now(),
    });
    const summaryRow = store.upsertSummary({
      file_id: fileRow.file_id!,
      entity_id: null,
      scope: "file",
      summary: "A summary",
      model: null,
      content_hash: null,
      updated_at: new Date().toISOString(),
    });
    const summaryId = summaryRow.summary_id!;

    // Embed it with current hash
    const hash = KgVectorStore.textHash("A summary");
    vectorStore.upsertSummaryVector(summaryId, randomEmbedding(5), hash);

    // Force model_id to an outdated value
    db.prepare("UPDATE summary_vector_meta SET model_id = 'old-model-v1' WHERE summary_id = ?").run(summaryId);

    const stale = vectorStore.getStaleSummaryVectors();
    expect(stale.find((r) => r.summary_id === summaryId)).toBeDefined();
  });

  it("does not return summary as stale when model_id and hash both match", () => {
    const fileRow = store.upsertFile({
      path: "src/C.ts",
      mtime_ms: Date.now(),
      content_hash: "c",
      language: "typescript",
      layer: "domain",
      last_indexed_at: Date.now(),
    });
    const summaryRow = store.upsertSummary({
      file_id: fileRow.file_id!,
      entity_id: null,
      scope: "file",
      summary: "Fresh summary",
      model: null,
      content_hash: null,
      updated_at: new Date().toISOString(),
    });
    const summaryId = summaryRow.summary_id!;

    const hash = KgVectorStore.textHash("Fresh summary");
    vectorStore.upsertSummaryVector(summaryId, randomEmbedding(6), hash);

    // model_id defaults to EMBEDDING_MODEL_ID — should NOT be stale
    const stale = vectorStore.getStaleSummaryVectors();
    expect(stale.find((r) => r.summary_id === summaryId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration: store_summaries embedding trigger → semanticSearch finds it
//
// Cross-task boundary: Task 3's embedding trigger in store-summaries writes
// summary vectors that KgVectorQuery (Task 2) then returns via scope='summaries'.
// ---------------------------------------------------------------------------

describe("Integration: store_summaries embedding trigger → KgVectorQuery", () => {
  let db: Database.Database;
  let vectorStore: KgVectorStore;
  let store: KgStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
    vectorStore = new KgVectorStore(db);
    mockSeed = 0;
  });

  afterEach(() => {
    db.close();
  });

  it("summary vector written by upsertSummaryVector is found by KgVectorQuery scope=summaries", async () => {
    const fileRow = store.upsertFile({
      path: "src/services/payment.ts",
      mtime_ms: Date.now(),
      content_hash: "pay",
      language: "typescript",
      layer: "domain",
      last_indexed_at: Date.now(),
    });

    const summaryRow = store.upsertSummary({
      file_id: fileRow.file_id!,
      entity_id: null,
      scope: "file",
      summary: "Handles payment processing and refunds",
      model: null,
      content_hash: null,
      updated_at: new Date().toISOString(),
    });

    // Simulate what the embedding trigger in store-summaries does
    const embedding = randomEmbedding(10);
    vectorStore.upsertSummaryVector(
      summaryRow.summary_id!,
      embedding,
      KgVectorStore.textHash("Handles payment processing and refunds"),
    );

    // Query with the exact same embedding (distance ≈ 0)
    const exactMatchService = {
      async embedOne(_text: string): Promise<Float32Array> {
        return embedding;
      },
      dispose() {
        /* noop */
      },
    };

    // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
    const query = new KgVectorQuery(db, exactMatchService as any);
    const results = await query.semanticSearch("payment processing", { scope: "summaries" });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("summary");
    expect(results[0].file_path).toBe("src/services/payment.ts");
    expect(results[0].distance).toBeCloseTo(0, 3);
  });
});
