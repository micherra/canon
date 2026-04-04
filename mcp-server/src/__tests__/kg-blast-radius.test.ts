/**
 * Tests for the unified blast radius types, classifyBlastSeverity() pure function,
 * and computeUnifiedBlastRadius() orchestration function.
 *
 * These tests cover severity classification rules, description string generation,
 * the treatment of test files vs. production files, and the integration between
 * file-level and entity-level blast radius queries.
 */

import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BlastRadiusFile,
  classifyBlastSeverity,
  computeUnifiedBlastRadius,
} from "../graph/kg-blast-radius.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";
import type { EntityRow, FileRow } from "../graph/kg-types.ts";

// Shared DB helpers

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

function makeEntityRow(
  fileId: number,
  overrides: Partial<Omit<EntityRow, "entity_id" | "file_id">> = {},
): Omit<EntityRow, "entity_id"> {
  return {
    file_id: fileId,
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
  };
}

function makeFile(
  overrides: Partial<BlastRadiusFile> & Pick<BlastRadiusFile, "path">,
): BlastRadiusFile {
  return {
    depth: 1,
    in_degree: 1,
    is_test: false,
    layer: "domain",
    relationship: "imports",
    ...overrides,
  };
}

// classifyBlastSeverity — severity levels

describe("classifyBlastSeverity", () => {
  describe("contained", () => {
    it("returns contained when no files are affected", () => {
      const result = classifyBlastSeverity([], "domain");
      expect(result.severity).toBe("contained");
      expect(result.total_files).toBe(0);
      expect(result.total_production_files).toBe(0);
    });

    it("returns contained when all affected files are test files", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ is_test: true, layer: "domain", path: "src/__tests__/foo.test.ts" }),
        makeFile({ is_test: true, layer: "api", path: "src/test/bar.spec.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("contained");
      expect(result.total_files).toBe(2); // test files still counted in total_files
      expect(result.total_production_files).toBe(0);
    });

    it("returns the contained description string", () => {
      const result = classifyBlastSeverity([], "api");
      expect(result.description).toBe(
        "Changes are fully contained. No production files depend on this.",
      );
    });
  });

  describe("low", () => {
    it("returns low for 2 same-layer, low in_degree production files", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 2, layer: "domain", path: "src/a.ts" }),
        makeFile({ in_degree: 3, layer: "domain", path: "src/b.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("low");
      expect(result.total_production_files).toBe(2);
    });

    it("returns low for 1 same-layer file with in_degree exactly 5 (boundary)", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 5, layer: "domain", path: "src/a.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("low");
    });

    it("returns low description with correct count and layer name", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 1, layer: "api", path: "src/a.ts" }),
        makeFile({ in_degree: 2, layer: "api", path: "src/b.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "api");
      expect(result.description).toBe(
        "Low blast radius — 2 direct dependents, all within the api layer.",
      );
    });
  });

  describe("moderate", () => {
    it("returns moderate when there is 1 cross-layer production file", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 1, layer: "api", path: "src/api/handler.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("moderate");
      expect(result.cross_layer_count).toBe(1);
    });

    it("returns moderate for 4 same-layer production files", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 1, layer: "domain", path: "src/a.ts" }),
        makeFile({ in_degree: 1, layer: "domain", path: "src/b.ts" }),
        makeFile({ in_degree: 1, layer: "domain", path: "src/c.ts" }),
        makeFile({ in_degree: 1, layer: "domain", path: "src/d.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("moderate");
    });

    it("returns moderate for 8 same-layer production files (upper boundary)", () => {
      const affected: BlastRadiusFile[] = Array.from({ length: 8 }, (_, i) =>
        makeFile({ in_degree: 1, layer: "domain", path: `src/f${i}.ts` }),
      );
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("moderate");
    });

    it("returns moderate when a low-count file has in_degree > 5 (same layer)", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 6, layer: "domain", path: "src/hub.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("moderate");
    });

    it("returns moderate description with file count and cross-layer count", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 1, layer: "domain", path: "src/a.ts" }),
        makeFile({ in_degree: 1, layer: "domain", path: "src/b.ts" }),
        makeFile({ in_degree: 1, layer: "domain", path: "src/c.ts" }),
        makeFile({ in_degree: 1, layer: "api", path: "src/api/handler.ts" }),
        makeFile({ in_degree: 1, layer: "api", path: "src/api/router.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.description).toBe(
        "Moderate blast radius — 5 files affected, 2 across layer boundaries.",
      );
    });
  });

  describe("high", () => {
    it("returns high for 9 same-layer production files", () => {
      const affected: BlastRadiusFile[] = Array.from({ length: 9 }, (_, i) =>
        makeFile({ in_degree: 1, layer: "domain", path: `src/f${i}.ts` }),
      );
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("high");
    });

    it("returns high for 10+ same-layer production files", () => {
      const affected: BlastRadiusFile[] = Array.from({ length: 10 }, (_, i) =>
        makeFile({ in_degree: 1, layer: "domain", path: `src/f${i}.ts` }),
      );
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("high");
      expect(result.total_production_files).toBe(10);
    });

    it("returns high description referencing the hub file and in_degree", () => {
      const affected: BlastRadiusFile[] = Array.from({ length: 9 }, (_, i) =>
        makeFile({ in_degree: 1, layer: "domain", path: `src/f${i}.ts` }),
      );
      // inject a hub file
      affected.push(makeFile({ in_degree: 11, layer: "domain", path: "src/core/hub.ts" }));
      const result = classifyBlastSeverity(affected, "domain");
      // 10 prod files >= 9 AND has hub — critical check fails (no cross-layer), so high
      expect(result.severity).toBe("high");
      expect(result.description).toContain("hub");
    });
  });

  describe("critical", () => {
    it("returns critical when hub file (in_degree > 10) is cross-layer", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 15, layer: "api", path: "src/api/mega-hub.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("critical");
      expect(result.amplification_risk).toBe(true);
    });

    it("includes layer count in critical description", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 15, layer: "api", path: "src/api/mega-hub.ts" }),
        makeFile({ in_degree: 2, layer: "infra", path: "src/infra/db.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("critical");
      expect(result.description).toMatch(/critical blast radius/i);
      expect(result.description).toContain("mega-hub.ts");
    });

    it("does NOT classify as critical when hub is in same layer as seed", () => {
      // hub exists but no cross-layer → high, not critical
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 12, layer: "domain", path: "src/domain/hub.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.severity).toBe("high");
    });
  });

  // Test file handling

  describe("test file exclusion", () => {
    it("excludes test files from severity but counts them in total_files", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 1, is_test: false, layer: "domain", path: "src/a.ts" }),
        makeFile({
          in_degree: 0,
          is_test: true,
          layer: "domain",
          path: "src/__tests__/a.test.ts",
        }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.total_files).toBe(2);
      expect(result.total_production_files).toBe(1);
      // 1 prod file, same layer → low
      expect(result.severity).toBe("low");
    });

    it("counts test files in cross_layer only via production filtering", () => {
      // test file is in a different layer — should NOT affect cross_layer_count
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 1, is_test: false, layer: "domain", path: "src/a.ts" }),
        makeFile({
          in_degree: 0,
          is_test: true,
          layer: "api",
          path: "src/__tests__/api.test.ts",
        }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      // cross_layer_count filters prod files only
      expect(result.cross_layer_count).toBe(0);
      expect(result.severity).toBe("low");
    });
  });

  // Computed metadata fields

  describe("computed metadata", () => {
    it("reports max_depth_reached correctly", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ depth: 1, in_degree: 1, layer: "domain", path: "src/a.ts" }),
        makeFile({ depth: 3, in_degree: 1, layer: "domain", path: "src/b.ts" }),
        makeFile({ depth: 2, in_degree: 1, layer: "domain", path: "src/c.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.max_depth_reached).toBe(3);
    });

    it("reports max_depth_reached as 0 for empty input", () => {
      const result = classifyBlastSeverity([], "domain");
      expect(result.max_depth_reached).toBe(0);
    });

    it("sets amplification_risk true when any file has in_degree > 10", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 11, layer: "domain", path: "src/hub.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.amplification_risk).toBe(true);
    });

    it("sets amplification_risk false when no file exceeds in_degree 10", () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ in_degree: 10, layer: "domain", path: "src/a.ts" }),
      ];
      const result = classifyBlastSeverity(affected, "domain");
      expect(result.amplification_risk).toBe(false);
    });
  });
});

