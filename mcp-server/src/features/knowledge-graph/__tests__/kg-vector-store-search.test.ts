/**
 * KgVectorStore Tests (Part 2)
 *
 * Tests for getStaleSummaryVectors, cleanOrphanEntityVectors,
 * getVectorStats, KgVectorQuery.semanticSearch, and integer validation guards.
 * EmbeddingService is mocked — tests focus on storage/query logic.
 */

import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import type { EntityRow } from "@graph/kg-types.ts";
import { KgVectorQuery } from "@graph/kg-vector-query.ts";
import { KgVectorStore } from "@graph/kg-vector-store.ts";
import { MockEmbeddingService, randomEmbedding } from "@tests/helpers/embedding-test-helpers.ts";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

function makeDb(): Database.Database {
  return initDatabase(":memory:");
}

function makeStore(db: Database.Database): KgStore {
  return new KgStore(db);
}

/** Insert a file and entity into the store, return IDs. */
function seedEntity(
  store: KgStore,
  overrides: Partial<Omit<EntityRow, "entity_id" | "file_id">> = {},
): { fileId: number; entityId: number } {
  const fileRow = store.upsertFile({
    content_hash: "abc",
    language: "typescript",
    last_indexed_at: Date.now(),
    layer: "domain",
    mtime_ms: Date.now(),
    path: overrides.qualified_name?.split("::")[0] ?? "src/A.ts",
  });
  const fileId = fileRow.file_id!;
  const entityRow = store.insertEntity({
    is_default_export: false,
    is_exported: false,
    kind: "function",
    line_end: 10,
    line_start: 1,
    metadata: null,
    name: "myFunc",
    qualified_name: "src/A.ts::myFunc",
    signature: null,
    ...overrides,
    file_id: fileId,
  });
  return { entityId: entityRow.entity_id!, fileId };
}

