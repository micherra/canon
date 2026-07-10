/**
 * recall-handler-integration.test.ts
 *
 * Closes the reviewer-flagged coverage gap on `recall`: the success-path
 * mapping for the `code_kg` (semanticSearch) and `knowledge` (searchKnowledge)
 * adapters was covered only by mocked tests in recall-handler.test.ts — the
 * engineer's own live end-to-end call hit their fail-open branch because this
 * worktree's KG isn't indexed (see m1-SUMMARY.md Known Gaps).
 *
 * This file drives the REAL (non-mocked) recall-handler.ts against a real
 * temp-project KG + doc-vector index, seeded directly via KgStore/KgVectorStore
 * and DocVectorStore — the same pattern as
 * semantic-search-integration.test.ts's "KgVectorQuery threshold" block and
 * search-knowledge-integration.test.ts. Only EmbeddingService and
 * ensureDocCorpusFresh are mocked (no model download, no real-repo doc scan) —
 * @app/server-state.ts, recall-handler.ts, semanticSearch, searchKnowledge,
 * getDecisionsCorpus, getBuildHistory, and rankAdrs all run unmocked.
 *
 * `adr` runs against this worktree's REAL docs/adr/ (pluginDir resolves via the
 * real marker-walk since server-state.ts is not mocked here) — ADR-0005's title
 * ("knowledge-graph is a foundational service") shares "knowledge"/"graph"
 * tokens with the query below, so a real 3rd store (adr) contributes alongside
 * the two real targets of this gap (code_kg, knowledge) without any seeding.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clearConnectionScope,
  registerConnectionScope,
  STDIO_SESSION_ID,
} from "@app/server-state.ts";
import { DocVectorStore } from "@graph/kg-doc-store.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import { KgVectorStore } from "@graph/kg-vector-store.ts";
import { randomEmbedding } from "@tests/helpers/embedding-test-helpers.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRecall } from "../recall-handler.ts";

// A single fixed embedding shared by the query and every seeded vector below.
// handleRecall fans out to all stores concurrently (Promise.all), so a
// per-call incrementing seed counter (as in the sibling *-integration.test.ts
// files, which query one store at a time) would race between the code_kg and
// knowledge adapters' concurrent embedOne() calls. A single fixed vector makes
// every query deterministically distance≈0 against every seeded candidate,
// regardless of call interleaving.
const QUERY_EMBEDDING = randomEmbedding(7);

vi.mock("@graph/kg-embedding.ts", () => ({
  EmbeddingService: class MockEmbeddingService {
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => QUERY_EMBEDDING);
    }
    async embedOne(_text: string): Promise<Float32Array> {
      return QUERY_EMBEDDING;
    }
    dispose(): void {
      /* no-op */
    }
    get isLoaded(): boolean {
      return false;
    }
  },
}));

// Freshness gate not under test here — matches search-knowledge-integration.test.ts.
vi.mock("@features/knowledge-graph/ensure-doc-corpus-fresh.ts", () => ({
  ensureDocCorpusFresh: vi.fn().mockResolvedValue(undefined),
}));

const QUERY = "knowledge graph entity mapping recall test";
const SEEDED_ENTITY_FILE_PATH = "src/recall-fixture/AuthService.ts";
const SEEDED_DOC_CONTENT =
  "recall-fixture: handles payment processing knowledge graph entity mapping recall test.";

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "recall-handler-integration-"));
}

/** Seed one KG entity + entity vector matching QUERY_EMBEDDING exactly. */
function seedKgEntity(dbPath: string): void {
  const db = initDatabase(dbPath);
  const store = new KgStore(db);
  const vectorStore = new KgVectorStore(db);

  const fileRow = store.upsertFile({
    content_hash: "recall-fixture-hash",
    language: "typescript",
    last_indexed_at: Date.now(),
    layer: "domain",
    mtime_ms: Date.now(),
    path: SEEDED_ENTITY_FILE_PATH,
  });
  const entityRow = store.insertEntity({
    file_id: fileRow.file_id!,
    is_default_export: false,
    is_exported: true,
    kind: "function",
    line_end: 10,
    line_start: 1,
    metadata: null,
    name: "authenticateUser",
    qualified_name: `${SEEDED_ENTITY_FILE_PATH}::authenticateUser`,
    signature: null,
  });
  vectorStore.upsertEntityVector(
    entityRow.entity_id!,
    QUERY_EMBEDDING,
    KgVectorStore.textHash("authenticateUser"),
  );
  db.close();
}

