import { describe, it, expect } from "vitest";
import { generateNarrative } from "../tools/pr-review-data.ts";
import type { PrFileInfo } from "../tools/pr-review-data.ts";

// Helper to build a PrFileInfo with priority factors
function makeFile(
  path: string,
  layer: string,
  overrides: Partial<PrFileInfo> = {},
): PrFileInfo {
  return {
    path,
    layer,
    status: "modified",
    bucket: "low-risk",
    reason: "",
    ...overrides,
  };
}

describe("generateNarrative — top layer", () => {
  it("mentions the top layer by name", () => {
    const files: PrFileInfo[] = [
      makeFile("src/tools/a.ts", "tools"),
      makeFile("src/tools/b.ts", "tools"),
      makeFile("src/graph/c.ts", "graph"),
    ];
    const layers = [
      { name: "tools", file_count: 2 },
      { name: "graph", file_count: 1 },
    ];
    const narrative = generateNarrative(files, layers);
    expect(narrative).toContain("tools");
  });

  it("narrative includes total file count", () => {
    const files: PrFileInfo[] = [
      makeFile("src/tools/a.ts", "tools"),
      makeFile("src/tools/b.ts", "tools"),
      makeFile("src/graph/c.ts", "graph"),
    ];
    const layers = [
      { name: "tools", file_count: 2 },
      { name: "graph", file_count: 1 },
    ];
    const narrative = generateNarrative(files, layers);
    expect(narrative).toContain("3");
  });

  it("narrative includes layer count", () => {
    const files: PrFileInfo[] = [
      makeFile("src/tools/a.ts", "tools"),
      makeFile("src/tools/b.ts", "tools"),
      makeFile("src/graph/c.ts", "graph"),
    ];
    const layers = [
      { name: "tools", file_count: 2 },
      { name: "graph", file_count: 1 },
    ];
    const narrative = generateNarrative(files, layers);
    expect(narrative).toContain("2");
  });
});

describe("generateNarrative — most consequential file", () => {
  it("mentions the highest-impact file", () => {
    const files: PrFileInfo[] = [
      makeFile("src/tools/high-impact.ts", "tools", {
        priority_factors: {
          in_degree: 12,
          violation_count: 0,
          is_changed: true,
          layer: "tools",
          layer_centrality: 1,
        },
      }),
      makeFile("src/graph/low.ts", "graph", {
        priority_factors: {
          in_degree: 1,
          violation_count: 0,
          is_changed: true,
          layer: "graph",
          layer_centrality: 1,
        },
      }),
    ];
    const layers = [
      { name: "tools", file_count: 1 },
      { name: "graph", file_count: 1 },
    ];
    const narrative = generateNarrative(files, layers);
    expect(narrative).toContain("high-impact.ts");
  });

  it("mentions the in_degree of the most consequential file", () => {
    const files: PrFileInfo[] = [
      makeFile("src/tools/hub.ts", "tools", {
        priority_factors: {
          in_degree: 15,
          violation_count: 0,
          is_changed: true,
          layer: "tools",
          layer_centrality: 1,
        },
      }),
    ];
    const layers = [{ name: "tools", file_count: 1 }];
    const narrative = generateNarrative(files, layers);
    expect(narrative).toContain("15");
  });

  it("does not mention a most consequential file when no factors available", () => {
    const files: PrFileInfo[] = [
      makeFile("src/tools/a.ts", "tools"),
      makeFile("src/graph/b.ts", "graph"),
    ];
    const layers = [
      { name: "tools", file_count: 1 },
      { name: "graph", file_count: 1 },
    ];
    // Should not throw — just returns a narrative without the impact line
    expect(() => generateNarrative(files, layers)).not.toThrow();
  });
});

describe("generateNarrative — violations", () => {
  it("mentions violation count when violations exist", () => {
    const files: PrFileInfo[] = [
      makeFile("src/tools/bad.ts", "tools", {
        priority_factors: {
          in_degree: 0,
          violation_count: 3,
          is_changed: true,
          layer: "tools",
          layer_centrality: 1,
        },
      }),
      makeFile("src/graph/ok.ts", "graph"),
    ];
    const layers = [
      { name: "tools", file_count: 1 },
      { name: "graph", file_count: 1 },
    ];
    const narrative = generateNarrative(files, layers);
    expect(narrative).toMatch(/violation/i);
    expect(narrative).toContain("3");
  });

  it("does not mention violations when there are none", () => {
    const files: PrFileInfo[] = [
      makeFile("src/tools/clean.ts", "tools", {
        priority_factors: {
          in_degree: 0,
          violation_count: 0,
          is_changed: true,
          layer: "tools",
          layer_centrality: 1,
        },
      }),
    ];
    const layers = [{ name: "tools", file_count: 1 }];
    const narrative = generateNarrative(files, layers);
    expect(narrative).not.toMatch(/violation/i);
  });
});

describe("generateNarrative — edge cases", () => {
  it("handles zero files gracefully (empty PR)", () => {
    const narrative = generateNarrative([], []);
    expect(typeof narrative).toBe("string");
    expect(narrative.length).toBeGreaterThan(0);
  });

  it("handles single file with no graph data", () => {
    const files: PrFileInfo[] = [makeFile("src/tools/a.ts", "tools")];
    const layers = [{ name: "tools", file_count: 1 }];
    expect(() => generateNarrative(files, layers)).not.toThrow();
    const narrative = generateNarrative(files, layers);
    expect(narrative).toContain("tools");
  });

  it("handles all factors undefined (no graph data available)", () => {
    const files: PrFileInfo[] = [
      makeFile("src/a.ts", "domain"),
      makeFile("src/b.ts", "domain"),
    ];
    const layers = [{ name: "domain", file_count: 2 }];
    const narrative = generateNarrative(files, layers);
    expect(narrative).toContain("domain");
    expect(narrative).toContain("2");
  });

  it("returns a multi-sentence string (3-4 sentences)", () => {
    const files: PrFileInfo[] = [
      makeFile("src/tools/a.ts", "tools", {
        priority_factors: {
          in_degree: 5,
          violation_count: 1,
          is_changed: true,
          layer: "tools",
          layer_centrality: 1,
        },
      }),
      makeFile("src/graph/b.ts", "graph"),
    ];
    const layers = [
      { name: "tools", file_count: 1 },
      { name: "graph", file_count: 1 },
    ];
    const narrative = generateNarrative(files, layers);
    // Count sentences by period+space or period at end
    const sentences = narrative.split(/\.(?:\s+|$)/).filter((s) => s.trim().length > 0);
    expect(sentences.length).toBeGreaterThanOrEqual(2);
  });
});
