/**
 * KgVectorStore Tests (Part 1)
 *
 * Tests for textHash, compositeEntityText, upsertEntityVector,
 * upsertSummaryVector, and getStaleEntityVectors.
 * EmbeddingService is mocked — tests focus on storage/query logic.
 */

import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import type { EntityRow } from "@graph/kg-types.ts";
import { KgVectorStore } from "@graph/kg-vector-store.ts";
import { EMBEDDING_MODEL_ID } from "@shared/constants.ts";
import { MockEmbeddingService, randomEmbedding } from "@tests/helpers/embedding-test-helpers.ts";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

// Suppress unused import
void MockEmbeddingService;

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

// KgVectorStore — static helpers

describe("KgVectorStore.textHash", () => {
  test("returns a 64-char hex string", () => {
    const hash = KgVectorStore.textHash("hello");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  test("is consistent for same input", () => {
    expect(KgVectorStore.textHash("hello")).toBe(KgVectorStore.textHash("hello"));
  });

  test("differs for different inputs", () => {
    expect(KgVectorStore.textHash("hello")).not.toBe(KgVectorStore.textHash("world"));
  });
});

describe("KgVectorStore.compositeEntityText", () => {
  test("formats entity without signature", () => {
    const text = KgVectorStore.compositeEntityText({
      file_path: "src/A.ts",
      kind: "function",
      qualified_name: "src/A.ts::myFunc",
      signature: null,
    });
    expect(text).toBe("function: src/A.ts::myFunc\nfile: src/A.ts");
  });

  test("includes signature when present", () => {
    const text = KgVectorStore.compositeEntityText({
      file_path: "src/B.ts",
      kind: "class",
      qualified_name: "src/B.ts::MyClass",
      signature: "class MyClass extends Base",
    });
    expect(text).toBe(
      "class: src/B.ts::MyClass\nsignature: class MyClass extends Base\nfile: src/B.ts",
    );
  });
});

// KgVectorStore — upsert and round-trip

describe("KgVectorStore upsertEntityVector", () => {
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

  test("upserts entity vector and meta row", () => {
    const { entityId } = seedEntity(store);
    const embedding = randomEmbedding(1);
    const hash = KgVectorStore.textHash("test text");

    vectorStore.upsertEntityVector(entityId, embedding, hash);

    // Verify meta row was inserted
    const meta = db.prepare("SELECT * FROM entity_vector_meta WHERE entity_id = ?").get(entityId) as
      | { text_hash: string; model_id: string }
      | undefined;
    expect(meta).toBeDefined();
    expect(meta!.text_hash).toBe(hash);
    expect(meta!.model_id).toBe(EMBEDDING_MODEL_ID);
  });

  test("upsert is idempotent — second upsert updates meta", () => {
    const { entityId } = seedEntity(store);
    const embedding1 = randomEmbedding(1);
    const embedding2 = randomEmbedding(2);
    const hash1 = KgVectorStore.textHash("text1");
    const hash2 = KgVectorStore.textHash("text2");

    vectorStore.upsertEntityVector(entityId, embedding1, hash1);
    vectorStore.upsertEntityVector(entityId, embedding2, hash2);

    const meta = db.prepare("SELECT * FROM entity_vector_meta WHERE entity_id = ?").get(entityId) as
      | { text_hash: string }
      | undefined;
    expect(meta!.text_hash).toBe(hash2);

    // Only one vec row should exist
    const count = (db.prepare("SELECT COUNT(*) as n FROM entity_vectors").get() as { n: number }).n;
    expect(count).toBe(1);
  });

  test("KNN query finds inserted entity vector", () => {
    const { entityId } = seedEntity(store);
    const embedding = randomEmbedding(42);
    vectorStore.upsertEntityVector(entityId, embedding, KgVectorStore.textHash("q"));

    // Query with the exact same embedding — distance should be very small
    const queryBuf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    const rows = db
      .prepare(
        "SELECT entity_id, distance FROM entity_vectors WHERE embedding MATCH ? ORDER BY distance LIMIT 5",
      )
      .all(queryBuf) as Array<{ entity_id: number; distance: number }>;

    expect(rows.length).toBe(1);
    expect(rows[0].entity_id).toBe(entityId);
    expect(rows[0].distance).toBeCloseTo(0, 3);
  });
});

describe("KgVectorStore upsertSummaryVector", () => {
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

  function seedSummary(fileId: number): number {
    const result = store.upsertSummary({
      content_hash: null,
      entity_id: null,
      file_id: fileId,
      model: null,
      scope: "file",
      summary: "This file does something useful",
      updated_at: new Date().toISOString(),
    });
    return result.summary_id!;
  }

  test("upserts summary vector and meta row", () => {
    const { fileId } = seedEntity(store);
    const summaryId = seedSummary(fileId);
    const embedding = randomEmbedding(5);
    const hash = KgVectorStore.textHash("summary text");

    vectorStore.upsertSummaryVector(summaryId, embedding, hash);

    const meta = db
      .prepare("SELECT * FROM summary_vector_meta WHERE summary_id = ?")
      .get(summaryId) as { text_hash: string; model_id: string } | undefined;
    expect(meta).toBeDefined();
    expect(meta!.text_hash).toBe(hash);
    expect(meta!.model_id).toBe(EMBEDDING_MODEL_ID);
  });

  test("KNN query finds inserted summary vector", () => {
    const { fileId } = seedEntity(store);
    const summaryId = seedSummary(fileId);
    const embedding = randomEmbedding(99);
    vectorStore.upsertSummaryVector(summaryId, embedding, KgVectorStore.textHash("s"));

    const queryBuf = Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength);
    const rows = db
      .prepare(
        "SELECT summary_id, distance FROM summary_vectors WHERE embedding MATCH ? ORDER BY distance LIMIT 5",
      )
      .all(queryBuf) as Array<{ summary_id: number; distance: number }>;

    expect(rows.length).toBe(1);
    expect(rows[0].summary_id).toBe(summaryId);
    expect(rows[0].distance).toBeCloseTo(0, 3);
  });
});

// KgVectorStore — staleness detection

describe("KgVectorStore.getStaleEntityVectors", () => {
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

  test("returns entities with no vector", () => {
    seedEntity(store, { kind: "function", name: "funcA", qualified_name: "src/A.ts::funcA" });

    const stale = vectorStore.getStaleEntityVectors();
    expect(stale.length).toBe(1);
    expect(stale[0].qualified_name).toBe("src/A.ts::funcA");
  });

  test("excludes kind=file entities", () => {
    // A file entity (no useful signature)
    const file = store.upsertFile({
      content_hash: "x",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "domain",
      mtime_ms: Date.now(),
      path: "src/A.ts",
    });
    store.insertEntity({
      file_id: file.file_id!,
      is_default_export: false,
      is_exported: false,
      kind: "file",
      line_end: 1,
      line_start: 1,
      metadata: null,
      name: "A.ts",
      qualified_name: "src/A.ts",
      signature: null,
    });

    const stale = vectorStore.getStaleEntityVectors();
    expect(stale.every((r) => r.kind !== "file")).toBe(true);
  });

  test("excludes already-embedded entities with matching hash and model", () => {
    const { entityId } = seedEntity(store, {
      kind: "function",
      signature: "function myFunc(): void",
    });
    const { qualified_name, kind, signature } = store
      .getEntitiesByFile(
        (
          db.prepare("SELECT file_id FROM entities WHERE entity_id = ?").get(entityId) as {
            file_id: number;
          }
        ).file_id,
      )
      .find((e) => e.entity_id === entityId)!;
    const filePath = "src/A.ts";
    const compositeText = KgVectorStore.compositeEntityText({
      file_path: filePath,
      kind,
      qualified_name,
      signature: signature ?? null,
    });
    const hash = KgVectorStore.textHash(compositeText);
    const embedding = randomEmbedding(7);

    vectorStore.upsertEntityVector(entityId, embedding, hash);

    const stale = vectorStore.getStaleEntityVectors();
    expect(stale.find((r) => r.entity_id === entityId)).toBeUndefined();
  });

  test("returns entities with text_hash mismatch", () => {
    const { entityId } = seedEntity(store, { kind: "function" });
    vectorStore.upsertEntityVector(entityId, randomEmbedding(3), "old-hash");

    const stale = vectorStore.getStaleEntityVectors();
    expect(stale.find((r) => r.entity_id === entityId)).toBeDefined();
  });

  test("returns entities with model_id mismatch", () => {
    const { entityId } = seedEntity(store, { kind: "function" });

    // Manually insert with wrong model
    const embedding = randomEmbedding(8);
    vectorStore.upsertEntityVector(entityId, embedding, "placeholder");

    // Force model_id to a different value
    db.prepare("UPDATE entity_vector_meta SET model_id = 'old-model' WHERE entity_id = ?").run(
      entityId,
    );

    const stale = vectorStore.getStaleEntityVectors();
    expect(stale.find((r) => r.entity_id === entityId)).toBeDefined();
  });

  test("respects limit parameter", () => {
    seedEntity(store, { kind: "function", name: "a", qualified_name: "src/A.ts::a" });
    seedEntity(store, { kind: "function", name: "b", qualified_name: "src/B.ts::b" });
    seedEntity(store, { kind: "function", name: "c", qualified_name: "src/C.ts::c" });

    const stale = vectorStore.getStaleEntityVectors(2);
    expect(stale.length).toBeLessThanOrEqual(2);
  });
});
