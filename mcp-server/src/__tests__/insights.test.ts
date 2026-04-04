import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANON_DIR, CANON_FILES } from "../constants.ts";
import { generateInsights } from "../graph/insights.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";

describe("generateInsights", () => {
  it("returns zeroed insights for empty graph", () => {
    const result = generateInsights([], []);
    expect(result.overview.total_files).toBe(0);
    expect(result.overview.total_edges).toBe(0);
    expect(result.overview.avg_dependencies_per_file).toBe(0);
    expect(result.most_connected).toEqual([]);
    expect(result.orphan_files).toEqual([]);
    expect(result.circular_dependencies).toEqual([]);
    expect(result.layer_violations).toEqual([]);
  });

  it("computes overview correctly", () => {
    const nodes = [
      { id: "a.ts", layer: "api" },
      { id: "b.ts", layer: "api" },
      { id: "c.ts", layer: "domain" },
    ];
    const edges = [
      { source: "a.ts", target: "c.ts" },
      { source: "b.ts", target: "c.ts" },
    ];
    const result = generateInsights(nodes, edges);
    expect(result.overview.total_files).toBe(3);
    expect(result.overview.total_edges).toBe(2);
    expect(result.overview.avg_dependencies_per_file).toBeCloseTo(0.67, 1);
    expect(result.overview.layers).toEqual(
      expect.arrayContaining([
        { file_count: 2, name: "api" },
        { file_count: 1, name: "domain" },
      ]),
    );
  });

  it("ranks most connected files by total degree", () => {
    const nodes = [
      { id: "hub.ts", layer: "shared" },
      { id: "a.ts", layer: "api" },
      { id: "b.ts", layer: "api" },
      { id: "c.ts", layer: "domain" },
    ];
    const edges = [
      { source: "a.ts", target: "hub.ts" },
      { source: "b.ts", target: "hub.ts" },
      { source: "c.ts", target: "hub.ts" },
      { source: "hub.ts", target: "c.ts" },
    ];
    const result = generateInsights(nodes, edges);
    expect(result.most_connected[0].path).toBe("hub.ts");
    expect(result.most_connected[0].in_degree).toBe(3);
    expect(result.most_connected[0].out_degree).toBe(1);
    expect(result.most_connected[0].total).toBe(4);
  });

  it("detects orphan files", () => {
    const nodes = [
      { id: "connected.ts", layer: "api" },
      { id: "orphan.ts", layer: "shared" },
      { id: "other.ts", layer: "domain" },
    ];
    const edges = [{ source: "connected.ts", target: "other.ts" }];
    const result = generateInsights(nodes, edges);
    expect(result.orphan_files).toEqual(["orphan.ts"]);
  });

  it("does not mark colocated test files as orphans when source exists", () => {
    const nodes = [
      { id: "src/services/order.ts", layer: "domain" },
      { id: "src/services/order.test.ts", layer: "domain" },
    ];
    const result = generateInsights(nodes, []);
    expect(result.orphan_files).toEqual([]);
  });

  it("does not mark __tests__ files as orphans when source exists", () => {
    const nodes = [
      { id: "src/services/order.ts", layer: "domain" },
      { id: "src/services/__tests__/order.ts", layer: "domain" },
    ];
    const result = generateInsights(nodes, []);
    expect(result.orphan_files).toEqual([]);
  });

  it("detects circular dependencies", () => {
    const nodes = [
      { id: "a.ts", layer: "domain" },
      { id: "b.ts", layer: "domain" },
      { id: "c.ts", layer: "domain" },
    ];
    const edges = [
      { source: "a.ts", target: "b.ts" },
      { source: "b.ts", target: "c.ts" },
      { source: "c.ts", target: "a.ts" },
    ];
    const result = generateInsights(nodes, edges);
    expect(result.circular_dependencies.length).toBe(1);
    expect(result.circular_dependencies[0]).toHaveLength(3);
    expect(result.circular_dependencies[0]).toContain("a.ts");
    expect(result.circular_dependencies[0]).toContain("b.ts");
    expect(result.circular_dependencies[0]).toContain("c.ts");
  });

  it("detects simple 2-node cycle", () => {
    const nodes = [
      { id: "a.ts", layer: "domain" },
      { id: "b.ts", layer: "domain" },
    ];
    const edges = [
      { source: "a.ts", target: "b.ts" },
      { source: "b.ts", target: "a.ts" },
    ];
    const result = generateInsights(nodes, edges);
    expect(result.circular_dependencies.length).toBe(1);
    expect(result.circular_dependencies[0]).toHaveLength(2);
  });

  it("does not report cycles longer than 5", () => {
    // Create a 6-node cycle
    const nodes = Array.from({ length: 6 }, (_, i) => ({
      id: `n${i}.ts`,
      layer: "domain",
    }));
    const edges = nodes.map((n, i) => ({
      source: n.id,
      target: nodes[(i + 1) % 6].id,
    }));
    const result = generateInsights(nodes, edges);
    expect(result.circular_dependencies.length).toBe(0);
  });

  it("detects layer violations", () => {
    const nodes = [
      { id: "api/handler.ts", layer: "api" },
      { id: "infra/db.ts", layer: "infra" },
    ];
    const edges = [{ source: "api/handler.ts", target: "infra/db.ts" }];
    const result = generateInsights(nodes, edges);
    expect(result.layer_violations).toHaveLength(1);
    expect(result.layer_violations[0]).toEqual({
      source: "api/handler.ts",
      source_layer: "api",
      target: "infra/db.ts",
      target_layer: "infra",
    });
  });

  it("allows valid layer dependencies", () => {
    const nodes = [
      { id: "api/handler.ts", layer: "api" },
      { id: "domain/service.ts", layer: "domain" },
      { id: "shared/utils.ts", layer: "shared" },
    ];
    const edges = [
      { source: "api/handler.ts", target: "domain/service.ts" },
      { source: "api/handler.ts", target: "shared/utils.ts" },
    ];
    const result = generateInsights(nodes, edges);
    expect(result.layer_violations).toHaveLength(0);
  });

  it("skips unknown layers in violation checks", () => {
    const nodes = [
      { id: "misc.ts", layer: "unknown" },
      { id: "api/handler.ts", layer: "api" },
    ];
    const edges = [{ source: "misc.ts", target: "api/handler.ts" }];
    const result = generateInsights(nodes, edges);
    expect(result.layer_violations).toHaveLength(0);
  });

  it("accepts custom layer rules", () => {
    const nodes = [
      { id: "api.ts", layer: "api" },
      { id: "infra.ts", layer: "infra" },
    ];
    const edges = [{ source: "api.ts", target: "infra.ts" }];

    // With default rules, api -> infra is a violation
    const defaultResult = generateInsights(nodes, edges);
    expect(defaultResult.layer_violations).toHaveLength(1);

    // With custom rules allowing it
    const customResult = generateInsights(nodes, edges, { api: ["infra"] });
    expect(customResult.layer_violations).toHaveLength(0);
  });
});

