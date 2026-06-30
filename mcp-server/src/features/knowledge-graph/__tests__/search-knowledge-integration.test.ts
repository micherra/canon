/**
 * search-knowledge-integration.test.ts
 *
 * Integration tests for the search_knowledge tool handler.
 *
 * dc-03: query known "gotcha" string returns ≥1 result
 * dc-04: trust filter "internal" excludes external-tier chunks; "any" includes all
 * - KG_NOT_INDEXED when DB absent
 * - content field verbatim (no truncation)
 * - heading_path surfaced in results
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DocVectorStore } from "@graph/kg-doc-store.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { randomEmbedding } from "@tests/helpers/embedding-test-helpers.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchKnowledge } from "../tools/search-knowledge.ts";

// Mock EmbeddingService so no model is downloaded
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
      /* no-op */
    }
    get isLoaded(): boolean {
      return false;
    }
  },
}));

// Mock ensureDocCorpusFresh to no-op — freshness gate not under test here
vi.mock("@features/knowledge-graph/ensure-doc-corpus-fresh.ts", () => ({
  ensureDocCorpusFresh: vi.fn().mockResolvedValue(undefined),
}));

let projectDir: string;
let dbPath: string;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(tmpdir(), "search-knowledge-test-"));
  mkdirSync(path.join(projectDir, ".canon"), { recursive: true });
  dbPath = path.join(projectDir, ".canon", "knowledge-graph.db");
  _mockSeed = 0;
});

afterEach(() => {
  rmSync(projectDir, { force: true, recursive: true });
  vi.clearAllMocks();
});

/**
 * Seed a doc chunk with a specific embedding into the test DB.
 */
function seedChunkWithEmbedding(opts: {
  corpus?: string;
  doc_path?: string;
  heading_path?: string;
  content: string;
  trust_tier?: "internal" | "external";
  embeddingSeed: number;
}): { chunkId: number; embedding: Float32Array } {
  const {
    corpus = "principles",
    doc_path = "principles/doc.md",
    heading_path = "",
    content,
    trust_tier = "internal",
    embeddingSeed,
  } = opts;

  const db = initDatabase(dbPath);
  const store = new DocVectorStore(db);
  const contentHash = DocVectorStore.textHash(content);

  const chunkId = store.upsertDocChunk({
    corpus,
    doc_path,
    heading_path,
    chunk_index: Math.floor(Math.random() * 100000),
    char_start: 0,
    char_end: content.length,
    content,
    content_hash: contentHash,
    trust_tier,
    updated_at: new Date().toISOString(),
  });

  const embedding = randomEmbedding(embeddingSeed);
  store.upsertDocVector(chunkId, embedding, contentHash);
  db.close();
  return { chunkId, embedding };
}

