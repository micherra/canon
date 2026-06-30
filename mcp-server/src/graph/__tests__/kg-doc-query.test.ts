/**
 * kg-doc-query.test.ts
 *
 * Tests for DocVectorQuery:
 * - dc-04: trust_tier filter — "internal" excludes "external" docs; "any" includes all
 * - seed doc_chunks + doc_vectors; known-query returns expected chunk
 * - corpus filter restricts results
 * - content field is verbatim from doc_chunks.content
 */

import { DocVectorQuery } from "@graph/kg-doc-query.ts";
import { DocVectorStore } from "@graph/kg-doc-store.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { MockEmbeddingService, randomEmbedding } from "@tests/helpers/embedding-test-helpers.ts";
import { describe, expect, test } from "vitest";

function makeDb() {
  return initDatabase(":memory:");
}

/**
 * Seed a chunk with a known embedding. Returns chunk_id.
 * The seed embedding is deterministic via the seed parameter.
 */
function seedChunk(
  db: ReturnType<typeof makeDb>,
  opts: {
    corpus?: string;
    doc_path?: string;
    heading_path?: string;
    content: string;
    trust_tier?: "internal" | "external";
    embeddingSeed: number;
  },
): { chunkId: number; embedding: Float32Array } {
  const {
    corpus = "principles",
    doc_path = "principles/doc.md",
    heading_path = "",
    content,
    trust_tier = "internal",
    embeddingSeed,
  } = opts;

  const store = new DocVectorStore(db);
  const contentHash = DocVectorStore.textHash(content);

  const chunkId = store.upsertDocChunk({
    corpus,
    doc_path,
    heading_path,
    chunk_index: Math.floor(Math.random() * 10000),
    char_start: 0,
    char_end: content.length,
    content,
    content_hash: contentHash,
    trust_tier,
    updated_at: new Date().toISOString(),
  });

  const embedding = randomEmbedding(embeddingSeed);
  store.upsertDocVector(chunkId, embedding, contentHash);

  return { chunkId, embedding };
}

