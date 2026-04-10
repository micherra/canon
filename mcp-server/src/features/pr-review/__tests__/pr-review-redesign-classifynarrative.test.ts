/**
 * pr-review-redesign-classifynarrative.test.ts
 *
 * Split from pr-review-redesign-integration.test.ts (was 695 lines).
 * Contains pure function tests for classifyFile() and generateNarrative():
 *   4. classifyFile() — coverage gap: violations + high in_degree both present
 *   5. generateNarrative() — singular/plural wording (coverage gaps)
 *
 * These tests are synchronous with no mocking or tmpDir setup.
 */

import { describe, expect, it } from "vitest";
import type { PrFileInfo } from "../tools/pr-review-data.ts";
import { classifyFile, generateNarrative } from "../tools/pr-review-data-helpers.ts";

function makeFile(path: string, layer: string, overrides: Partial<PrFileInfo> = {}): PrFileInfo {
  return {
    bucket: "low-risk",
    layer,
    path,
    reason: "",
    status: "modified",
    ...overrides,
  };
}

// 4. classifyFile() — coverage gap: both violations AND high in_degree

describe("classifyFile() — coverage gap: violations + high in_degree both present", () => {
  it("violation check takes precedence over high in_degree (violations win)", () => {
    // File has both violation_count > 0 AND in_degree >= 5 AND is_changed
    // Per code order, violation check fires first.
    const file = makeFile("src/a.ts", "tools", {
      priority_factors: {
        in_degree: 10,
        is_changed: true,
        layer: "tools",
        layer_centrality: 3,
        violation_count: 2,
      },
    });

    const result = classifyFile(file);
    expect(result.bucket).toBe("needs-attention");
    // Reason should mention violations, not the in_degree rule
    expect(result.reason).toMatch(/violation/i);
    expect(result.reason).toContain("2");
  });

  it("reason for 1 violation uses singular 'violation' (not 'violations')", () => {
    const file = makeFile("src/a.ts", "tools", {
      priority_factors: {
        in_degree: 0,
        is_changed: true,
        layer: "tools",
        layer_centrality: 1,
        violation_count: 1,
      },
    });

    const { reason } = classifyFile(file);
    // Exact singular form
    expect(reason).toContain("1 violation");
    expect(reason).not.toContain("violations");
  });

  it("reason for multiple violations uses plural 'violations'", () => {
    const file = makeFile("src/a.ts", "tools", {
      priority_factors: {
        in_degree: 0,
        is_changed: true,
        layer: "tools",
        layer_centrality: 1,
        violation_count: 5,
      },
    });

    const { reason } = classifyFile(file);
    expect(reason).toContain("5 violations");
  });

  it("classifyFile falls through to worth-a-look when in_degree < 5 (changed) and score >= 5", () => {
    // in_degree=4 (not needs-attention) + priority_score=6 (worth-a-look)
    const file = makeFile("src/a.ts", "tools", {
      priority_factors: {
        in_degree: 4,
        is_changed: true,
        layer: "tools",
        layer_centrality: 2,
        violation_count: 0,
      },
      priority_score: 6,
    });

    const result = classifyFile(file);
    expect(result.bucket).toBe("worth-a-look");
  });

  it("high in_degree with no priority_factors → low-risk (no factors means no classification triggers)", () => {
    // When priority_factors is undefined, the violation and in_degree checks both skip
    const file = makeFile("src/a.ts", "tools");
    // No priority_factors, no priority_score → low-risk
    const result = classifyFile(file);
    expect(result.bucket).toBe("low-risk");
  });
});

// 5. generateNarrative() — singular wording coverage gaps

