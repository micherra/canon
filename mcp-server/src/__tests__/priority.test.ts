import { describe, it, expect } from "vitest";
import { computeFilePriorities } from "../graph/priority.js";

function makeNode(id: string, overrides: Record<string, any> = {}) {
  return { id, layer: "domain", violation_count: 0, changed: true, ...overrides };
}

describe("computeFilePriorities", () => {
  it("returns empty array for empty inputs", () => {
    expect(computeFilePriorities([], [])).toEqual([]);
  });

  it("scores a single changed node with no edges", () => {
    const result = computeFilePriorities([makeNode("a.ts")], []);
    expect(result).toHaveLength(1);
    // score = 0*3 + 0*2 + 1 + 2(domain) = 3
    expect(result[0].priority_score).toBe(3);
    expect(result[0].factors.in_degree).toBe(0);
    expect(result[0].factors.layer_centrality).toBe(2);
  });

  it("applies in_degree weight of 3", () => {
    const nodes = [makeNode("a.ts"), makeNode("b.ts")];
    const edges = [{ source: "a.ts", target: "b.ts" }];
    const result = computeFilePriorities(nodes, edges);
    const b = result.find((r) => r.path === "b.ts")!;
    expect(b.factors.in_degree).toBe(1);
    // b: 1*3 + 0 + 1 + 2 = 6
    expect(b.priority_score).toBe(6);
  });

  it("applies violation_count weight of 2", () => {
    const result = computeFilePriorities([makeNode("a.ts", { violation_count: 5 })], []);
    // 0 + 5*2 + 1 + 2 = 13
    expect(result[0].priority_score).toBe(13);
  });

  it("adds 1 for changed flag", () => {
    const nodes = [
      makeNode("a.ts", { changed: true }),
      makeNode("b.ts", { changed: false }),
    ];
    const result = computeFilePriorities(nodes, [], false);
    const a = result.find((r) => r.path === "a.ts")!;
    const b = result.find((r) => r.path === "b.ts")!;
    expect(a.priority_score - b.priority_score).toBe(1);
  });

  it("applies correct layer centrality for each layer", () => {
    const expected: Record<string, number> = {
      shared: 3, domain: 2, data: 1.5, api: 1, infra: 1, ui: 0.5, unknown: 0,
    };
    for (const [layer, centrality] of Object.entries(expected)) {
      const result = computeFilePriorities([makeNode(`${layer}.ts`, { layer })], []);
      // score = 0 + 0 + 1 + centrality
      expect(result[0].priority_score).toBe(1 + centrality);
      expect(result[0].factors.layer_centrality).toBe(centrality);
    }
  });

  it("returns results sorted by priority_score descending", () => {
    const nodes = [
      makeNode("low.ts", { layer: "ui" }),         // 0 + 0 + 1 + 0.5 = 1.5
      makeNode("high.ts", { layer: "shared" }),     // 0 + 0 + 1 + 3 = 4
      makeNode("mid.ts", { layer: "domain" }),      // 0 + 0 + 1 + 2 = 3
    ];
    const result = computeFilePriorities(nodes, []);
    expect(result.map((r) => r.path)).toEqual(["high.ts", "mid.ts", "low.ts"]);
  });

  it("filters to changed nodes by default", () => {
    const nodes = [makeNode("a.ts"), makeNode("b.ts", { changed: false })];
    const result = computeFilePriorities(nodes, []);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("a.ts");
  });

  it("includes all nodes when filterToChanged is false", () => {
    const nodes = [makeNode("a.ts"), makeNode("b.ts", { changed: false })];
    const result = computeFilePriorities(nodes, [], false);
    expect(result).toHaveLength(2);
  });

  it("computes composite score correctly", () => {
    const nodes = [makeNode("a.ts", { layer: "shared", violation_count: 3 })];
    const edges = [
      { source: "x.ts", target: "a.ts" },
      { source: "y.ts", target: "a.ts" },
    ];
    const result = computeFilePriorities(nodes, edges);
    // 2*3 + 3*2 + 1 + 3 = 16
    expect(result[0].priority_score).toBe(16);
  });

  it("handles unrecognized layer with centrality 0", () => {
    const result = computeFilePriorities([makeNode("a.ts", { layer: "custom" })], []);
    expect(result[0].factors.layer_centrality).toBe(0);
    // 0 + 0 + 1 + 0 = 1
    expect(result[0].priority_score).toBe(1);
  });
});