describe("DocVectorQuery", () => {
  test("known-query: querying with the exact embedding returns the seeded chunk", async () => {
    const db = makeDb();
    const { embedding, chunkId } = seedChunk(db, {
      content: "Agents should prefer immutable data structures.",
      embeddingSeed: 42,
    });

    // Mock service returns the seeded embedding
    const mockSvc = new MockEmbeddingService();
    mockSvc.setNextEmbedding(embedding);

    const query = new DocVectorQuery(db, mockSvc);
    const results = await query.queryDocs("immutable data structures", { limit: 5 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk_id).toBe(chunkId);
    expect(results[0].content).toBe("Agents should prefer immutable data structures.");

    db.close();
  });

  test("content field is verbatim — no truncation", async () => {
    const longContent = `${"A".repeat(800)} important gotcha keyword ${"B".repeat(200)}`;
    const db = makeDb();
    const { embedding } = seedChunk(db, { content: longContent, embeddingSeed: 7 });

    const mockSvc = new MockEmbeddingService();
    mockSvc.setNextEmbedding(embedding);

    const query = new DocVectorQuery(db, mockSvc);
    const results = await query.queryDocs("gotcha keyword", { limit: 5 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toBe(longContent);

    db.close();
  });

  test("dc-04: trust filter 'internal' excludes external-tier chunks", async () => {
    const db = makeDb();
    const shared = randomEmbedding(99);

    // Seed one internal and one external chunk with the SAME embedding
    seedChunk(db, {
      corpus: "internal-corpus",
      doc_path: "internal/doc.md",
      content: "Internal content",
      trust_tier: "internal",
      embeddingSeed: 99, // same seed → same embedding
    });
    seedChunk(db, {
      corpus: "external-corpus",
      doc_path: "external/doc.md",
      content: "External content",
      trust_tier: "external",
      embeddingSeed: 99, // same seed
    });

    const mockSvc = new MockEmbeddingService();
    mockSvc.setNextEmbedding(shared);

    const query = new DocVectorQuery(db, mockSvc);
    const results = await query.queryDocs("content", { limit: 10, trust: "internal" });

    expect(results.every((r) => r.trust_tier === "internal")).toBe(true);
    const hasExternal = results.some((r) => r.content === "External content");
    expect(hasExternal).toBe(false);

    db.close();
  });

  test("dc-04: trust filter 'any' includes external-tier chunks", async () => {
    const db = makeDb();
    const shared = randomEmbedding(88);

    seedChunk(db, {
      corpus: "int",
      doc_path: "int/doc.md",
      content: "Internal doc",
      trust_tier: "internal",
      embeddingSeed: 88,
    });
    seedChunk(db, {
      corpus: "ext",
      doc_path: "ext/doc.md",
      content: "External doc",
      trust_tier: "external",
      embeddingSeed: 88,
    });

    const mockSvc = new MockEmbeddingService();
    mockSvc.setNextEmbedding(shared);

    const query = new DocVectorQuery(db, mockSvc);
    const results = await query.queryDocs("doc", { limit: 10, trust: "any" });

    const trustTiers = new Set(results.map((r) => r.trust_tier));
    expect(trustTiers.has("external")).toBe(true);
    expect(trustTiers.has("internal")).toBe(true);

    db.close();
  });

  test("corpus filter restricts results to specified corpora", async () => {
    const db = makeDb();

    seedChunk(db, {
      corpus: "principles",
      doc_path: "principles/doc.md",
      content: "Principles content",
      embeddingSeed: 11,
    });
    seedChunk(db, {
      corpus: "references",
      doc_path: "references/doc.md",
      content: "References content",
      embeddingSeed: 12,
    });

    const sharedEmb = randomEmbedding(11);
    const mockSvc = new MockEmbeddingService();
    mockSvc.setNextEmbedding(sharedEmb);

    const query = new DocVectorQuery(db, mockSvc);
    const results = await query.queryDocs("content", {
      limit: 10,
      corpora: ["principles"],
    });

    expect(results.every((r) => r.corpus === "principles")).toBe(true);

    db.close();
  });

  test("returns heading_path from the chunk", async () => {
    const db = makeDb();
    const content = "This is the body under a heading.";
    const store = new DocVectorStore(db);
    const chunkId = store.upsertDocChunk({
      corpus: "principles",
      doc_path: "principles/p.md",
      heading_path: "H1 Title > H2 Section",
      chunk_index: 0,
      char_start: 0,
      char_end: content.length,
      content,
      content_hash: DocVectorStore.textHash(content),
      trust_tier: "internal",
      updated_at: new Date().toISOString(),
    });
    const embedding = randomEmbedding(55);
    store.upsertDocVector(chunkId, embedding, DocVectorStore.textHash(content));

    const mockSvc = new MockEmbeddingService();
    mockSvc.setNextEmbedding(embedding);

    const query = new DocVectorQuery(db, mockSvc);
    const results = await query.queryDocs("heading body", { limit: 5 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].heading_path).toBe("H1 Title > H2 Section");

    db.close();
  });

  test("empty DB returns empty results without throwing", async () => {
    const db = makeDb();
    const mockSvc = new MockEmbeddingService();
    mockSvc.setNextEmbedding(randomEmbedding(1));

    const query = new DocVectorQuery(db, mockSvc);
    const results = await query.queryDocs("anything", { limit: 5 });

    expect(results).toEqual([]);
    db.close();
  });

  test("limit parameter caps result count", async () => {
    const db = makeDb();
    const sharedEmb = randomEmbedding(33);

    for (let i = 0; i < 10; i++) {
      seedChunk(db, {
        corpus: "principles",
        doc_path: `principles/p${i}.md`,
        content: `Principle content number ${i}`,
        embeddingSeed: 33,
      });
    }

    const mockSvc = new MockEmbeddingService();
    mockSvc.setNextEmbedding(sharedEmb);

    const query = new DocVectorQuery(db, mockSvc);
    const results = await query.queryDocs("principle", { limit: 3 });

    expect(results.length).toBeLessThanOrEqual(3);
    db.close();
  });
});