describe("generateNarrative() — singular/plural wording (coverage gaps)", () => {
  it("uses 'file' (singular) when total_files is 1", () => {
    const files = [makeFile("src/tools/only.ts", "tools")];
    const layers = [{ file_count: 1, name: "tools" }];

    const narrative = generateNarrative(files, layers);
    // Should say "1 file" not "1 files"
    expect(narrative).toMatch(/\b1 file\b/);
    expect(narrative).not.toMatch(/\b1 files\b/);
  });

  it("uses 'layer' (singular) when there is exactly one layer", () => {
    const files = [makeFile("src/tools/a.ts", "tools"), makeFile("src/tools/b.ts", "tools")];
    const layers = [{ file_count: 2, name: "tools" }];

    const narrative = generateNarrative(files, layers);
    // Should say "1 layer" not "1 layers"
    expect(narrative).toMatch(/\b1 layer\b/);
    expect(narrative).not.toMatch(/\b1 layers\b/);
  });

  it("uses 'file depends' (singular) when only one file depends on the hub", () => {
    const files = [
      makeFile("src/tools/hub.ts", "tools", {
        priority_factors: {
          in_degree: 1,
          is_changed: true,
          layer: "tools",
          layer_centrality: 1,
          violation_count: 0,
        },
      }),
    ];
    const layers = [{ file_count: 1, name: "tools" }];

    const narrative = generateNarrative(files, layers);
    // in_degree=1 > 0 so the impact sentence fires
    // Should say "1 file depends" not "1 files depend"
    expect(narrative).toMatch(/\b1 file depends\b/);
    expect(narrative).not.toMatch(/files depend/);
  });

  it("uses 'files depend' (plural) when multiple files depend on the hub", () => {
    const files = [
      makeFile("src/tools/hub.ts", "tools", {
        priority_factors: {
          in_degree: 5,
          is_changed: true,
          layer: "tools",
          layer_centrality: 2,
          violation_count: 0,
        },
      }),
    ];
    const layers = [{ file_count: 1, name: "tools" }];

    const narrative = generateNarrative(files, layers);
    expect(narrative).toMatch(/5 files depend/);
  });

  it("uses 'violation' (singular) in narrative when total violations is 1", () => {
    const files = [
      makeFile("src/tools/bad.ts", "tools", {
        priority_factors: {
          in_degree: 0,
          is_changed: true,
          layer: "tools",
          layer_centrality: 1,
          violation_count: 1,
        },
      }),
    ];
    const layers = [{ file_count: 1, name: "tools" }];

    const narrative = generateNarrative(files, layers);
    // "There is 1 principle violation to address."
    expect(narrative).toMatch(/\bthere is\b/i);
    expect(narrative).toContain("1 principle violation");
  });

  it("uses 'violations' (plural) and 'are' in narrative when total violations > 1", () => {
    const files = [
      makeFile("src/tools/bad.ts", "tools", {
        priority_factors: {
          in_degree: 0,
          is_changed: true,
          layer: "tools",
          layer_centrality: 1,
          violation_count: 2,
        },
      }),
      makeFile("src/tools/also-bad.ts", "tools", {
        priority_factors: {
          in_degree: 0,
          is_changed: true,
          layer: "tools",
          layer_centrality: 1,
          violation_count: 1,
        },
      }),
    ];
    const layers = [{ file_count: 2, name: "tools" }];

    const narrative = generateNarrative(files, layers);
    // Total = 3 violations → "There are 3 principle violations"
    expect(narrative).toMatch(/\bthere are\b/i);
    expect(narrative).toContain("3 principle violations");
  });

  it("skips impact sentence when max in_degree is 0 (no dependents)", () => {
    const files = [
      makeFile("src/tools/leaf.ts", "tools", {
        priority_factors: {
          in_degree: 0,
          is_changed: true,
          layer: "tools",
          layer_centrality: 1,
          violation_count: 0,
        },
      }),
    ];
    const layers = [{ file_count: 1, name: "tools" }];

    const narrative = generateNarrative(files, layers);
    // max in_degree = 0 → condition `maxInDegree > 0` is false → no impact sentence
    expect(narrative).not.toMatch(/most consequential/i);
    expect(narrative).not.toMatch(/files? depend/i);
  });

  it("uses top layer with most files (not first layer in array)", () => {
    const files = [
      makeFile("src/tools/a.ts", "tools"),
      makeFile("src/graph/b.ts", "graph"),
      makeFile("src/graph/c.ts", "graph"),
      makeFile("src/graph/d.ts", "graph"),
    ];
    // graph has 3 files, tools has 1 — graph should be the top layer
    const layers = [
      { file_count: 1, name: "tools" },
      { file_count: 3, name: "graph" },
    ];

    const narrative = generateNarrative(files, layers);
    expect(narrative).toContain("graph");
    // The first sentence specifically names the top layer
    const firstSentence = narrative.split(".")[0];
    expect(firstSentence).toContain("graph");
  });
});
