import { describe, expect, it } from "vitest";
import type { PrFileInfo } from "../tools/pr-review-data.ts";
import { classifyFile } from "../tools/pr-review-data.ts";

// Helper to build a minimal PrFileInfo for classification tests
function makeFile(overrides: Partial<PrFileInfo> = {}): PrFileInfo {
  return {
    bucket: "low-risk",
    layer: "domain",
    path: "src/some/file.ts",
    reason: "",
    status: "modified",
    ...overrides,
  };
}

describe("classifyFile — needs-attention", () => {
  it("classifies file with violations as needs-attention", () => {
    const file = makeFile({
      priority_factors: {
        in_degree: 0,
        is_changed: true,
        layer: "domain",
        layer_centrality: 2,
        violation_count: 2,
      },
    });
    const result = classifyFile(file);
    expect(result.bucket).toBe("needs-attention");
  });

  it("reason for violations mentions violation count", () => {
    const file = makeFile({
      priority_factors: {
        in_degree: 0,
        is_changed: true,
        layer: "domain",
        layer_centrality: 2,
        violation_count: 2,
      },
    });
    const result = classifyFile(file);
    expect(result.reason).toContain("2");
    expect(result.reason).toMatch(/violation/i);
  });

  it("classifies file with high in_degree and changed as needs-attention", () => {
    const file = makeFile({
      priority_factors: {
        in_degree: 9,
        is_changed: true,
        layer: "domain",
        layer_centrality: 2,
        violation_count: 0,
      },
    });
    const result = classifyFile(file);
    expect(result.bucket).toBe("needs-attention");
  });

  it("reason for high in_degree mentions dependent file count", () => {
    const file = makeFile({
      priority_factors: {
        in_degree: 9,
        is_changed: true,
        layer: "domain",
        layer_centrality: 2,
        violation_count: 0,
      },
    });
    const result = classifyFile(file);
    expect(result.reason).toContain("9");
    expect(result.reason).toMatch(/depend/i);
  });

  it("high in_degree without is_changed does NOT trigger needs-attention", () => {
    const file = makeFile({
      priority_factors: {
        in_degree: 9,
        is_changed: false,
        layer: "domain",
        layer_centrality: 2,
        violation_count: 0,
      },
    });
    const result = classifyFile(file);
    expect(result.bucket).not.toBe("needs-attention");
  });

  it("in_degree exactly 5 with changed triggers needs-attention", () => {
    const file = makeFile({
      priority_factors: {
        in_degree: 5,
        is_changed: true,
        layer: "domain",
        layer_centrality: 2,
        violation_count: 0,
      },
    });
    const result = classifyFile(file);
    expect(result.bucket).toBe("needs-attention");
  });

  it("in_degree 4 with changed does NOT trigger needs-attention from in_degree rule", () => {
    const file = makeFile({
      priority_factors: {
        in_degree: 4,
        is_changed: true,
        layer: "domain",
        layer_centrality: 2,
        violation_count: 0,
      },
      priority_score: 3,
    });
    const result = classifyFile(file);
    expect(result.bucket).not.toBe("needs-attention");
  });
});

describe("classifyFile — worth-a-look", () => {
  it("classifies file with medium priority score as worth-a-look", () => {
    const file = makeFile({
      priority_factors: {
        in_degree: 1,
        is_changed: true,
        layer: "domain",
        layer_centrality: 2,
        violation_count: 0,
      },
      priority_score: 5,
    });
    const result = classifyFile(file);
    expect(result.bucket).toBe("worth-a-look");
  });

  it("reason for worth-a-look mentions layer", () => {
    const file = makeFile({
      layer: "api",
      priority_factors: {
        in_degree: 1,
        is_changed: true,
        layer: "api",
        layer_centrality: 1,
        violation_count: 0,
      },
      priority_score: 7,
    });
    const result = classifyFile(file);
    expect(result.bucket).toBe("worth-a-look");
    expect(result.reason).toMatch(/api/i);
  });

  it("reason is human-readable — no raw numeric scores", () => {
    const file = makeFile({
      priority_factors: {
        in_degree: 2,
        is_changed: true,
        layer: "domain",
        layer_centrality: 2,
        violation_count: 0,
      },
      priority_score: 8,
    });
    const result = classifyFile(file);
    // Should not contain score number like "8" or "score: 8"
    expect(result.reason).not.toMatch(/score/i);
  });

  it("priority_score exactly 5 triggers worth-a-look", () => {
    const file = makeFile({
      priority_factors: {
        in_degree: 1,
        is_changed: false,
        layer: "domain",
        layer_centrality: 2,
        violation_count: 0,
      },
      priority_score: 5,
    });
    const result = classifyFile(file);
    expect(result.bucket).toBe("worth-a-look");
  });
});

describe("classifyFile — low-risk", () => {
  it("classifies file with no factors as low-risk", () => {
    const file = makeFile();
    const result = classifyFile(file);
    expect(result.bucket).toBe("low-risk");
  });

  it("reason for low-risk mentions minimal dependencies", () => {
    const file = makeFile();
    const result = classifyFile(file);
    expect(result.reason).toMatch(/low.risk|minimal|depend/i);
  });

  it("file with priority_score below 5 and no violations is low-risk", () => {
    const file = makeFile({
      priority_factors: {
        in_degree: 0,
        is_changed: true,
        layer: "ui",
        layer_centrality: 0.5,
        violation_count: 0,
      },
      priority_score: 3,
    });
    const result = classifyFile(file);
    expect(result.bucket).toBe("low-risk");
  });
});

describe("classifyFile — reason strings are human-readable", () => {
  it("violation reason says 'violations' not numeric score", () => {
    const file = makeFile({
      priority_factors: {
        in_degree: 0,
        is_changed: true,
        layer: "domain",
        layer_centrality: 2,
        violation_count: 3,
      },
    });
    const { reason } = classifyFile(file);
    expect(reason).not.toMatch(/priority_score|layer_centrality/);
    expect(reason).toMatch(/3\s+violation/i);
  });

  it("high impact reason says 'files depend on' not raw score", () => {
    const file = makeFile({
      priority_factors: {
        in_degree: 7,
        is_changed: true,
        layer: "shared",
        layer_centrality: 3,
        violation_count: 0,
      },
    });
    const { reason } = classifyFile(file);
    expect(reason).not.toMatch(/priority_score/);
    expect(reason).toContain("7");
    expect(reason).toMatch(/files.*depend|depend.*files/i);
  });
});
