import { describe, it, expect } from "vitest";
import { generateInsights } from "../graph/insights.js";

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
        { name: "api", file_count: 2 },
        { name: "domain", file_count: 1 },
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
      target: "infra/db.ts",
      source_layer: "api",
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