describe("searchKnowledge tool handler", () => {
  it("returns KG_NOT_INDEXED when the database does not exist", async () => {
    const result = await searchKnowledge({ query: "anything" }, projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("KG_NOT_INDEXED");
    }
  });

  it("INVALID_INPUT for empty query string", async () => {
    // DB must exist for the empty-query check to fire
    initDatabase(dbPath).close();

    const result = await searchKnowledge({ query: "" }, projectDir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("dc-03: known gotcha string in corpus → at least 1 result returned", async () => {
    // Seed a chunk with a known "gotcha" string using embedding seed 0
    // The mock service's first embedOne call also returns randomEmbedding(0),
    // so the KNN query should find this chunk (distance ≈ 0).
    seedChunkWithEmbedding({
      content:
        "GOTCHA: vec0 binding bug — do NOT use prepared-statement params for Float32Array, use db.exec() with inline JSON literal instead.",
      embeddingSeed: 0, // matches _mockSeed=0 at test start
    });

    const result = await searchKnowledge({ query: "vec0 binding bug gotcha" }, projectDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("content field is verbatim — no truncation", async () => {
    const longContent = `${"A".repeat(800)} critical-gotcha-marker ${"B".repeat(200)}`;
    seedChunkWithEmbedding({ content: longContent, embeddingSeed: 0 });

    const result = await searchKnowledge({ query: "critical gotcha marker" }, projectDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.length).toBeGreaterThanOrEqual(1);
      // verbatim — length must match exactly
      const found = result.results.find((r) => r.content === longContent);
      expect(found).toBeDefined();
    }
  });

  it("heading_path field is surfaced in results", async () => {
    const db = initDatabase(dbPath);
    const store = new DocVectorStore(db);
    const content = "Body under a deeply nested section.";
    const chunkId = store.upsertDocChunk({
      corpus: "principles",
      doc_path: "principles/nested.md",
      heading_path: "Top > Mid > Leaf",
      chunk_index: 0,
      char_start: 0,
      char_end: content.length,
      content,
      content_hash: DocVectorStore.textHash(content),
      trust_tier: "internal",
      updated_at: new Date().toISOString(),
    });
    const embedding = randomEmbedding(0);
    store.upsertDocVector(chunkId, embedding, DocVectorStore.textHash(content));
    db.close();

    const result = await searchKnowledge({ query: "nested section" }, projectDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.length).toBeGreaterThanOrEqual(1);
      expect(result.results[0].heading_path).toBe("Top > Mid > Leaf");
    }
  });

  it("dc-04: trust filter 'internal' excludes external-tier chunks", async () => {
    // Both chunks share the same embedding (same seed) so both would be found by KNN
    seedChunkWithEmbedding({
      corpus: "internal-source",
      doc_path: "internal/doc.md",
      content: "Internal knowledge doc",
      trust_tier: "internal",
      embeddingSeed: 0,
    });
    // Reset so second seed is also 0
    const externalEmb = randomEmbedding(0);
    const db2 = initDatabase(dbPath);
    const store2 = new DocVectorStore(db2);
    const extContent = "External knowledge doc";
    const extId = store2.upsertDocChunk({
      corpus: "external-source",
      doc_path: "external/doc.md",
      heading_path: "",
      chunk_index: 0,
      char_start: 0,
      char_end: extContent.length,
      content: extContent,
      content_hash: DocVectorStore.textHash(extContent),
      trust_tier: "external",
      updated_at: new Date().toISOString(),
    });
    store2.upsertDocVector(extId, externalEmb, DocVectorStore.textHash(extContent));
    db2.close();

    _mockSeed = 0; // reset before query

    const result = await searchKnowledge({ query: "knowledge doc", trust: "internal" }, projectDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const hasExternal = result.results.some((r) => r.trust_tier === "external");
      expect(hasExternal).toBe(false);
    }
  });

  it("dc-04: trust filter 'any' includes external-tier chunks", async () => {
    seedChunkWithEmbedding({
      corpus: "external-source",
      doc_path: "external/doc.md",
      content: "External reference doc",
      trust_tier: "external",
      embeddingSeed: 0,
    });

    const result = await searchKnowledge({ query: "external reference", trust: "any" }, projectDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("limit parameter caps result count", async () => {
    // Seed 5 chunks all with seed 0 so they all match
    for (let i = 0; i < 5; i++) {
      const db = initDatabase(dbPath);
      const store = new DocVectorStore(db);
      const content = `Chunk number ${i}`;
      const chunkId = store.upsertDocChunk({
        corpus: "principles",
        doc_path: `principles/p${i}.md`,
        heading_path: "",
        chunk_index: i,
        char_start: 0,
        char_end: content.length,
        content,
        content_hash: DocVectorStore.textHash(content),
        trust_tier: "internal",
        updated_at: new Date().toISOString(),
      });
      store.upsertDocVector(chunkId, randomEmbedding(0), DocVectorStore.textHash(content));
      db.close();
    }

    _mockSeed = 0;

    const result = await searchKnowledge({ query: "chunk", limit: 2 }, projectDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.length).toBeLessThanOrEqual(2);
    }
  });
});
