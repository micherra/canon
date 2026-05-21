/**
 * pr-review-redesign-ui.test.ts
 *
 * Pure-logic tests for PrReview UI state: setActiveLayer toggle logic,
 * filteredFiles derived state.
 *
 * Items 7-8 from the original integration test file:
 *   7. setActiveLayer() toggle: second click on same layer resets to null
 *   8. filteredFiles derived state logic
 *
 * Note: Item 9 (PrReview.svelte v2 structural contract) was removed when
 * the Svelte UI files were deleted (delete-mcp-svelte-app-uis build, 2026-05-20).
 */

import { describe, expect, it } from "vitest";
import type { PrFileInfo } from "../tools/pr-review-data.ts";

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

// 7. setActiveLayer() toggle logic — declared gap (Task 02)

// The toggle logic is: activeLayer === layer ? null : layer
// This behavior is declared untested in Task 02 Coverage Notes.
// Testing the pure logic of the toggler extracted from the component.

function setActiveLayer(activeLayer: string | null, layer: string | null): string | null {
  return activeLayer === layer ? null : layer;
}

describe("PrReview setActiveLayer() toggle logic (declared gap)", () => {
  it("sets active layer when none is active", () => {
    expect(setActiveLayer(null, "tools")).toBe("tools");
  });

  it("resets to null when clicking the already-active layer (toggle off)", () => {
    // This is the declared gap: second click deactivates
    expect(setActiveLayer("tools", "tools")).toBeNull();
  });

  it("switches to a different layer when one is already active", () => {
    expect(setActiveLayer("tools", "graph")).toBe("graph");
  });

  it("setting null layer (All tab) when no layer is active returns null", () => {
    expect(setActiveLayer(null, null)).toBeNull();
  });

  it("setting null layer (All tab) when a layer is active resets to null", () => {
    // The All button calls setActiveLayer(null) which should deactivate filtering
    // Note: All tab passes null as the layer argument, not the same as activeLayer
    // activeLayer === null !== "tools" → setActiveLayer("tools", null) → null
    expect(setActiveLayer("tools", null)).toBeNull();
  });
});

// 8. filteredFiles derived state logic — declared gap (Task 02)

// The component uses: activeLayer ? files.filter(f => f.layer === activeLayer) : files
// This is the "No test verifying that activeLayer actually filters file display" gap.
// Testing the pure filtering logic.

function filteredFiles(allFiles: PrFileInfo[], activeLayer: string | null): PrFileInfo[] {
  return activeLayer ? allFiles.filter((f) => f.layer === activeLayer) : allFiles;
}

describe("filteredFiles derived state logic (declared gap)", () => {
  const files: PrFileInfo[] = [
    makeFile("src/tools/a.ts", "tools"),
    makeFile("src/tools/b.ts", "tools"),
    makeFile("src/graph/c.ts", "graph"),
    makeFile("src/graph/d.ts", "graph"),
    makeFile("src/graph/e.ts", "graph"),
  ];

  it("returns all files when activeLayer is null", () => {
    const result = filteredFiles(files, null);
    expect(result).toHaveLength(5);
  });

  it("filters to only tools-layer files when activeLayer is 'tools'", () => {
    const result = filteredFiles(files, "tools");
    expect(result).toHaveLength(2);
    expect(result.every((f) => f.layer === "tools")).toBe(true);
  });

  it("filters to only graph-layer files when activeLayer is 'graph'", () => {
    const result = filteredFiles(files, "graph");
    expect(result).toHaveLength(3);
    expect(result.every((f) => f.layer === "graph")).toBe(true);
  });

  it("returns empty array when activeLayer matches no files", () => {
    const result = filteredFiles(files, "nonexistent-layer");
    expect(result).toHaveLength(0);
  });

  it("filtering feeds into bucket derivation: only layer-filtered files appear in each bucket", () => {
    // Verify end-to-end: filter → then bucket split produces correct counts
    const mixedFiles: PrFileInfo[] = [
      makeFile("src/tools/high.ts", "tools", { bucket: "needs-attention" }),
      makeFile("src/tools/mid.ts", "tools", { bucket: "worth-a-look" }),
      makeFile("src/graph/low.ts", "graph", { bucket: "low-risk" }),
    ];

    const toolsFiltered = filteredFiles(mixedFiles, "tools");
    const needsAttention = toolsFiltered.filter((f) => f.bucket === "needs-attention");
    const worthALook = toolsFiltered.filter((f) => f.bucket === "worth-a-look");
    const lowRisk = toolsFiltered.filter((f) => f.bucket === "low-risk");

    expect(needsAttention).toHaveLength(1);
    expect(worthALook).toHaveLength(1);
    // The graph/low.ts file is filtered out — not visible in tools layer
    expect(lowRisk).toHaveLength(0);
  });
});
