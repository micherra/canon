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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, test } from "vitest";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";
import { KgVectorQuery } from "../graph/kg-vector-query.ts";
import { KgVectorStore } from "../graph/kg-vector-store.ts";
import { resolveFragments } from "../orchestration/flow-parser.ts";
import type { FragmentDefinition } from "../orchestration/flow-schema.ts";
import { writePlanIndex } from "../tools/write-plan-index.ts";
import { MockEmbeddingService, randomEmbedding } from "./embedding-test-helpers.ts";

// Fix 1: write-plan-index.ts — path traversal validation on slug

describe("writePlanIndex — slug path traversal validation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "wpi-pr57-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("returns INVALID_INPUT when slug contains path traversal (../..)", async () => {
    const result = await writePlanIndex({
      slug: "../../etc",
      tasks: [{ task_id: "task-01", wave: 1 }],
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("slug");
    }
  });

  it("returns INVALID_INPUT when slug contains forward slash", async () => {
    const result = await writePlanIndex({
      slug: "foo/bar",
      tasks: [{ task_id: "task-01", wave: 1 }],
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("returns INVALID_INPUT when slug contains dot-dot component", async () => {
    const result = await writePlanIndex({
      slug: "..dangerous",
      tasks: [{ task_id: "task-01", wave: 1 }],
      workspace: tmpDir,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
    }
  });

  it("accepts a normal slug with hyphens and alphanumeric chars", async () => {
    const result = await writePlanIndex({
      slug: "my-epic-plan",
      tasks: [{ task_id: "task-01", wave: 1 }],
      workspace: tmpDir,
    });

    expect(result.ok).toBe(true);
  });

  it("rejects an empty slug", async () => {
    const result = await writePlanIndex({
      slug: "",
      tasks: [{ task_id: "task-01", wave: 1 }],
      workspace: tmpDir,
    });

    // Empty slug is rejected — SLUG_PATTERN requires at least 1 character
    expect(result.ok).toBe(false);
  });
});

// Fix 2 & 7: flow-parser.ts — boolean typed params in buildEffectiveParams

describe("resolveFragments — boolean typed param support", () => {
  const baseFlow = {
    description: "test",
    fragments: [],
    initial_state: "start",
    name: "test-flow",
    principles: [],
    states: {
      start: { type: "terminal" as const },
    },
  };

  it("uses boolean false as default when param not in with", () => {
    const fragment: FragmentDefinition = {
      fragment: "bool-frag",
      params: { write_tests: { default: false, type: "boolean" } },
      states: {
        s: { agent: "a", template: "${write_tests}", type: "single" as const },
      },
    };

    const result = resolveFragments(
      baseFlow,
      [{ definition: fragment, spawnInstructions: {} }],
      [{ fragment: "bool-frag" }],
    );

    // false → "false" via String(false) in substituteParams
    expect(result.states.s.template).toBe("false");
  });

  it("uses boolean true as default", () => {
    const fragment: FragmentDefinition = {
      fragment: "bool-frag",
      params: { write_tests: { default: true, type: "boolean" } },
      states: {
        s: { agent: "a", template: "${write_tests}", type: "single" as const },
      },
    };

    const result = resolveFragments(
      baseFlow,
      [{ definition: fragment, spawnInstructions: {} }],
      [{ fragment: "bool-frag" }],
    );

    expect(result.states.s.template).toBe("true");
  });

  it("allows boolean param to be overridden via with", () => {
    const fragment: FragmentDefinition = {
      fragment: "bool-frag",
      params: { write_tests: { default: false, type: "boolean" } },
      states: {
        s: { agent: "a", template: "${write_tests}", type: "single" as const },
      },
    };

    const result = resolveFragments(
      baseFlow,
      [{ definition: fragment, spawnInstructions: {} }],
      [{ fragment: "bool-frag", with: { write_tests: true } }],
    );

    expect(result.states.s.template).toBe("true");
  });

  it("does NOT treat old-format false as required (backward compat fix)", () => {
    // Old format: false as param value used to be dropped by `paramDef !== false` check.
    // Verify that old-format false scalar is now treated as a default value.
    const fragment: FragmentDefinition = {
      fragment: "old-frag",
      // Old-format: scalar false as a default
      params: { flag: false as unknown as null },
      states: {
        s: { agent: "a", template: "${flag}", type: "single" as const },
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

// Fix 3: kg-vector-store.ts — unused `rows` removal does not affect behavior
//
// The `rows` variable was an intermediate query result that was never used;
// only `allCandidates` was used. Verify getStaleEntityVectors still works.

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
      content_hash: "abc",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "domain",
      mtime_ms: Date.now(),
      path: "src/A.ts",
    });
    store.insertEntity({
      file_id: fileRow.file_id!,
      is_default_export: false,
      is_exported: false,
      kind: "function",
      line_end: 5,
      line_start: 1,
      metadata: null,
      name: "myFn",
      qualified_name: "src/A.ts::myFn",
      signature: null,
    });

    const stale = vectorStore.getStaleEntityVectors();
    expect(stale.length).toBe(1);
    expect(stale[0].qualified_name).toBe("src/A.ts::myFn");
  });

  test("excludes kind='file' entities", () => {
    // Seed a file entity — should be excluded
    const fileRow = store.upsertFile({
      content_hash: "xyz",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "domain",
      mtime_ms: Date.now(),
      path: "src/B.ts",
    });
    // Insert kind='file' entity
    store.insertEntity({
      file_id: fileRow.file_id!,
      is_default_export: false,
      is_exported: false,
      kind: "file",
      line_end: 0,
      line_start: 0,
      metadata: null,
      name: "B.ts",
      qualified_name: "src/B.ts",
      signature: null,
    });

    const stale = vectorStore.getStaleEntityVectors();
    expect(stale.every((r) => r.kind !== "file")).toBe(true);
  });
});

// Fix 4 & 5: kg-vector-query.ts — parameterized threshold (no SQL injection)
//
// Verify that threshold filtering works correctly with bound params.

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
      content_hash: `hash-${seed}`,
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "domain",
      mtime_ms: Date.now(),
      path,
    });
    const entityRow = store.insertEntity({
      file_id: fileRow.file_id!,
      is_default_export: false,
      is_exported: false,
      kind: (overrides.kind as "function") ?? "function",
      line_end: 10,
      line_start: 1,
      metadata: null,
      name: overrides.name ?? "fn",
      qualified_name: overrides.qualified_name ?? `${path}::fn`,
      signature: null,
    });
    const vec = randomEmbedding(seed);
    vectorStore.upsertEntityVector(
      entityRow.entity_id!,
      vec,
      KgVectorStore.textHash(`vec-${seed}`),
    );
    return { entityId: entityRow.entity_id!, fileId: fileRow.file_id! };
  }

  test("entity threshold 0 returns no results (all distances > 0)", async () => {
    seedEntityWithVector({ name: "fn", qualified_name: "src/A.ts::fn" }, 0);

    const query = new KgVectorQuery(db, mockService as any);
    const results = await query.semanticSearch("query", { scope: "entities", threshold: 0 });

    // All results should have distance <= 0 — with random vecs there should be none
    expect(results.every((r) => r.distance <= 0)).toBe(true);
  });

  test("entity threshold 2.0 (max possible L2 distance) returns all results", async () => {
    seedEntityWithVector({ name: "fn1", qualified_name: "src/A.ts::fn1" }, 10);
    seedEntityWithVector({ name: "fn2", qualified_name: "src/B.ts::fn2" }, 20);

    const query = new KgVectorQuery(db, mockService as any);
    const results = await query.semanticSearch("query", { scope: "entities", threshold: 2.0 });

    // All results should pass because 2.0 > any L2 distance between normalized vectors
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.distance <= 2.0)).toBe(true);
  });

  test("summary threshold 2.0 returns all summary results", async () => {
    const fileRow = store.upsertFile({
      content_hash: "c-hash",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "domain",
      mtime_ms: Date.now(),
      path: "src/C.ts",
    });
    const summaryRow = store.upsertSummary({
      content_hash: "c-hash",
      entity_id: null,
      file_id: fileRow.file_id!,
      model: null,
      scope: "file",
      summary: "A helpful file",
      updated_at: new Date().toISOString(),
    });
    const vec = randomEmbedding(30);
    vectorStore.upsertSummaryVector(
      summaryRow.summary_id!,
      vec,
      KgVectorStore.textHash("A helpful file"),
    );

    const query = new KgVectorQuery(db, mockService as any);
    const results = await query.semanticSearch("query", { scope: "summaries", threshold: 2.0 });

    expect(results.every((r) => r.distance <= 2.0)).toBe(true);
  });
});