// computeUnifiedBlastRadius — integration tests

describe("computeUnifiedBlastRadius", () => {
  let db: Database.Database;
  let store: KgStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
  });

  afterEach(() => {
    store.close();
  });

  it("returns contained report when file is not in the KG", () => {
    const result = computeUnifiedBlastRadius(db, "src/nonexistent.ts");
    expect(result.seed_file).toBe("src/nonexistent.ts");
    expect(result.summary.severity).toBe("contained");
    expect(result.affected).toHaveLength(0);
    expect(result.by_depth).toEqual({});
  });

  it("returns contained report when file has no dependents", () => {
    // Seed file exists but no file_edges point to it and no entities call it
    store.upsertFile(makeFileRow({ layer: "domain", path: "src/seed.ts" }));

    const result = computeUnifiedBlastRadius(db, "src/seed.ts");
    expect(result.summary.severity).toBe("contained");
    expect(result.affected).toHaveLength(0);
    expect(result.seed_layer).toBe("domain");
  });

  it("returns file-level blast radius for a non-code file (file_edges only)", () => {
    // Seed: a config file with no entities. Two files import it via file_edges.
    const seedFile = store.upsertFile(
      makeFileRow({ language: "json", layer: "config", path: "config/tsconfig.json" }),
    );
    const fileA = store.upsertFile(
      makeFileRow({ language: "typescript", layer: "api", path: "src/a.ts" }),
    );
    const fileB = store.upsertFile(
      makeFileRow({ language: "typescript", layer: "domain", path: "src/b.ts" }),
    );

    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: fileA.file_id!,
      target_file_id: seedFile.file_id!,
    });
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: fileB.file_id!,
      target_file_id: seedFile.file_id!,
    });

    const result = computeUnifiedBlastRadius(db, "config/tsconfig.json");

    expect(result.affected).toHaveLength(2);
    const affectedPaths = result.affected.map((f) => f.path).sort();
    expect(affectedPaths).toEqual(["src/a.ts", "src/b.ts"]);
    // Both are at depth 1
    expect(result.affected.every((f) => f.depth === 1)).toBe(true);
    // by_depth should have depth 1 with 2 files
    expect(result.by_depth[1]).toHaveLength(2);
  });

  it("returns entity-level blast radius for a code file with exported entities", () => {
    // Seed file has an exported function. Another file's entity calls it.
    const seedFile = store.upsertFile(makeFileRow({ layer: "domain", path: "src/seed.ts" }));
    const callerFile = store.upsertFile(makeFileRow({ layer: "api", path: "src/caller.ts" }));

    const exportedFn = store.insertEntity(
      makeEntityRow(seedFile.file_id!, {
        is_exported: true,
        name: "exportedFn",
        qualified_name: "src/seed.ts::exportedFn",
      }),
    );
    const callerFn = store.insertEntity(
      makeEntityRow(callerFile.file_id!, {
        name: "callerFn",
        qualified_name: "src/caller.ts::callerFn",
      }),
    );

    // callerFn calls exportedFn
    store.insertEdge({
      confidence: 1.0,
      edge_type: "calls",
      metadata: null,
      source_entity_id: callerFn.entity_id!,
      target_entity_id: exportedFn.entity_id!,
    });

    const result = computeUnifiedBlastRadius(db, "src/seed.ts");

    expect(result.affected).toHaveLength(1);
    expect(result.affected[0].path).toBe("src/caller.ts");
    expect(result.affected[0].depth).toBe(1);
    expect(result.affected[0].affected_entities).toContain("callerFn");
  });

  it("merges file-level and entity-level results — entity adds affected_entities to existing file entry", () => {
    // Both file_edges and entity edges point from callerFile to seedFile.
    // The result should have a single entry for callerFile with affected_entities populated.
    const seedFile = store.upsertFile(makeFileRow({ layer: "domain", path: "src/seed.ts" }));
    const callerFile = store.upsertFile(makeFileRow({ layer: "api", path: "src/caller.ts" }));

    // File edge: callerFile imports seedFile
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: callerFile.file_id!,
      target_file_id: seedFile.file_id!,
    });

    // Entity edge: callerFn calls exportedFn in seed
    const exportedFn = store.insertEntity(
      makeEntityRow(seedFile.file_id!, {
        is_exported: true,
        name: "exportedFn",
        qualified_name: "src/seed.ts::exportedFn",
      }),
    );
    const callerFn = store.insertEntity(
      makeEntityRow(callerFile.file_id!, {
        name: "callerFn",
        qualified_name: "src/caller.ts::callerFn",
      }),
    );
    store.insertEdge({
      confidence: 1.0,
      edge_type: "calls",
      metadata: null,
      source_entity_id: callerFn.entity_id!,
      target_entity_id: exportedFn.entity_id!,
    });

    const result = computeUnifiedBlastRadius(db, "src/seed.ts");

    // Should be a single file entry (not duplicated)
    expect(result.affected).toHaveLength(1);
    expect(result.affected[0].path).toBe("src/caller.ts");
    // Entity detail should be merged in
    expect(result.affected[0].affected_entities).toContain("callerFn");
  });

  it("entity-level results add new file entries not found via file_edges", () => {
    // No file_edges exist, but entity-level edges reveal a caller in a different file
    const seedFile = store.upsertFile(makeFileRow({ layer: "domain", path: "src/seed.ts" }));
    const callerFile = store.upsertFile(makeFileRow({ layer: "api", path: "src/indirect.ts" }));

    const exportedFn = store.insertEntity(
      makeEntityRow(seedFile.file_id!, {
        is_exported: true,
        name: "myExport",
        qualified_name: "src/seed.ts::myExport",
      }),
    );
    const callerFn = store.insertEntity(
      makeEntityRow(callerFile.file_id!, {
        name: "indirectUser",
        qualified_name: "src/indirect.ts::indirectUser",
      }),
    );
    store.insertEdge({
      confidence: 1.0,
      edge_type: "calls",
      metadata: null,
      source_entity_id: callerFn.entity_id!,
      target_entity_id: exportedFn.entity_id!,
    });

    const result = computeUnifiedBlastRadius(db, "src/seed.ts");

    expect(result.affected).toHaveLength(1);
    expect(result.affected[0].path).toBe("src/indirect.ts");
    expect(result.affected[0].relationship).toBe("entity-dependency");
    expect(result.affected[0].affected_entities).toContain("indirectUser");
  });

  it("respects maxDepth option", () => {
    // A imports B, B imports seed. maxDepth=1 → only B should appear.
    const seedFile = store.upsertFile(makeFileRow({ layer: "domain", path: "src/seed.ts" }));
    const fileB = store.upsertFile(makeFileRow({ layer: "domain", path: "src/b.ts" }));
    const fileA = store.upsertFile(makeFileRow({ layer: "api", path: "src/a.ts" }));

    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: fileB.file_id!,
      target_file_id: seedFile.file_id!,
    });
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
    });

    const result = computeUnifiedBlastRadius(db, "src/seed.ts", { maxDepth: 1 });

    const affectedPaths = result.affected.map((f) => f.path);
    expect(affectedPaths).toContain("src/b.ts"); // depth 1
    expect(affectedPaths).not.toContain("src/a.ts"); // depth 2, excluded
  });

  it("handles circular file references without infinite recursion", () => {
    // Circular: A imports B, B imports A. Seed = A. Should terminate.
    const fileA = store.upsertFile(makeFileRow({ layer: "domain", path: "src/a.ts" }));
    const fileB = store.upsertFile(makeFileRow({ layer: "domain", path: "src/b.ts" }));

    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
    });
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: fileB.file_id!,
      target_file_id: fileA.file_id!,
    });

    // Should not hang or throw; DISTINCT in the CTE handles cycles
    expect(() => computeUnifiedBlastRadius(db, "src/a.ts")).not.toThrow();
    const result = computeUnifiedBlastRadius(db, "src/a.ts");
    // fileB references fileA, so fileB should appear in blast radius
    const affectedPaths = result.affected.map((f) => f.path);
    expect(affectedPaths).toContain("src/b.ts");
  });

  it("marks test files as is_test=true via isTestFile()", () => {
    const seedFile = store.upsertFile(makeFileRow({ layer: "domain", path: "src/utils.ts" }));
    const testFile = store.upsertFile(
      makeFileRow({ layer: "domain", path: "src/__tests__/utils.test.ts" }),
    );

    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: testFile.file_id!,
      target_file_id: seedFile.file_id!,
    });

    const result = computeUnifiedBlastRadius(db, "src/utils.ts");

    expect(result.affected).toHaveLength(1);
    expect(result.affected[0].is_test).toBe(true);
    // All affected are test files → severity is contained
    expect(result.summary.severity).toBe("contained");
  });

  it("populates in_degree from file_edges for each affected file", () => {
    // Set up callerFile as a hub: 3 other files also import it (in_degree = 3 for callerFile)
    const seedFile = store.upsertFile(makeFileRow({ layer: "domain", path: "src/seed.ts" }));
    const callerFile = store.upsertFile(makeFileRow({ layer: "domain", path: "src/hub.ts" }));
    const otherA = store.upsertFile(makeFileRow({ layer: "api", path: "src/other-a.ts" }));
    const otherB = store.upsertFile(makeFileRow({ layer: "api", path: "src/other-b.ts" }));
    const otherC = store.upsertFile(makeFileRow({ layer: "api", path: "src/other-c.ts" }));

    // callerFile imports seed (so hub is in blast radius of seed)
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: callerFile.file_id!,
      target_file_id: seedFile.file_id!,
    });
    // 3 other files import callerFile (raises callerFile's in_degree to 3)
    for (const other of [otherA, otherB, otherC]) {
      store.insertFileEdge({
        confidence: 1.0,
        edge_type: "imports",
        evidence: null,
        relation: null,
        source_file_id: other.file_id!,
        target_file_id: callerFile.file_id!,
      });
    }

    const result = computeUnifiedBlastRadius(db, "src/seed.ts", { maxDepth: 1 });

    expect(result.affected).toHaveLength(1);
    expect(result.affected[0].path).toBe("src/hub.ts");
    expect(result.affected[0].in_degree).toBe(3);
  });

  it("returns correct seed_layer in the report", () => {
    store.upsertFile(makeFileRow({ layer: "api", path: "src/tool.ts" }));
    const result = computeUnifiedBlastRadius(db, "src/tool.ts");
    expect(result.seed_layer).toBe("api");
  });

  describe("no-edges returns empty (no reverse-deps fallback)", () => {
    it("returns contained report when markdown file has no file_edges (no fallback)", () => {
      // Seed: a markdown file with no KG edges. Without the reverse-deps fallback,
      // the result should be contained (no affected files).
      store.upsertFile(
        makeFileRow({ language: "markdown", layer: "templates", path: "templates/my-template.md" }),
      );
      // Other files exist but no edges to the seed
      store.upsertFile(
        makeFileRow({ language: "markdown", layer: "flows", path: "flows/flow-a.md" }),
      );

      const result = computeUnifiedBlastRadius(db, "templates/my-template.md");

      expect(result.affected).toHaveLength(0);
      expect(result.summary.severity).toBe("contained");
    });

    it("returns contained report when a code file is in KG but has no dependents", () => {
      // A file in the KG with no file_edges pointing to it should have contained blast radius
      store.upsertFile(
        makeFileRow({ language: "typescript", layer: "domain", path: "src/leaf.ts" }),
      );

      const result = computeUnifiedBlastRadius(db, "src/leaf.ts");

      expect(result.affected).toHaveLength(0);
      expect(result.summary.severity).toBe("contained");
    });

    it("returns file-level blast radius when file_edges exist (not relying on any fallback)", () => {
      // Verify the primary path still works: file with KG file_edges returns affected files
      const seedFile = store.upsertFile(
        makeFileRow({ language: "typescript", layer: "domain", path: "src/core.ts" }),
      );
      const depFile = store.upsertFile(
        makeFileRow({ language: "typescript", layer: "api", path: "src/consumer.ts" }),
      );
      store.insertFileEdge({
        confidence: 1.0,
        edge_type: "imports",
        evidence: null,
        relation: null,
        source_file_id: depFile.file_id!,
        target_file_id: seedFile.file_id!,
      });

      const result = computeUnifiedBlastRadius(db, "src/core.ts");

      expect(result.affected).toHaveLength(1);
      expect(result.affected[0].path).toBe("src/consumer.ts");
      expect(result.summary.severity).not.toBe("contained");
    });
  });
});
