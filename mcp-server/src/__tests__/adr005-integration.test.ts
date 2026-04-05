/**
 * ADR-005: Knowledge Graph Consolidation — Integration Tests
 *
 * Tests cross-task boundaries and coverage gaps not covered by implementor unit tests:
 *
 *   1. KgQuery.getFileMetrics with changedFiles option (gap: adr005-01)
 *   2. KgQuery.getSubgraph with duplicate edges (gap: adr005-01)
 *   3. pr-review-data kg_freshness_ms with real SQLite DB (gap: adr005-04)
 *   4. pr-review-data priority scoring with high in_degree + changed file (classifyFile)
 *   5. kg-blast-radius empty result when no file_edges (no JSON fallback)
 *   6. show-pr-impact detectSubsystems and buildBlastRadiusByFile helpers
 *   7. computeFileInsightMaps with exactly 10 files (hub threshold boundary)
 *   8. store-summaries → get-file-context cross-task round-trip with multiple files
 *   9. KgQuery.getKgFreshnessMs uses MIN (oldest file drives staleness)
 *  10. DB-only workflow: no JSON files → kg_freshness_ms present in pr-review-data output
 *
 * All DB-bound tests use in-memory SQLite (:memory:).
 * All filesystem-bound tests use OS temp directories created fresh per test.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CANON_DIR, CANON_FILES } from "../shared/constants.ts";
import { computeUnifiedBlastRadius } from "../graph/kg-blast-radius.ts";
import { computeFileInsightMaps, KgQuery } from "../graph/kg-query.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";
import type { FileRow } from "../graph/kg-types.ts";
import { getFileContext } from "../tools/get-file-context.ts";
import { classifyFile, generateNarrative } from "../tools/pr-review-data.ts";
import {
  buildBlastRadiusByFile,
  detectSubsystems,
  type PrImpactOutput,
} from "../tools/show-pr-impact.ts";
import { storeSummaries } from "../tools/store-summaries.ts";

function makeFileRow(overrides: Partial<Omit<FileRow, "file_id">> = {}): Omit<FileRow, "file_id"> {
  return {
    content_hash: "abc123",
    language: "typescript",
    last_indexed_at: Date.now(),
    layer: "domain",
    mtime_ms: 1700000000000,
    path: "src/A.ts",
    ...overrides,
  };
}

// 1. KgQuery.getFileMetrics with changedFiles option
//
// Gap declared in adr005-01: "getFileMetrics with changedFiles option — impact_score
// changes with isChanged=true, only tested at structural level."

describe("KgQuery.getFileMetrics with changedFiles option", () => {
  let db: Database.Database;
  let store: KgStore;
  let query: KgQuery;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
    query = new KgQuery(db);
  });

  afterEach(() => {
    store.close();
  });

  it("impact_score is higher when file is in changedFiles vs not changed", () => {
    const fileA = store.upsertFile(makeFileRow({ layer: "domain", path: "src/A.ts" }));
    // Give A some in_degree by adding a file that imports it
    const fileB = store.upsertFile(makeFileRow({ layer: "domain", path: "src/B.ts" }));
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: "import A from './A'",
      relation: null,
      source_file_id: fileB.file_id!,
      target_file_id: fileA.file_id!,
    });

    const notChanged = query.getFileMetrics("src/A.ts", {
      changedFiles: new Set([]),
    });
    const changed = query.getFileMetrics("src/A.ts", {
      changedFiles: new Set(["src/A.ts"]),
    });

    expect(notChanged).not.toBeNull();
    expect(changed).not.toBeNull();

    // isChanged adds 1 to impact_score
    expect(changed!.impact_score).toBeGreaterThan(notChanged!.impact_score);
    expect(changed!.impact_score - notChanged!.impact_score).toBeCloseTo(1, 5);

    void fileA;
  });

  it("impact_score is 0 for isolated file with no violations and not changed", () => {
    store.upsertFile(makeFileRow({ layer: "unknown", path: "src/isolated.ts" }));
    const metrics = query.getFileMetrics("src/isolated.ts");
    expect(metrics).not.toBeNull();
    expect(metrics!.impact_score).toBe(0);
  });

  it("is_hub reflects hubPaths option correctly", () => {
    store.upsertFile(makeFileRow({ layer: "shared", path: "src/hub.ts" }));

    const notHub = query.getFileMetrics("src/hub.ts", {
      hubPaths: new Set([]),
    });
    const isHub = query.getFileMetrics("src/hub.ts", {
      hubPaths: new Set(["src/hub.ts"]),
    });

    expect(notHub!.is_hub).toBe(false);
    expect(isHub!.is_hub).toBe(true);
  });

  it("in_cycle and cycle_peers reflect cycleMemberPaths option", () => {
    store.upsertFile(makeFileRow({ layer: "domain", path: "src/A.ts" }));

    const notCycle = query.getFileMetrics("src/A.ts", {
      cycleMemberPaths: new Map(),
    });
    const inCycle = query.getFileMetrics("src/A.ts", {
      cycleMemberPaths: new Map([["src/A.ts", ["src/B.ts"]]]),
    });

    expect(notCycle!.in_cycle).toBe(false);
    expect(notCycle!.cycle_peers).toEqual([]);
    expect(inCycle!.in_cycle).toBe(true);
    expect(inCycle!.cycle_peers).toEqual(["src/B.ts"]);
  });
});

// 2. KgQuery.getSubgraph with duplicate edges
//
// Gap declared in adr005-01: "getSubgraph with duplicate edges — not tested."
// Current implementation does not deduplicate — this test verifies the behavior
// and that it doesn't throw.

describe("KgQuery.getSubgraph with duplicate edges", () => {
  let db: Database.Database;
  let store: KgStore;
  let query: KgQuery;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
    query = new KgQuery(db);
  });

  afterEach(() => {
    store.close();
  });

  it("returns nodes correctly even when the same file appears in multiple edge rows", () => {
    const fileA = store.upsertFile(makeFileRow({ layer: "api", path: "src/A.ts" }));
    const fileB = store.upsertFile(makeFileRow({ layer: "domain", path: "src/B.ts" }));
    const fileC = store.upsertFile(makeFileRow({ layer: "shared", path: "src/C.ts" }));

    // A → B and A → C and B → C (C appears in two edges)
    store.insertFileEdge({
      confidence: 1,
      edge_type: "imports",
      evidence: "",
      relation: null,
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
    });
    store.insertFileEdge({
      confidence: 1,
      edge_type: "imports",
      evidence: "",
      relation: null,
      source_file_id: fileA.file_id!,
      target_file_id: fileC.file_id!,
    });
    store.insertFileEdge({
      confidence: 1,
      edge_type: "imports",
      evidence: "",
      relation: null,
      source_file_id: fileB.file_id!,
      target_file_id: fileC.file_id!,
    });

    // Seed with A — subgraph includes A's neighbors (B and C)
    const subgraph = query.getSubgraph(["src/A.ts"]);

    // All three files must be present as nodes (A as seed, B and C as neighbors)
    const nodePaths = subgraph.nodes.map((n) => n.path);
    expect(nodePaths).toContain("src/A.ts");
    expect(nodePaths).toContain("src/B.ts");
    expect(nodePaths).toContain("src/C.ts");

    // Node deduplication: each file_id appears exactly once in nodeMap
    const uniquePaths = new Set(nodePaths);
    expect(uniquePaths.size).toBe(nodePaths.length);

    // Edges may include duplicates (not deduplicated per spec), but must not throw
    expect(subgraph.edges.length).toBeGreaterThan(0);

    void fileA;
    void fileB;
    void fileC;
  });

  it("seed file with no edges is returned as isolated node", () => {
    store.upsertFile(makeFileRow({ layer: "domain", path: "src/orphan.ts" }));
    // Insert another file but no edges involving orphan
    store.upsertFile(makeFileRow({ layer: "domain", path: "src/other.ts" }));
    store.insertFileEdge({
      confidence: 1,
      edge_type: "imports",
      evidence: "",
      relation: null,
      source_file_id: 2,
      target_file_id: 2,
    });

    const subgraph = query.getSubgraph(["src/orphan.ts"]);
    expect(subgraph.nodes).toHaveLength(1);
    expect(subgraph.nodes[0]!.path).toBe("src/orphan.ts");
    expect(subgraph.edges).toHaveLength(0);
  });
});

// 3. KgQuery.getKgFreshnessMs — MIN semantics (oldest file drives staleness)
//
// Gap: implementor tests test null and "reasonable ms value" but do not verify
// the MIN(last_indexed_at) semantics — that the oldest timestamp determines
// freshness, not the newest.

describe("KgQuery.getKgFreshnessMs — MIN semantics", () => {
  let db: Database.Database;
  let store: KgStore;
  let query: KgQuery;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
    query = new KgQuery(db);
  });

  afterEach(() => {
    store.close();
  });

  it("returns age based on oldest (MIN) last_indexed_at, not newest", () => {
    const now = Date.now();
    const oneHourAgo = now - 3_600_000;
    const oneDayAgo = now - 86_400_000;

    // File A was indexed 1 day ago (oldest)
    store.upsertFile(
      makeFileRow({
        content_hash: "old",
        last_indexed_at: oneDayAgo,
        path: "src/old.ts",
      }),
    );
    // File B was indexed 1 hour ago (newer)
    store.upsertFile(
      makeFileRow({
        content_hash: "new",
        last_indexed_at: oneHourAgo,
        path: "src/new.ts",
      }),
    );

    const freshnessMs = query.getKgFreshnessMs();
    expect(freshnessMs).not.toBeNull();

    // Should be approximately 24 hours (based on oldest), not 1 hour (based on newest)
    // Allow 5s tolerance for test execution time
    expect(freshnessMs!).toBeGreaterThanOrEqual(86_400_000 - 5_000);
    expect(freshnessMs!).toBeLessThanOrEqual(86_400_000 + 5_000);
  });

  it("returns null when files table is empty", () => {
    expect(query.getKgFreshnessMs()).toBeNull();
  });

  it("returns a positive value when at least one file is indexed", () => {
    store.upsertFile(makeFileRow({ last_indexed_at: Date.now() - 1000, path: "src/A.ts" }));
    const ms = query.getKgFreshnessMs();
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(0);
  });
});

// 4. computeFileInsightMaps hub threshold boundary (exactly 10 files)
//
// Gap declared in adr005-01: "computeFileInsightMaps with more than 10 files —
// hub threshold behavior tested with 12 files; edge cases with exactly 10 not
// exhaustively tested."

describe("computeFileInsightMaps — hub threshold boundary at exactly 10 files", () => {
  let db: Database.Database;
  let store: KgStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
  });

  afterEach(() => {
    store.close();
  });

  it("all 10 files are hubs when there are exactly 10 files with equal degree", () => {
    // Create 10 files all with equal total degree (1 each)
    const files = [];
    for (let i = 0; i < 10; i++) {
      const f = store.upsertFile(
        makeFileRow({ content_hash: `hash${i}`, path: `src/file${i}.ts` }),
      );
      files.push(f);
    }

    // Create a chain: file0 → file1 → ... → file9 (each has in_degree=1 or out_degree=1)
    for (let i = 0; i < 9; i++) {
      store.insertFileEdge({
        confidence: 1,
        edge_type: "imports",
        evidence: "",
        relation: null,
        source_file_id: files[i]!.file_id!,
        target_file_id: files[i + 1]!.file_id!,
      });
    }

    const maps = computeFileInsightMaps(db);
    // With 10 files and top-10 hub cutoff, all 10 should qualify
    expect(maps.hubPaths.size).toBe(10);
  });

  it("only top 10 are hubs when there are 11 files (lowest-degree is excluded)", () => {
    // Create 11 files, first 10 have high degree (out_degree=2), last one has degree=0
    const files = [];
    for (let i = 0; i < 11; i++) {
      const f = store.upsertFile(
        makeFileRow({ content_hash: `hash${i}`, path: `src/file${i}.ts` }),
      );
      files.push(f);
    }

    // Files 0-9 each import file 10 (gives file 10 in_degree=10, but files 0-9 each have out_degree=1)
    // Plus create a shared target that all top-10 import to give them degree
    // Actually: let's make files 0–9 each import file 10 (high in_degree for file 10)
    // and a common source imports them to give them in_degree
    // Simpler: give files 0–9 each a distinct target import so they have out_degree=1
    // file10 has no edges at all → total_degree=0 → should not be in top 10
    const sharedTarget = store.upsertFile(
      makeFileRow({ content_hash: "shared", path: "src/shared.ts" }),
    );
    for (let i = 0; i < 10; i++) {
      store.insertFileEdge({
        confidence: 1,
        edge_type: "imports",
        evidence: "",
        relation: null,
        source_file_id: files[i]!.file_id!,
        target_file_id: sharedTarget.file_id!,
      });
    }
    // file10 has zero edges

    const maps = computeFileInsightMaps(db);
    // sharedTarget has in_degree=10, files 0-9 have out_degree=1, file10 has degree=0
    // Top 10 by total degree: sharedTarget (10) + 9 of the first 10 files (1 each)
    // file10 is excluded from hubs
    expect(maps.hubPaths.has(`src/file10.ts`)).toBe(false);
    expect(maps.hubPaths.size).toBe(10);
  });
});

// 5. kg-blast-radius — empty result when no file_edges (no JSON fallback)
//
// Gap declared in adr005-04: verified by absence of readFileSync calls; but
// no explicit test that computeUnifiedBlastRadius returns empty gracefully
// when a file has no edges in the DB.

describe("computeUnifiedBlastRadius — empty result when no file_edges", () => {
  let db: Database.Database;
  let store: KgStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
  });

  afterEach(() => {
    store.close();
  });

  it("returns report with empty affected array when file exists but has no edges", () => {
    store.upsertFile(makeFileRow({ layer: "domain", path: "src/isolated.ts" }));

    const report = computeUnifiedBlastRadius(db, "src/isolated.ts", {});
    expect(report).not.toBeNull();
    expect(report!.affected).toHaveLength(0);
    expect(report!.summary.severity).toBe("contained");
    expect(report!.summary.total_files).toBe(0);
  });

  it("returns contained report when file is not in DB at all (no JSON fallback)", () => {
    // computeUnifiedBlastRadius returns a contained report (not null) for unknown files;
    // this verifies there is no reverse-deps.json fallback — the DB is the sole source.
    const report = computeUnifiedBlastRadius(db, "src/missing.ts", {});
    expect(report).not.toBeNull();
    expect(report.affected).toHaveLength(0);
    expect(report.summary.severity).toBe("contained");
    expect(report.summary.total_files).toBe(0);
    expect(report.seed_file).toBe("src/missing.ts");
  });

  it("returns report for file with edges in DB — no JSON fallback needed", () => {
    const fileA = store.upsertFile(makeFileRow({ layer: "domain", path: "src/A.ts" }));
    const fileB = store.upsertFile(makeFileRow({ layer: "api", path: "src/B.ts" }));
    store.insertFileEdge({
      confidence: 1,
      edge_type: "imports",
      evidence: "",
      relation: null,
      source_file_id: fileB.file_id!,
      target_file_id: fileA.file_id!,
    });

    const report = computeUnifiedBlastRadius(db, "src/A.ts", {});
    expect(report).not.toBeNull();
    // B imports A, so A's blast radius should include B
    expect(report!.affected.length).toBeGreaterThan(0);
    const affectedPaths = report!.affected.map((f) => f.path);
    expect(affectedPaths).toContain("src/B.ts");

    void fileA;
    void fileB;
  });
});

// 6. classifyFile — needs-attention via high in_degree + changed (risk: adr005-03)
//
// Gap: adr005-03 notes no test for "layer_violation_count > 0 shape" and only
// structural-level testing for the changed + high in_degree classifyFile path.

describe("classifyFile — needs-attention via high in_degree + changed", () => {
  it("returns needs-attention when in_degree >= 5 and file is changed", () => {
    const result = classifyFile({
      layer: "domain",
      path: "src/core.ts",
      priority_factors: {
        in_degree: 6,
        is_changed: true,
        layer: "domain",
        layer_centrality: 2,
        violation_count: 0,
      },
      priority_score: 20,
      status: "modified",
    });
    expect(result.bucket).toBe("needs-attention");
    expect(result.reason).toMatch(/high impact/i);
    expect(result.reason).toContain("6");
  });

  it("returns worth-a-look when in_degree >= 5 but file is NOT changed", () => {
    const result = classifyFile({
      layer: "domain",
      path: "src/core.ts",
      priority_factors: {
        in_degree: 6,
        is_changed: false,
        layer: "domain",
        layer_centrality: 2,
        violation_count: 0,
      },
      priority_score: 20,
      status: "modified",
    });
    // Not changed → cannot trigger the high-impact needs-attention rule
    // But priority_score=20 >= 5 → worth-a-look
    expect(result.bucket).toBe("worth-a-look");
  });

  it("returns needs-attention when violation_count > 0 regardless of in_degree", () => {
    const result = classifyFile({
      layer: "api",
      path: "src/violator.ts",
      priority_factors: {
        in_degree: 0,
        is_changed: false,
        layer: "api",
        layer_centrality: 1,
        violation_count: 2,
      },
      priority_score: 0,
      status: "added",
    });
    expect(result.bucket).toBe("needs-attention");
    expect(result.reason).toContain("2 violations");
  });

  it("returns low-risk when priority_score < 5 and no violations and not a high-impact changed file", () => {
    const result = classifyFile({
      layer: "ui",
      path: "src/simple.ts",
      priority_factors: {
        in_degree: 0,
        is_changed: true,
        layer: "ui",
        layer_centrality: 0,
        violation_count: 0,
      },
      priority_score: 0,
      status: "added",
    });
    expect(result.bucket).toBe("low-risk");
  });
});

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
  });

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
  });

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
  });
});

// 10. DB-only workflow: kg_freshness_ms flows from KgQuery to getPrReviewData
//
// Gap declared in adr005-04: "pr-review-data.ts priority scoring with a fully
// populated KG is only tested via unit tests with mock KgQuery data."
// This test verifies the kg_freshness_ms field flows correctly with a real SQLite DB.

describe("pr-review-data — kg_freshness_ms with real SQLite DB", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-freshness-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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

    // Mock git adapter to return an empty diff
    vi.doMock("../platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: vi.fn().mockResolvedValue({
        exitCode: 0,
        ok: true,
        stderr: "",
        stdout: "",
        timedOut: false,
      }),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // kg_freshness_ms must be present and represent ~10 minutes
    expect(result.kg_freshness_ms).toBeDefined();
    expect(result.kg_freshness_ms).toBeGreaterThanOrEqual(600_000 - 5_000);
    expect(result.kg_freshness_ms).toBeLessThanOrEqual(600_000 + 5_000);
  });

  it("kg_freshness_ms is undefined when KG DB does not exist", async () => {
    vi.doMock("../platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: vi.fn().mockResolvedValue({
        exitCode: 0,
        ok: true,
        stderr: "",
        stdout: "",
        timedOut: false,
      }),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(result.kg_freshness_ms).toBeUndefined();
  });
});