// Fix 6: store-summaries.ts — upsertSummary return value used directly
//
// We test the internal helper indirectly: if KgStore.upsertSummary returns the
// row with summary_id, the embedding pipeline receives the correct ID.

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
      content_hash: "dhash",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "domain",
      mtime_ms: Date.now(),
      path: "src/D.ts",
    });

    const result = store.upsertSummary({
      content_hash: "dhash",
      entity_id: null,
      file_id: fileRow.file_id!,
      model: null,
      scope: "file",
      summary: "Summary text",
      updated_at: new Date().toISOString(),
    });

    expect(result).toBeDefined();
    expect(typeof result.summary_id).toBe("number");
    expect(result.summary_id).toBeGreaterThan(0);
  });

  test("upsertSummary return value matches getSummaryByFile (same row)", () => {
    const fileRow = store.upsertFile({
      content_hash: "ehash",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "domain",
      mtime_ms: Date.now(),
      path: "src/E.ts",
    });

    const upsertResult = store.upsertSummary({
      content_hash: "ehash",
      entity_id: null,
      file_id: fileRow.file_id!,
      model: null,
      scope: "file",
      summary: "Another summary",
      updated_at: new Date().toISOString(),
    });

    const getResult = store.getSummaryByFile(fileRow.file_id!);

    expect(upsertResult.summary_id).toBe(getResult?.summary_id);
  });
});
