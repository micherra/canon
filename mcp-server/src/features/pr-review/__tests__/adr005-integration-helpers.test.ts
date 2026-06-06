/**
 * ADR-005: Knowledge Graph Consolidation — Integration Tests (Part 2)
 *
 * Tests cross-task boundaries and coverage gaps (continued from adr005-integration.test.ts):
 *
 *   7. generateNarrative — violation count fallback via f.violations
 *   8. show-pr-impact helpers — detectSubsystems and buildBlastRadiusByFile
 *   9. store-summaries → get-file-context cross-task round-trip (multiple files)
 *  10. pr-review-data — kg_freshness_ms with real SQLite DB
 *
 * All DB-bound tests use in-memory SQLite (:memory:).
 * All filesystem-bound tests use OS temp directories created fresh per test.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storeSummaries } from "@features/diagnostics/tools/store-summaries.ts";
import { getFileContext } from "@features/file-context/tools/get-file-context.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { generateNarrative } from "../tools/pr-review-data-helpers.ts";
import {
  buildBlastRadiusByFile,
  detectSubsystems,
  type PrImpactOutput,
} from "../tools/show-pr-impact.ts";

// 7. generateNarrative — violation fallback via DriftStore violations
//
// Gap: adr005-04 notes that generateNarrative was updated to use
// f.violations?.length as fallback. This path isn't explicitly integration-tested.

describe("generateNarrative — violation count fallback via f.violations", () => {
  it("counts violations from priority_factors.violation_count when available", () => {
    const files = [
      {
        layer: "api",
        path: "src/a.ts",
        priority_factors: {
          in_degree: 1,
          is_changed: true,
          layer: "api",
          layer_centrality: 1,
          violation_count: 3,
        },
        priority_score: 5,
        status: "modified" as const,
      },
    ];
    const narrative = generateNarrative(files, [{ file_count: 1, name: "api" }]);
    expect(narrative).toContain("3 principle violations");
  });

  it("falls back to f.violations.length when priority_factors absent", () => {
    const files = [
      {
        layer: "api",
        path: "src/a.ts",
        status: "modified" as const,
        violations: [
          { principle_id: "P1", severity: "rule" as const },
          { principle_id: "P2", severity: "convention" as const },
        ],
      },
    ];
    const narrative = generateNarrative(files, [{ file_count: 1, name: "api" }]);
    expect(narrative).toContain("2 principle violations");
  });

  it("produces no violation sentence when no violations exist", () => {
    const files = [
      {
        layer: "domain",
        path: "src/clean.ts",
        status: "added" as const,
        violations: [],
      },
    ];
    const narrative = generateNarrative(files, [{ file_count: 1, name: "domain" }]);
    expect(narrative).not.toContain("violation");
  });
});

// 8. show-pr-impact helpers — detectSubsystems and buildBlastRadiusByFile
//
// Gap: adr005-04 implementor notes these are tested via unit mocks. These are
// integration tests that verify the pure function contracts directly.

describe("detectSubsystems", () => {
  it("detects a new subsystem when 3+ added files share a 2-segment prefix", () => {
    const files = [
      "src/auth/login.ts",
      "src/auth/register.ts",
      "src/auth/session.ts",
      "src/graph/query.ts",
    ];
    const statusMap = new Map([
      ["src/auth/login.ts", "added"],
      ["src/auth/register.ts", "added"],
      ["src/auth/session.ts", "added"],
      ["src/graph/query.ts", "added"],
    ]);
    const result = detectSubsystems(files, statusMap);
    const authSystem = result.find((s) => s.directory === "src/auth");
    expect(authSystem).toBeDefined();
    expect(authSystem!.label).toBe("new");
    expect(authSystem!.file_count).toBe(3);
    // src/graph only has 1 added file — not enough for a subsystem
    expect(result.find((s) => s.directory === "src/graph")).toBeUndefined();
  });

  it("detects a removed subsystem when 3+ deleted files share a prefix", () => {
    const files = ["src/legacy/a.ts", "src/legacy/b.ts", "src/legacy/c.ts"];
    const statusMap = new Map([
      ["src/legacy/a.ts", "deleted"],
      ["src/legacy/b.ts", "deleted"],
      ["src/legacy/c.ts", "deleted"],
    ]);
    const result = detectSubsystems(files, statusMap);
    const legacySystem = result.find((s) => s.directory === "src/legacy");
    expect(legacySystem).toBeDefined();
    expect(legacySystem!.label).toBe("removed");
  });

  it("returns results sorted by file_count descending", () => {
    const files = [
      "src/small/a.ts",
      "src/small/b.ts",
      "src/small/c.ts",
      "src/large/a.ts",
      "src/large/b.ts",
      "src/large/c.ts",
      "src/large/d.ts",
      "src/large/e.ts",
    ];
    const statusMap = new Map(files.map((f) => [f, "added"] as [string, string]));
    const result = detectSubsystems(files, statusMap);
    // Should be sorted: large (5) then small (3)
    expect(result[0]!.directory).toBe("src/large");
    expect(result[1]!.directory).toBe("src/small");
  });

  it("returns empty array when no group meets threshold", () => {
    const files = ["src/a/one.ts", "src/b/two.ts"];
    const statusMap = new Map([
      ["src/a/one.ts", "added"],
      ["src/b/two.ts", "added"],
    ]);
    expect(detectSubsystems(files, statusMap)).toHaveLength(0);
  });

  it("handles files with single path segment using '.' as directory", () => {
    const files = ["root-a.ts", "root-b.ts", "root-c.ts"];
    const statusMap = new Map(files.map((f) => [f, "added"] as [string, string]));
    const result = detectSubsystems(files, statusMap);
    const rootSystem = result.find((s) => s.directory === ".");
    expect(rootSystem).toBeDefined();
    expect(rootSystem!.label).toBe("new");
    expect(rootSystem!.file_count).toBe(3);
  });
});

describe("buildBlastRadiusByFile", () => {
  it("returns empty array when blastRadius is undefined", () => {
    expect(buildBlastRadiusByFile(undefined)).toHaveLength(0);
  });

  it("groups affected entries by file_path and returns top 15 by dep_count", () => {
    const affected: NonNullable<PrImpactOutput["blastRadius"]>["affected"] = [
      { depth: 1, entity_kind: "function", entity_name: "funcA", file_path: "src/A.ts" },
      { depth: 1, entity_kind: "function", entity_name: "funcB", file_path: "src/A.ts" },
      { depth: 2, entity_kind: "function", entity_name: "funcC", file_path: "src/B.ts" },
    ];
    const result = buildBlastRadiusByFile({
      affected,
      affected_files: 2,
      by_depth: { 1: 2, 2: 1 },
      total_affected: 3,
    });
    expect(result).toHaveLength(2);
    expect(result[0]!.file).toBe("src/A.ts");
    expect(result[0]!.dep_count).toBe(2);
    expect(result[1]!.file).toBe("src/B.ts");
    expect(result[1]!.dep_count).toBe(1);
  });

  it("limits to 15 entries when more than 15 files in blast radius", () => {
    const affected: NonNullable<PrImpactOutput["blastRadius"]>["affected"] = Array.from(
      { length: 20 },
      (_, i) => ({
        depth: 1,
        entity_kind: "function",
        entity_name: `func${i}`,
        file_path: `src/file${i}.ts`,
      }),
    );
    const result = buildBlastRadiusByFile({
      affected,
      affected_files: 20,
      by_depth: { 1: 20 },
      total_affected: 20,
    });
    expect(result).toHaveLength(15);
  });

  it("skips entries with empty file_path", () => {
    const affected: NonNullable<PrImpactOutput["blastRadius"]>["affected"] = [
      { depth: 1, entity_kind: "function", entity_name: "funcA", file_path: "src/A.ts" },
      { depth: 1, entity_kind: "function", entity_name: "funcB", file_path: "" },
    ];
    const result = buildBlastRadiusByFile({
      affected,
      affected_files: 1,
      by_depth: { 1: 2 },
      total_affected: 2,
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.file).toBe("src/A.ts");
  });
});

// 9. store-summaries → get-file-context cross-task round-trip with multiple files
//
// Integration gap: adr005-06 tests single-file round-trip. This tests batch
// storeSummaries → individual getFileContext reads for multiple files.
//
// Per-test timeout: each test calls getFileContext which runs ensureGraphFresh
// internally (real SQLite + FS I/O). Under full-suite load this takes ~2.8s per
// call. The 15s timeout gives adequate headroom without being excessively long.
// This is a legitimate I/O budget, NOT suppression of a misbehaving test.

describe("store-summaries → get-file-context cross-task round-trip (multiple files)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-adr005-multifile-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    await mkdir(join(tmpDir, "src", "api"), { recursive: true });
    await mkdir(join(tmpDir, "src", "domain"), { recursive: true });

    // Create actual source files on disk for getFileContext to read
    await writeFile(join(tmpDir, "src", "api", "handler.ts"), "export function handleRequest() {}");
    await writeFile(
      join(tmpDir, "src", "domain", "user.ts"),
      "export interface User { id: string; }",
    );

    dbPath = join(tmpDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
    const db = initDatabase(dbPath);
    const store = new KgStore(db);

    // Register both files in the KG
    store.upsertFile({
      content_hash: "h1",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "api",
      mtime_ms: Date.now(),
      path: "src/api/handler.ts",
    });
    store.upsertFile({
      content_hash: "h2",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "domain",
      mtime_ms: Date.now(),
      path: "src/domain/user.ts",
    });

    db.close();
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("batch store then read — each file has its own summary", async () => {
    await storeSummaries(
      {
        summaries: [
          { file_path: "src/api/handler.ts", summary: "HTTP request handler" },
          { file_path: "src/domain/user.ts", summary: "User domain entity" },
        ],
      },
      tmpDir,
    );

    const handlerCtx = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
    const userCtx = await getFileContext({ file_path: "src/domain/user.ts" }, tmpDir);

    expect(handlerCtx.ok).toBe(true);
    expect(userCtx.ok).toBe(true);

    if (!handlerCtx.ok || !userCtx.ok) throw new Error("Expected ok results");

    expect(handlerCtx.summary).toBe("HTTP request handler");
    expect(userCtx.summary).toBe("User domain entity");
  }, 15_000);

  it("overwrite: second storeSummaries updates both files, reads reflect updated values", async () => {
    await storeSummaries(
      {
        summaries: [
          { file_path: "src/api/handler.ts", summary: "First summary" },
          { file_path: "src/domain/user.ts", summary: "First user summary" },
        ],
      },
      tmpDir,
    );

    await storeSummaries(
      {
        summaries: [
          { file_path: "src/api/handler.ts", summary: "Updated handler summary" },
          { file_path: "src/domain/user.ts", summary: "Updated user summary" },
        ],
      },
      tmpDir,
    );

    const handlerCtx = await getFileContext({ file_path: "src/api/handler.ts" }, tmpDir);
    const userCtx = await getFileContext({ file_path: "src/domain/user.ts" }, tmpDir);

    if (!handlerCtx.ok || !userCtx.ok) throw new Error("Expected ok results");

    expect(handlerCtx.summary).toBe("Updated handler summary");
    expect(userCtx.summary).toBe("Updated user summary");
  }, 15_000);

  it("file not in KG gets auto-stub and summary is readable via getFileContext", async () => {
    // src/new/tool.ts is NOT pre-registered in the KG
    await mkdir(join(tmpDir, "src", "new"), { recursive: true });
    await writeFile(join(tmpDir, "src", "new", "tool.ts"), "export const VERSION = '1.0';");

    await storeSummaries(
      { summaries: [{ file_path: "src/new/tool.ts", summary: "Auto-stubbed file summary" }] },
      tmpDir,
    );

    const result = await getFileContext({ file_path: "src/new/tool.ts" }, tmpDir);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.summary).toBe("Auto-stubbed file summary");
  }, 15_000);
});

// 10. DB-only workflow: kg_freshness_ms flows from KgQuery to getPrReviewData
//
// Gap declared in adr005-04: "pr-review-data.ts priority scoring with a fully
// populated KG is only tested via unit tests with mock KgQuery data."
// This test verifies the kg_freshness_ms field flows correctly with a real SQLite DB.
//
// Module setup: vi.resetModules() + vi.doMock + dynamic import are hoisted to
// beforeAll so the expensive module tree reload (pr-review-data.ts imports the
// full KG + git adapter stack) only happens once per describe block instead of
// once per test. Both tests share the same gitExecAsync mock (empty diff) so
// a single shared import is safe. Under full-suite load, per-test module resets
// were the primary source of the 5s timeout flake.

describe("pr-review-data — kg_freshness_ms with real SQLite DB", () => {
  let tmpDir: string;
  let getPrReviewData: (
    input: Record<string, unknown>,
    dir: string,
  ) => Promise<{ kg_freshness_ms?: number }>;

  beforeAll(async () => {
    // Reset module registry once so vi.doMock applies to the fresh import below.
    vi.resetModules();
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: vi.fn().mockResolvedValue({
        exitCode: 0,
        ok: true,
        stderr: "",
        stdout: "",
        timedOut: false,
      }),
    }));
    // Import once; both tests reuse this cached function.
    const mod = await import("../tools/pr-review-data.js");
    getPrReviewData = mod.getPrReviewData as typeof getPrReviewData;
  });

  afterAll(async () => {
    vi.restoreAllMocks();
  });

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-freshness-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("kg_freshness_ms is present in output when KG DB exists with indexed files", async () => {
    const dbPath = join(tmpDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    const tenMinutesAgo = Date.now() - 600_000;

    store.upsertFile({
      content_hash: "abc",
      language: "typescript",
      last_indexed_at: tenMinutesAgo,
      layer: "domain",
      mtime_ms: Date.now(),
      path: "src/some-file.ts",
    });
    db.close();

    const result = await getPrReviewData({}, tmpDir);

    // kg_freshness_ms must be present and represent ~10 minutes
    expect(result.kg_freshness_ms).toBeDefined();
    expect(result.kg_freshness_ms).toBeGreaterThanOrEqual(600_000 - 5_000);
    expect(result.kg_freshness_ms).toBeLessThanOrEqual(600_000 + 5_000);
  });

  it("kg_freshness_ms is undefined when KG DB does not exist", async () => {
    const result = await getPrReviewData({}, tmpDir);

    expect(result.kg_freshness_ms).toBeUndefined();
  });
});