/** Seed one doc chunk + doc vector matching QUERY_EMBEDDING exactly. */
function seedDocChunk(dbPath: string): void {
  const db = initDatabase(dbPath);
  const store = new DocVectorStore(db);
  const contentHash = DocVectorStore.textHash(SEEDED_DOC_CONTENT);
  const chunkId = store.upsertDocChunk({
    char_end: SEEDED_DOC_CONTENT.length,
    char_start: 0,
    chunk_index: 0,
    content: SEEDED_DOC_CONTENT,
    content_hash: contentHash,
    corpus: "principles",
    doc_path: "recall-fixture.md",
    heading_path: "Recall Fixture",
    trust_tier: "internal",
    updated_at: new Date().toISOString(),
  });
  store.upsertDocVector(chunkId, QUERY_EMBEDDING, contentHash);
  db.close();
}

describe("recall integration — real code_kg + knowledge success-path mapping", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempDir();
    mkdirSync(path.join(projectDir, ".canon"), { recursive: true });
    registerConnectionScope(STDIO_SESSION_ID, projectDir);
  });

  afterEach(() => {
    clearConnectionScope(STDIO_SESSION_ID);
    rmSync(projectDir, { force: true, recursive: true });
    vi.clearAllMocks();
  });

  it("maps real semanticSearch + searchKnowledge hits into fused RecallHit provenance (closes the reviewer-flagged gap)", async () => {
    const dbPath = path.join(projectDir, ".canon", "knowledge-graph.db");
    seedKgEntity(dbPath);
    seedDocChunk(dbPath);

    const output = await handleRecall({ query: QUERY });

    expect(output.skipped).toEqual([]);

    // --- code_kg: real semanticSearch → real mapSemanticSearchResult mapping ---
    const codeKgHit = output.hits.find((h) => h.source_store === "code_kg");
    expect(codeKgHit).toBeDefined();
    expect(codeKgHit!.id).toMatch(/^entity:\d+$/);
    expect(codeKgHit!.path).toBe(SEEDED_ENTITY_FILE_PATH);
    expect(codeKgHit!.snippet).toContain("authenticateUser");
    expect(typeof codeKgHit!.native_score).toBe("number");
    expect(codeKgHit!.native_rank).toBe(1);
    expect(codeKgHit!.rrf_score).toBeGreaterThan(0);

    // --- knowledge: real searchKnowledge → real doc mapping ---
    const knowledgeHit = output.hits.find((h) => h.source_store === "knowledge");
    expect(knowledgeHit).toBeDefined();
    expect(knowledgeHit!.id).toBe("doc:principles/recall-fixture.md#0");
    expect(knowledgeHit!.path).toBe("recall-fixture.md");
    expect(knowledgeHit!.snippet).toBe(SEEDED_DOC_CONTENT.slice(0, 200));
    expect(typeof knowledgeHit!.native_score).toBe("number");
    expect(knowledgeHit!.native_rank).toBe(1);
    expect(knowledgeHit!.rrf_score).toBeGreaterThan(0);

    // --- dc-01: span >=3 distinct real (non-mocked) stores ---
    // adr is real too — ADR-0005's title shares "knowledge"/"graph" tokens with QUERY.
    const stores = new Set(output.hits.map((h) => h.source_store));
    expect(stores.size).toBeGreaterThanOrEqual(3);
    expect(stores.has("adr")).toBe(true);
    expect(output.stores_queried).toEqual(
      expect.arrayContaining(["code_kg", "knowledge", "adr", "decisions", "build_history"]),
    );

    // --- dc-02: full provenance on every hit ---
    for (const hit of output.hits) {
      expect(hit).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          native_rank: expect.any(Number),
          rrf_score: expect.any(Number),
          snippet: expect.any(String),
          source_store: expect.any(String),
        }),
      );
    }
  });

  it("RRF determinism: identical real fan-out call twice yields identical ranked order", async () => {
    const dbPath = path.join(projectDir, ".canon", "knowledge-graph.db");
    seedKgEntity(dbPath);
    seedDocChunk(dbPath);

    const first = await handleRecall({ query: QUERY });
    const second = await handleRecall({ query: QUERY });

    expect(second.hits.map((h) => h.id)).toEqual(first.hits.map((h) => h.id));
    expect(second.hits.map((h) => h.rrf_score)).toEqual(first.hits.map((h) => h.rrf_score));
  });

  it("is per-store fail-open end-to-end against a REAL (non-mocked) KG_NOT_INDEXED error", async () => {
    // No .canon/knowledge-graph.db written — code_kg and knowledge both hit the
    // real existsSync-false branch in semanticSearch/searchKnowledge (not a
    // forced mock rejection, unlike recall-handler.test.ts's unit-level test).
    const output = await handleRecall({ query: QUERY });

    expect(output.hits.length).toBeGreaterThan(0);
    expect(output.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ store: "code_kg" }),
        expect.objectContaining({ store: "knowledge" }),
      ]),
    );
    for (const s of output.skipped) {
      expect(s.reason).toContain("KG_NOT_INDEXED");
    }
    // adr still contributes real data despite the two KG-backed stores failing.
    expect(output.hits.some((h) => h.source_store === "adr")).toBe(true);
  });
});
