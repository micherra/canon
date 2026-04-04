/**
 * semantic_search MCP tool tests
 *
 * Uses in-memory SQLite and a mock EmbeddingService — no model download needed.
 * Real model correctness is covered by kg-embedding.test.ts.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { semanticSearch } from "../tools/semantic-search.ts";
import { randomEmbedding } from "./embedding-test-helpers.ts";

// Mock EmbeddingService

const mockEmbedOne = vi.fn<(text: string) => Promise<Float32Array>>();
const mockDispose = vi.fn();

vi.mock("../graph/kg-embedding.ts", () => {
  // Must be a proper class so `new EmbeddingService()` works
  class EmbeddingService {
    embedOne(text: string) {
      return mockEmbedOne(text);
    }
    embed(texts: string[]) {
      return Promise.resolve(texts.map((_, i) => randomEmbedding(i)));
    }
    dispose() {
      mockDispose();
    }
    get isLoaded() {
      return false;
    }
  }
  return { EmbeddingService };
});

// Test DB seeding helpers

async function seedTestDb(dbPath: string): Promise<void> {
  // We need to seed the DB with entities, vectors, and summaries for integration tests.
  // Use initDatabase and KgStore/KgVectorStore directly (not through semanticSearch).
  const { initDatabase } = await import("../graph/kg-schema.ts");
  const { KgStore } = await import("../graph/kg-store.ts");
  const { KgVectorStore } = await import("../graph/kg-vector-store.ts");

  const db = initDatabase(dbPath);
  const store = new KgStore(db);
  const vectorStore = new KgVectorStore(db);

  // Insert a file
  const file = store.upsertFile({
    content_hash: "abc",
    language: "typescript",
    last_indexed_at: Date.now(),
    layer: "api",
    mtime_ms: Date.now(),
    path: "src/middleware/error-handler.ts",
  });

  const fileId = file.file_id!;

  // Insert an entity of kind "function"
  const entityRow = store.insertEntity({
    file_id: fileId,
    is_default_export: false,
    is_exported: true,
    kind: "function",
    line_end: 10,
    line_start: 1,
    metadata: null,
    name: "errorHandler",
    qualified_name: "src/middleware/error-handler.ts::errorHandler",
    signature: "function errorHandler(err: Error, req: Request): Response",
  });
  const entityId = entityRow.entity_id!;

  // Insert another entity of kind "class"
  const file2 = store.upsertFile({
    content_hash: "def",
    language: "typescript",
    last_indexed_at: Date.now(),
    layer: "domain",
    mtime_ms: Date.now(),
    path: "src/services/auth.ts",
  });

  const fileId2 = file2.file_id!;

  const entityRow2 = store.insertEntity({
    file_id: fileId2,
    is_default_export: false,
    is_exported: true,
    kind: "class",
    line_end: 50,
    line_start: 1,
    metadata: null,
    name: "AuthService",
    qualified_name: "src/services/auth.ts::AuthService",
    signature: "class AuthService",
  });
  const entityId2 = entityRow2.entity_id!;

  // Insert entity vectors (seed 1 for errorHandler, seed 2 for AuthService)
  const vec1 = randomEmbedding(1);
  const vec2 = randomEmbedding(2);

  vectorStore.upsertEntityVector(entityId, vec1, KgVectorStore.textHash("function: errorHandler"));
  vectorStore.upsertEntityVector(entityId2, vec2, KgVectorStore.textHash("class: AuthService"));

  // Insert a file-level summary and its vector
  store.upsertSummary({
    content_hash: "abc",
    entity_id: null,
    file_id: fileId,
    model: null,
    scope: "file",
    summary: "Error handling middleware for Express",
    updated_at: new Date().toISOString(),
  });

  const summaryRow = store.getSummaryByFile(fileId);
  if (summaryRow?.summary_id) {
    const vec3 = randomEmbedding(3);
    vectorStore.upsertSummaryVector(
      summaryRow.summary_id,
      vec3,
      KgVectorStore.textHash("Error handling middleware for Express"),
    );
  }

  db.close();
}

describe("semanticSearch", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-semantic-search-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  // Error cases

  it("returns KG_NOT_INDEXED when database does not exist", async () => {
    mockEmbedOne.mockResolvedValue(randomEmbedding(0));

    const result = await semanticSearch({ query: "error handling" }, tmpDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("KG_NOT_INDEXED");
      expect(result.recoverable).toBe(true);
    }
  });

  it("returns INVALID_INPUT for empty query string", async () => {
    const result = await semanticSearch({ query: "" }, tmpDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("returns INVALID_INPUT for whitespace-only query", async () => {
    const result = await semanticSearch({ query: "   " }, tmpDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  // Happy path — valid query against a pre-populated DB

  it("returns results for a valid query", async () => {
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    await seedTestDb(dbPath);

    // Mock embed to return a query vector close to seed 1 (errorHandler)
    mockEmbedOne.mockResolvedValue(randomEmbedding(1));

    const result = await semanticSearch({ query: "error handling middleware" }, tmpDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.query).toBe("error handling middleware");
      expect(result.count).toBeGreaterThan(0);
      expect(result.results).toHaveLength(result.count);
      // Each result should have the required shape
      for (const r of result.results) {
        expect(r).toHaveProperty("entity_id");
        expect(r).toHaveProperty("distance");
        expect(r).toHaveProperty("source");
        expect(r).toHaveProperty("file_path");
      }
    }
  });

  it("returns results with expected structure", async () => {
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    await seedTestDb(dbPath);

    mockEmbedOne.mockResolvedValue(randomEmbedding(1));

    const result = await semanticSearch({ query: "authentication service" }, tmpDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const r of result.results) {
        // SemanticSearchResult shape
        expect(typeof r.entity_id).toBe("number");
        expect(typeof r.distance).toBe("number");
        expect(typeof r.file_path).toBe("string");
        expect(["entity", "summary"]).toContain(r.source);
        expect(typeof r.name).toBe("string");
        expect(typeof r.qualified_name).toBe("string");
      }
    }
  });

  // kind_filter restricts results

  it("kind_filter restricts results to specified entity kinds", async () => {
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    await seedTestDb(dbPath);

    mockEmbedOne.mockResolvedValue(randomEmbedding(0));

    const result = await semanticSearch(
      { kind_filter: ["function"], query: "auth service", scope: "entities" },
      tmpDir,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // All entity results should be of kind "function"
      for (const r of result.results) {
        if (r.source === "entity") {
          expect(r.kind).toBe("function");
        }
      }
    }
  });

  it("kind_filter=['class'] excludes function entities", async () => {
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    await seedTestDb(dbPath);

    mockEmbedOne.mockResolvedValue(randomEmbedding(0));

    const result = await semanticSearch(
      { kind_filter: ["class"], query: "service", scope: "entities" },
      tmpDir,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const r of result.results) {
        if (r.source === "entity") {
          expect(r.kind).toBe("class");
        }
      }
    }
  });

  // scope parameter

  it("scope='entities' returns only entity-sourced results", async () => {
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    await seedTestDb(dbPath);

    mockEmbedOne.mockResolvedValue(randomEmbedding(0));

    const result = await semanticSearch({ query: "error handler", scope: "entities" }, tmpDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const r of result.results) {
        expect(r.source).toBe("entity");
      }
    }
  });

  it("scope='summaries' returns only summary-sourced results", async () => {
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    await seedTestDb(dbPath);

    mockEmbedOne.mockResolvedValue(randomEmbedding(0));

    const result = await semanticSearch({ query: "error handler", scope: "summaries" }, tmpDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const r of result.results) {
        expect(r.source).toBe("summary");
      }
    }
  });

  it("scope='both' returns results from both sources (when both have data)", async () => {
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    await seedTestDb(dbPath);

    // Use a query vector that should match both entity and summary vectors
    mockEmbedOne.mockResolvedValue(randomEmbedding(0));

    const result = await semanticSearch({ query: "error handling", scope: "both" }, tmpDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const sources = new Set(result.results.map((r) => r.source));
      // Both entity and summary results should appear
      expect(sources.has("entity")).toBe(true);
      expect(sources.has("summary")).toBe(true);
    }
  });

  // Results are sorted by distance (ascending)

  it("results are sorted by distance ascending", async () => {
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    await seedTestDb(dbPath);

    mockEmbedOne.mockResolvedValue(randomEmbedding(0));

    const result = await semanticSearch({ limit: 10, query: "handler" }, tmpDir);

    expect(result.ok).toBe(true);
    if (result.ok && result.results.length > 1) {
      for (let i = 1; i < result.results.length; i++) {
        expect(result.results[i].distance).toBeGreaterThanOrEqual(result.results[i - 1].distance);
      }
    }
  });

  // limit parameter

  it("limit parameter restricts result count", async () => {
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    await seedTestDb(dbPath);

    mockEmbedOne.mockResolvedValue(randomEmbedding(0));

    const result = await semanticSearch({ limit: 1, query: "code" }, tmpDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.results.length).toBeLessThanOrEqual(1);
    }
  });

  // dispose is called

  it("disposes the EmbeddingService after search", async () => {
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    await seedTestDb(dbPath);

    mockEmbedOne.mockResolvedValue(randomEmbedding(0));

    await semanticSearch({ query: "handler" }, tmpDir);

    expect(mockDispose).toHaveBeenCalledOnce();
  });

  it("disposes the EmbeddingService even when search throws", async () => {
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    await seedTestDb(dbPath);

    // Make embedOne throw an unexpected error
    mockEmbedOne.mockRejectedValue(new Error("unexpected model failure"));

    await expect(semanticSearch({ query: "handler" }, tmpDir)).rejects.toThrow(
      "unexpected model failure",
    );

    expect(mockDispose).toHaveBeenCalledOnce();
  });

  // Network/download error → recoverable UNEXPECTED

  it("returns recoverable UNEXPECTED error when model download fails", async () => {
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    await seedTestDb(dbPath);

    mockEmbedOne.mockRejectedValue(new Error("fetch failed: network error"));

    const result = await semanticSearch({ query: "handler" }, tmpDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("UNEXPECTED");
      expect(result.recoverable).toBe(true);
    }
  });
});