// KG enrichment tests — use a real on-disk SQLite DB via a temp directory

describe("generateInsights — KG enrichment", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "insights-kg-test-"));
    // Create the .canon directory inside tmpDir so the function can find the DB
    const canonDir = join(tmpDir, CANON_DIR);
    mkdirSync(canonDir, { recursive: true });
    dbPath = join(canonDir, CANON_FILES.KNOWLEDGE_DB);
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
  });

  it("omits KG fields when DB does not exist", () => {
    // No DB created — enrichment should be skipped
    const result = generateInsights([], [], undefined, tmpDir);
    expect(result.entity_overview).toBeUndefined();
    expect(result.dead_code_summary).toBeUndefined();
    expect(result.blast_radius_hotspots).toBeUndefined();
  });

  it("does not break base insights when DB does not exist", () => {
    const nodes = [
      { id: "a.ts", layer: "api" },
      { id: "b.ts", layer: "domain" },
    ];
    const edges = [{ source: "a.ts", target: "b.ts" }];
    const result = generateInsights(nodes, edges, undefined, tmpDir);
    // Base fields unaffected
    expect(result.overview.total_files).toBe(2);
    expect(result.overview.total_edges).toBe(1);
    expect(result.layer_violations).toHaveLength(0);
  });

  it("enriches with entity_overview when DB exists and has entities", () => {
    // Seed the DB
    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    const fileRow = store.upsertFile({
      content_hash: "abc",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "domain",
      mtime_ms: Date.now(),
      path: "src/service.ts",
    });
    store.insertEntity({
      file_id: fileRow.file_id!,
      is_default_export: false,
      is_exported: true,
      kind: "function",
      line_end: 10,
      line_start: 1,
      metadata: null,
      name: "doWork",
      qualified_name: "src/service.ts::doWork",
      signature: null,
    });
    store.insertEntity({
      file_id: fileRow.file_id!,
      is_default_export: false,
      is_exported: true,
      kind: "class",
      line_end: 30,
      line_start: 12,
      metadata: null,
      name: "MyClass",
      qualified_name: "src/service.ts::MyClass",
      signature: null,
    });
    db.close();

    const result = generateInsights([], [], undefined, tmpDir);

    expect(result.entity_overview).toBeDefined();
    expect(result.entity_overview!.total_entities).toBe(2);
    expect(result.entity_overview!.by_kind.function).toBe(1);
    expect(result.entity_overview!.by_kind.class).toBe(1);
    expect(result.entity_overview!.total_edges).toBe(0);
  });

  it("enriches with dead_code_summary when DB has unexported unreferenced entities", () => {
    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    const fileRow = store.upsertFile({
      content_hash: "def",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "shared",
      mtime_ms: Date.now(),
      path: "src/utils.ts",
    });
    // Unexported + no incoming edges = dead code
    store.insertEntity({
      file_id: fileRow.file_id!,
      is_default_export: false,
      is_exported: false,
      kind: "function",
      line_end: 15,
      line_start: 5,
      metadata: null,
      name: "deadHelper",
      qualified_name: "src/utils.ts::deadHelper",
      signature: null,
    });
    db.close();

    const result = generateInsights([], [], undefined, tmpDir);

    expect(result.dead_code_summary).toBeDefined();
    expect(result.dead_code_summary!.total_dead).toBe(1);
    expect(result.dead_code_summary!.by_kind.function).toBe(1);
    expect(result.dead_code_summary!.top_files).toHaveLength(1);
    expect(result.dead_code_summary!.top_files[0].path).toBe("src/utils.ts");
    expect(result.dead_code_summary!.top_files[0].count).toBe(1);
  });

  it("returns empty dead_code_summary when no dead code exists", () => {
    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    const fileRow = store.upsertFile({
      content_hash: "ghi",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "api",
      mtime_ms: Date.now(),
      path: "src/index.ts",
    });
    // Exported entity — not dead
    store.insertEntity({
      file_id: fileRow.file_id!,
      is_default_export: false,
      is_exported: true,
      kind: "function",
      line_end: 5,
      line_start: 1,
      metadata: null,
      name: "main",
      qualified_name: "src/index.ts::main",
      signature: null,
    });
    db.close();

    const result = generateInsights([], [], undefined, tmpDir);

    expect(result.dead_code_summary).toBeDefined();
    expect(result.dead_code_summary!.total_dead).toBe(0);
    expect(result.dead_code_summary!.top_files).toHaveLength(0);
  });

  it("enriches with blast_radius_hotspots sorted by incoming edges", () => {
    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    const fileA = store.upsertFile({
      content_hash: "jkl",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "shared",
      mtime_ms: Date.now(),
      path: "src/hub.ts",
    });
    const fileB = store.upsertFile({
      content_hash: "mno",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "domain",
      mtime_ms: Date.now(),
      path: "src/callers.ts",
    });
    const hubEntity = store.insertEntity({
      file_id: fileA.file_id!,
      is_default_export: false,
      is_exported: true,
      kind: "function",
      line_end: 10,
      line_start: 1,
      metadata: null,
      name: "hubFunc",
      qualified_name: "src/hub.ts::hubFunc",
      signature: null,
    });
    const callerA = store.insertEntity({
      file_id: fileB.file_id!,
      is_default_export: false,
      is_exported: false,
      kind: "function",
      line_end: 5,
      line_start: 1,
      metadata: null,
      name: "callerA",
      qualified_name: "src/callers.ts::callerA",
      signature: null,
    });
    const callerB = store.insertEntity({
      file_id: fileB.file_id!,
      is_default_export: false,
      is_exported: false,
      kind: "function",
      line_end: 10,
      line_start: 6,
      metadata: null,
      name: "callerB",
      qualified_name: "src/callers.ts::callerB",
      signature: null,
    });
    // Both callers call hubFunc
    store.insertEdge({
      confidence: 1.0,
      edge_type: "calls",
      metadata: null,
      source_entity_id: callerA.entity_id!,
      target_entity_id: hubEntity.entity_id!,
    });
    store.insertEdge({
      confidence: 1.0,
      edge_type: "calls",
      metadata: null,
      source_entity_id: callerB.entity_id!,
      target_entity_id: hubEntity.entity_id!,
    });
    db.close();

    const result = generateInsights([], [], undefined, tmpDir);

    expect(result.blast_radius_hotspots).toBeDefined();
    expect(result.blast_radius_hotspots!.length).toBeGreaterThanOrEqual(1);
    const hotspot = result.blast_radius_hotspots![0];
    expect(hotspot.entity_name).toBe("hubFunc");
    expect(hotspot.affected_count).toBe(2);
  });

  it("preserves base insights when KG enrichment is present", () => {
    // Seed a minimal DB
    const db = initDatabase(dbPath);
    db.close();

    const nodes = [
      { id: "a.ts", layer: "api" },
      { id: "b.ts", layer: "domain" },
    ];
    const edges = [{ source: "a.ts", target: "b.ts" }];
    const result = generateInsights(nodes, edges, undefined, tmpDir);

    // Base fields must still be correct
    expect(result.overview.total_files).toBe(2);
    expect(result.overview.total_edges).toBe(1);
    expect(result.orphan_files).toEqual([]);
    expect(result.circular_dependencies).toEqual([]);
  });
});
