/**
 * Tests for PR #57 review comments (feat: semantic search Phase 1).
 *
 * Fix 1: write-plan-index.ts — path traversal validation on slug parameter
 * Fix 2: flow-parser.ts — widen buildEffectiveParams to support boolean params
 * Fix 3: kg-vector-store.ts — remove unused `rows` variable in getStaleEntityVectors
 * Fix 4: kg-vector-query.ts — parameterize SQL threshold in _queryEntityVectors
 * Fix 5: kg-vector-query.ts — parameterize SQL threshold in _querySummaryVectors
 * Fix 6: store-summaries.ts — use upsertSummary return value instead of extra DB read
 * Fix 7: verify-fix-loop.md — boolean param works now that buildEffectiveParams supports it
 */

import type Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, test, vi } from "vitest";
import { KgVectorQuery } from "../graph/kg-vector-query.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";
import { KgVectorStore } from "../graph/kg-vector-store.ts";
import { resolveFragments } from "../orchestration/flow-parser.ts";
import type { FragmentDefinition } from "../orchestration/flow-schema.ts";
import { writePlanIndex } from "../tools/write-plan-index.ts";
import { MockEmbeddingService, randomEmbedding } from "./embedding-test-helpers.ts";

// ---------------------------------------------------------------------------
// Fix 1: write-plan-index.ts — path traversal validation on slug
// ---------------------------------------------------------------------------