describe("KgVectorStore.getStaleSummaryVectors", () => {
  let db: Database.Database;
  let vectorStore: KgVectorStore;
  let store: KgStore;

  beforeEach(() => {
    db = makeDb();
    store = makeStore(db);
    vectorStore = new KgVectorStore(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedFileSummary(path = "src/A.ts"): { fileId: number; summaryId: number } {
    const fileRow = store.upsertFile({
      content_hash: "x",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "domain",
      mtime_ms: Date.now(),
      path,
    });
    const summaryRow = store.upsertSummary({
      content_hash: null,
      entity_id: null,
      file_id: fileRow.file_id!,
      model: null,
      scope: "file",
      summary: "A useful summary",
      updated_at: new Date().toISOString(),
    });
    return { fileId: fileRow.file_id!, summaryId: summaryRow.summary_id! };
  }

  test("returns summaries with no vector", () => {
    seedFileSummary();
    const stale = vectorStore.getStaleSummaryVectors();
    expect(stale.length).toBe(1);
  });

  test("excludes already-embedded summaries with matching hash", () => {
    const { summaryId } = seedFileSummary();
    const hash = KgVectorStore.textHash("A useful summary");
    vectorStore.upsertSummaryVector(summaryId, randomEmbedding(10), hash);

    const stale = vectorStore.getStaleSummaryVectors();
    expect(stale.find((r) => r.summary_id === summaryId)).toBeUndefined();
  });
});

// KgVectorStore — orphan cleanup

describe("KgVectorStore.cleanOrphanEntityVectors", () => {
  let db: Database.Database;
  let vectorStore: KgVectorStore;
  let store: KgStore;

  beforeEach(() => {
    db = makeDb();
    store = makeStore(db);
    vectorStore = new KgVectorStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test("removes vectors for deleted entities", () => {
    const { entityId } = seedEntity(store, { kind: "function" });
    vectorStore.upsertEntityVector(entityId, randomEmbedding(1), "hash1");

    // Delete the entity (CASCADE removes entity_vector_meta but NOT entity_vectors)
    db.prepare("DELETE FROM entities WHERE entity_id = ?").run(entityId);

    const deleted = vectorStore.cleanOrphanEntityVectors();
    expect(deleted).toBeGreaterThanOrEqual(1);

    const count = (db.prepare("SELECT COUNT(*) as n FROM entity_vectors").get() as { n: number }).n;
    expect(count).toBe(0);
  });

  test("returns 0 when no orphans exist", () => {
    const deleted = vectorStore.cleanOrphanEntityVectors();
    expect(deleted).toBe(0);
  });

  test("keeps vectors for existing entities", () => {
    const { entityId } = seedEntity(store, { kind: "function" });
    vectorStore.upsertEntityVector(entityId, randomEmbedding(2), "hash2");

    const deleted = vectorStore.cleanOrphanEntityVectors();
    expect(deleted).toBe(0);

    const count = (db.prepare("SELECT COUNT(*) as n FROM entity_vectors").get() as { n: number }).n;
    expect(count).toBe(1);
  });
});

// KgVectorStore.getVectorStats

describe("KgVectorStore.getVectorStats", () => {
  let db: Database.Database;
  let vectorStore: KgVectorStore;
  let store: KgStore;

  beforeEach(() => {
    db = makeDb();
    store = makeStore(db);
    vectorStore = new KgVectorStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test("returns zero counts for empty DB", () => {
    const stats = vectorStore.getVectorStats();
    expect(stats).toEqual({ entityVectors: 0, summaryVectors: 0 });
  });

  test("counts entity vectors correctly", () => {
    const { entityId } = seedEntity(store, { kind: "function" });
    vectorStore.upsertEntityVector(entityId, randomEmbedding(3), "h");
    const stats = vectorStore.getVectorStats();
    expect(stats.entityVectors).toBe(1);
    expect(stats.summaryVectors).toBe(0);
  });
});

// KgVectorQuery

describe("KgVectorQuery.semanticSearch", () => {
  let db: Database.Database;
  let vectorStore: KgVectorStore;
  let store: KgStore;
  let mockEmbeddingService: MockEmbeddingService;

  beforeEach(() => {
    db = makeDb();
    store = makeStore(db);
    vectorStore = new KgVectorStore(db);
    mockEmbeddingService = new MockEmbeddingService();
  });

  afterEach(() => {
    db.close();
  });

  /** Seed an entity + vector; returns the entity for assertions. */
  function seedEntityWithVector(
    overrides: Partial<Omit<EntityRow, "entity_id" | "file_id">> = {},
    seed = 0,
  ): { entityId: number; fileId: number } {
    const info = seedEntity(store, overrides);
    vectorStore.upsertEntityVector(
      info.entityId,
      randomEmbedding(seed),
      KgVectorStore.textHash("t"),
    );
    return info;
  }

  /** Seed a summary + vector. */
  function seedSummaryWithVector(filePath: string, summaryText: string, seed = 100): number {
    const fileRow = store.upsertFile({
      content_hash: "h",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "domain",
      mtime_ms: Date.now(),
      path: filePath,
    });
    const summaryRow = store.upsertSummary({
      content_hash: null,
      entity_id: null,
      file_id: fileRow.file_id!,
      model: null,
      scope: "file",
      summary: summaryText,
      updated_at: new Date().toISOString(),
    });
    vectorStore.upsertSummaryVector(
      summaryRow.summary_id!,
      randomEmbedding(seed),
      KgVectorStore.textHash(summaryText),
    );
    return summaryRow.summary_id!;
  }

  test("returns entity results when scope=entities", async () => {
    seedEntityWithVector(
      { kind: "function", name: "funcA", qualified_name: "src/A.ts::funcA" },
      10,
    );

    const query = new KgVectorQuery(db, mockEmbeddingService as any);
    const results = await query.semanticSearch("find a function", { scope: "entities" });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("entity");
    expect(results.every((r) => r.source === "entity")).toBe(true);
  });

  test("returns summary results when scope=summaries", async () => {
    seedSummaryWithVector("src/B.ts", "This file manages auth", 200);

    const query = new KgVectorQuery(db, mockEmbeddingService as any);
    const results = await query.semanticSearch("authentication", { scope: "summaries" });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].source).toBe("summary");
    expect(results.every((r) => r.source === "summary")).toBe(true);
  });

  test("merges entity and summary results when scope=both", async () => {
    seedEntityWithVector(
      { kind: "function", name: "funcA", qualified_name: "src/A.ts::funcA" },
      10,
    );
    seedSummaryWithVector("src/C.ts", "Handles logging", 200);

    const query = new KgVectorQuery(db, mockEmbeddingService as any);
    const results = await query.semanticSearch("something", { scope: "both" });

    const sources = new Set(results.map((r) => r.source));
    // Both entity and summary sources present
    expect(sources.has("entity")).toBe(true);
    expect(sources.has("summary")).toBe(true);
  });

  test("applies kind_filter to entity results", async () => {
    seedEntityWithVector({ kind: "function", name: "fn", qualified_name: "src/A.ts::fn" }, 10);
    seedEntityWithVector({ kind: "class", name: "Cls", qualified_name: "src/B.ts::Cls" }, 20);

    const query = new KgVectorQuery(db, mockEmbeddingService as any);
    const results = await query.semanticSearch("code", {
      kind_filter: ["function"],
      scope: "entities",
    });

    expect(results.every((r) => r.kind === "function")).toBe(true);
  });

  test("respects limit parameter", async () => {
    for (let i = 0; i < 5; i++) {
      seedEntityWithVector(
        { kind: "function", name: `fn${i}`, qualified_name: `src/F${i}.ts::fn${i}` },
        i * 10,
      );
    }

    const query = new KgVectorQuery(db, mockEmbeddingService as any);
    const results = await query.semanticSearch("code", { limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  test("applies threshold to filter by distance", async () => {
    seedEntityWithVector({ kind: "function", name: "fn", qualified_name: "src/A.ts::fn" }, 0);

    const query = new KgVectorQuery(db, mockEmbeddingService as any);
    // Very strict threshold — most random vectors won't be within 0.001
    const results = await query.semanticSearch("code", { threshold: 0.001 });
    // All returned results should have distance <= threshold
    expect(results.every((r) => r.distance <= 0.001)).toBe(true);
  });

  test("deduplicates by entity_id (lower distance wins)", async () => {
    const { entityId } = seedEntityWithVector(
      { kind: "function", name: "fn", qualified_name: "src/A.ts::fn" },
      0,
    );
    // Also seed a summary for the same entity
    const fileRow = db
      .prepare("SELECT file_id FROM entities WHERE entity_id = ?")
      .get(entityId) as { file_id: number };
    const summaryRow = store.upsertSummary({
      content_hash: null,
      entity_id: entityId,
      file_id: fileRow.file_id,
      model: null,
      scope: "entity",
      summary: "Function summary",
      updated_at: new Date().toISOString(),
    });
    vectorStore.upsertSummaryVector(
      summaryRow.summary_id!,
      randomEmbedding(50),
      KgVectorStore.textHash("Function summary"),
    );

    const query = new KgVectorQuery(db, mockEmbeddingService as any);
    const results = await query.semanticSearch("code", { scope: "both" });

    // entity_id should appear at most once
    const ids = results.map((r) => r.entity_id).filter((id): id is number => id != null);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  test("returns results sorted by distance (ascending)", async () => {
    for (let i = 0; i < 3; i++) {
      seedEntityWithVector(
        { kind: "function", name: `fn${i}`, qualified_name: `src/X${i}.ts::fn${i}` },
        i * 7,
      );
    }

    const query = new KgVectorQuery(db, mockEmbeddingService as any);
    const results = await query.semanticSearch("code", { scope: "entities" });

    for (let i = 1; i < results.length; i++) {
      expect(results[i].distance).toBeGreaterThanOrEqual(results[i - 1].distance);
    }
  });

  test("returns empty array when no vectors exist", async () => {
    const query = new KgVectorQuery(db, mockEmbeddingService as any);
    const results = await query.semanticSearch("code");
    expect(results).toEqual([]);
  });
});

// KgVectorStore — integer validation guards (Fix for PR #58 review)

describe("KgVectorStore integer validation guards", () => {
  let db: Database.Database;
  let vectorStore: KgVectorStore;

  beforeEach(() => {
    db = makeDb();
    vectorStore = new KgVectorStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test("upsertEntityVector throws for non-integer entityId (float)", () => {
    expect(() => vectorStore.upsertEntityVector(1.5, randomEmbedding(0), "hash")).toThrow(
      "entityId must be a finite integer",
    );
  });

  test("upsertEntityVector throws for non-integer entityId (NaN)", () => {
    expect(() => vectorStore.upsertEntityVector(NaN, randomEmbedding(0), "hash")).toThrow(
      "entityId must be a finite integer",
    );
  });

  test("upsertEntityVector throws for non-integer entityId (Infinity)", () => {
    expect(() => vectorStore.upsertEntityVector(Infinity, randomEmbedding(0), "hash")).toThrow(
      "entityId must be a finite integer",
    );
  });

  test("upsertEntityVector accepts a valid integer entityId", () => {
    const store = makeStore(db);
    const { entityId } = seedEntity(store);
    // Should not throw
    expect(() =>
      vectorStore.upsertEntityVector(entityId, randomEmbedding(0), "hash"),
    ).not.toThrow();
  });

  test("upsertSummaryVector throws for non-integer summaryId (float)", () => {
    expect(() => vectorStore.upsertSummaryVector(2.7, randomEmbedding(0), "hash")).toThrow(
      "summaryId must be a finite integer",
    );
  });

  test("upsertSummaryVector throws for non-integer summaryId (NaN)", () => {
    expect(() => vectorStore.upsertSummaryVector(NaN, randomEmbedding(0), "hash")).toThrow(
      "summaryId must be a finite integer",
    );
  });

  test("upsertSummaryVector accepts a valid integer summaryId", () => {
    const store = makeStore(db);
    const { fileId } = seedEntity(store);
    const summaryRow = store.upsertSummary({
      content_hash: null,
      entity_id: null,
      file_id: fileId,
      model: null,
      scope: "file",
      summary: "test",
      updated_at: new Date().toISOString(),
    });
    // Should not throw
    expect(() =>
      vectorStore.upsertSummaryVector(summaryRow.summary_id!, randomEmbedding(0), "hash"),
    ).not.toThrow();
  });
});