describe("writePlanIndex — slug path traversal validation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wpi-pr57-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns INVALID_INPUT when slug contains path traversal (../..)", async () => {
    const result = await writePlanIndex({
      workspace: tmpDir,
      slug: "../../etc",
      tasks: [{ task_id: "task-01", wave: 1 }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("slug");
    }
  });

  it("returns INVALID_INPUT when slug contains forward slash", async () => {
    const result = await writePlanIndex({
      workspace: tmpDir,
      slug: "foo/bar",
      tasks: [{ task_id: "task-01", wave: 1 }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("returns INVALID_INPUT when slug contains dot-dot component", async () => {
    const result = await writePlanIndex({
      workspace: tmpDir,
      slug: "..dangerous",
      tasks: [{ task_id: "task-01", wave: 1 }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("accepts a normal slug with hyphens and alphanumeric chars", async () => {
    const result = await writePlanIndex({
      workspace: tmpDir,
      slug: "my-epic-plan",
      tasks: [{ task_id: "task-01", wave: 1 }],
    });

    expect(result.ok).toBe(true);
  });

  it("rejects an empty slug", async () => {
    const result = await writePlanIndex({
      workspace: tmpDir,
      slug: "",
      tasks: [{ task_id: "task-01", wave: 1 }],
    });

    // Empty slug is rejected — SLUG_PATTERN requires at least 1 character
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fix 2 & 7: flow-parser.ts — boolean typed params in buildEffectiveParams
// ---------------------------------------------------------------------------

describe("resolveFragments — boolean typed param support", () => {
  const baseFlow = {
    name: "test-flow",
    description: "test",
    initial_state: "start",
    states: {
      start: { type: "terminal" as const },
    },
    principles: [],
    fragments: [],
  };

  it("uses boolean false as default when param not in with", () => {
    const fragment: FragmentDefinition = {
      fragment: "bool-frag",
      params: { write_tests: { type: "boolean", default: false } },
      states: {
        s: { type: "single" as const, agent: "a", template: "${write_tests}" },
      },
    };

    const result = resolveFragments(
      baseFlow,
      [{ definition: fragment, spawnInstructions: {} }],
      [{ fragment: "bool-frag" }],
    );

    // false → "false" via String(false) in substituteParams
    expect(result.states["s"].template).toBe("false");
  });

  it("uses boolean true as default", () => {
    const fragment: FragmentDefinition = {
      fragment: "bool-frag",
      params: { write_tests: { type: "boolean", default: true } },
      states: {
        s: { type: "single" as const, agent: "a", template: "${write_tests}" },
      },
    };

    const result = resolveFragments(
      baseFlow,
      [{ definition: fragment, spawnInstructions: {} }],
      [{ fragment: "bool-frag" }],
    );

    expect(result.states["s"].template).toBe("true");
  });

  it("allows boolean param to be overridden via with", () => {
    const fragment: FragmentDefinition = {
      fragment: "bool-frag",
      params: { write_tests: { type: "boolean", default: false } },
      states: {
        s: { type: "single" as const, agent: "a", template: "${write_tests}" },
      },
    };

    const result = resolveFragments(
      baseFlow,
      [{ definition: fragment, spawnInstructions: {} }],
      [{ fragment: "bool-frag", with: { write_tests: true } }],
    );

    expect(result.states["s"].template).toBe("true");
  });

  it("does NOT treat old-format false as required (backward compat fix)", () => {
    // Old format: false as param value used to be dropped by `paramDef !== false` check.
    // Verify that old-format false scalar is now treated as a default value.
    const fragment: FragmentDefinition = {
      fragment: "old-frag",
      // Old-format: scalar false as a default
      params: { flag: false as unknown as null },
      states: {
        s: { type: "single" as const, agent: "a", template: "${flag}" },
      },
    };

    // Should NOT throw "requires param" — false is now a valid default
    expect(() =>
      resolveFragments(
        baseFlow,
        [{ definition: fragment, spawnInstructions: {} }],
        [{ fragment: "old-frag" }],
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Fix 3: kg-vector-store.ts — unused `rows` removal does not affect behavior
//
// The `rows` variable was an intermediate query result that was never used;
// only `allCandidates` was used. Verify getStaleEntityVectors still works.
// ---------------------------------------------------------------------------

describe("KgVectorStore.getStaleEntityVectors — unused rows removal", () => {
  let db: Database.Database;
  let store: KgStore;
  let vectorStore: KgVectorStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
    vectorStore = new KgVectorStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test("returns entity with no meta row as stale", () => {
    // Seed a function entity (kind != 'file')
    const fileRow = store.upsertFile({
      path: "src/A.ts",
      mtime_ms: Date.now(),
      content_hash: "abc",
      language: "typescript",
      layer: "domain",
      last_indexed_at: Date.now(),
    });
    store.insertEntity({
      name: "myFn",
      qualified_name: "src/A.ts::myFn",
      kind: "function",
      line_start: 1,
      line_end: 5,
      is_exported: false,
      is_default_export: false,
      signature: null,
      metadata: null,
      file_id: fileRow.file_id!,
    });

    const stale = vectorStore.getStaleEntityVectors();
    expect(stale.length).toBe(1);
    expect(stale[0].qualified_name).toBe("src/A.ts::myFn");
  });

  test("excludes kind='file' entities", () => {
    // Seed a file entity — should be excluded
    const fileRow = store.upsertFile({
      path: "src/B.ts",
      mtime_ms: Date.now(),
      content_hash: "xyz",
      language: "typescript",
      layer: "domain",
      last_indexed_at: Date.now(),
    });
    // Insert kind='file' entity
    store.insertEntity({
      name: "B.ts",
      qualified_name: "src/B.ts",
      kind: "file",
      line_start: 0,
      line_end: 0,
      is_exported: false,
      is_default_export: false,
      signature: null,
      metadata: null,
      file_id: fileRow.file_id!,
    });

    const stale = vectorStore.getStaleEntityVectors();
    expect(stale.every((r) => r.kind !== "file")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 4 & 5: kg-vector-query.ts — parameterized threshold (no SQL injection)
//
// Verify that threshold filtering works correctly with bound params.
// ---------------------------------------------------------------------------


describe("KgVectorQuery — threshold uses bound param (Fixes 4 & 5)", () => {
  let db: Database.Database;
  let store: KgStore;
  let vectorStore: KgVectorStore;
  let mockService: MockEmbeddingService;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
    vectorStore = new KgVectorStore(db);
    mockService = new MockEmbeddingService();
  });

  afterEach(() => {
    db.close();
  });

  function seedEntityWithVector(
    overrides: { qualified_name?: string; name?: string; kind?: string },
    seed: number,
  ): { entityId: number; fileId: number } {
    const path = overrides.qualified_name?.split("::")[0] ?? "src/E.ts";
    const fileRow = store.upsertFile({
      path,
      mtime_ms: Date.now(),
      content_hash: `hash-${seed}`,
      language: "typescript",
      layer: "domain",
      last_indexed_at: Date.now(),
    });
    const entityRow = store.insertEntity({
      name: overrides.name ?? "fn",
      qualified_name: overrides.qualified_name ?? `${path}::fn`,
      kind: (overrides.kind as "function") ?? "function",
      line_start: 1,
      line_end: 10,
      is_exported: false,
      is_default_export: false,
      signature: null,
      metadata: null,
      file_id: fileRow.file_id!,
    });
    const vec = randomEmbedding(seed);
    vectorStore.upsertEntityVector(entityRow.entity_id!, vec, KgVectorStore.textHash(`vec-${seed}`));
    return { entityId: entityRow.entity_id!, fileId: fileRow.file_id! };
  }

  test("entity threshold 0 returns no results (all distances > 0)", async () => {
    seedEntityWithVector({ qualified_name: "src/A.ts::fn", name: "fn" }, 0);

    const query = new KgVectorQuery(db, mockService as any);
    const results = await query.semanticSearch("query", { scope: "entities", threshold: 0 });

    // All results should have distance <= 0 — with random vecs there should be none
    expect(results.every((r) => r.distance <= 0)).toBe(true);
  });

  test("entity threshold 2.0 (max possible L2 distance) returns all results", async () => {
    seedEntityWithVector({ qualified_name: "src/A.ts::fn1", name: "fn1" }, 10);
    seedEntityWithVector({ qualified_name: "src/B.ts::fn2", name: "fn2" }, 20);

    const query = new KgVectorQuery(db, mockService as any);
    const results = await query.semanticSearch("query", { scope: "entities", threshold: 2.0 });

    // All results should pass because 2.0 > any L2 distance between normalized vectors
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.distance <= 2.0)).toBe(true);
  });

  test("summary threshold 2.0 returns all summary results", async () => {
    const fileRow = store.upsertFile({
      path: "src/C.ts",
      mtime_ms: Date.now(),
      content_hash: "c-hash",
      language: "typescript",
      layer: "domain",
      last_indexed_at: Date.now(),
    });
    const summaryRow = store.upsertSummary({
      file_id: fileRow.file_id!,
      entity_id: null,
      scope: "file",
      summary: "A helpful file",
      model: null,
      content_hash: "c-hash",
      updated_at: new Date().toISOString(),
    });
    const vec = randomEmbedding(30);
    vectorStore.upsertSummaryVector(summaryRow.summary_id!, vec, KgVectorStore.textHash("A helpful file"));

    const query = new KgVectorQuery(db, mockService as any);
    const results = await query.semanticSearch("query", { scope: "summaries", threshold: 2.0 });

    expect(results.every((r) => r.distance <= 2.0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fix 6: store-summaries.ts — upsertSummary return value used directly
//
// We test the internal helper indirectly: if KgStore.upsertSummary returns the
// row with summary_id, the embedding pipeline receives the correct ID.
// ---------------------------------------------------------------------------

describe("KgStore.upsertSummary returns summary_id (Fix 6 contract)", () => {
  let db: Database.Database;
  let store: KgStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test("upsertSummary returns a SummaryRow with summary_id", () => {
    const fileRow = store.upsertFile({
      path: "src/D.ts",
      mtime_ms: Date.now(),
      content_hash: "dhash",
      language: "typescript",
      layer: "domain",
      last_indexed_at: Date.now(),
    });

    const result = store.upsertSummary({
      file_id: fileRow.file_id!,
      entity_id: null,
      scope: "file",
      summary: "Summary text",
      model: null,
      content_hash: "dhash",
      updated_at: new Date().toISOString(),
    });

    expect(result).toBeDefined();
    expect(typeof result.summary_id).toBe("number");
    expect(result.summary_id).toBeGreaterThan(0);
  });

  test("upsertSummary return value matches getSummaryByFile (same row)", () => {
    const fileRow = store.upsertFile({
      path: "src/E.ts",
      mtime_ms: Date.now(),
      content_hash: "ehash",
      language: "typescript",
      layer: "domain",
      last_indexed_at: Date.now(),
    });

    const upsertResult = store.upsertSummary({
      file_id: fileRow.file_id!,
      entity_id: null,
      scope: "file",
      summary: "Another summary",
      model: null,
      content_hash: "ehash",
      updated_at: new Date().toISOString(),
    });

    const getResult = store.getSummaryByFile(fileRow.file_id!);

    expect(upsertResult.summary_id).toBe(getResult?.summary_id);
  });
});
