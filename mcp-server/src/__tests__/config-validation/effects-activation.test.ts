/**
 * Effects activation tests — verifies that effects declarations in flow fragments
 * and flow files propagate correctly through fragment resolution to the final
 * resolved flow. These tests exercise real flow files on disk.
 */

import { describe, it, expect } from "vitest";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { loadAndResolveFlow } from "../../orchestration/flow-parser.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pluginDir = resolve(__dirname, "../../../.."); // mcp-server/src/__tests__/config-validation → project root

// ---------------------------------------------------------------------------
// review-fix-loop fragment: persist_review on review state
// ---------------------------------------------------------------------------

describe("review-fix-loop fragment effects", () => {
  it("deep-build: review state has persist_review effect", async () => {
    const { flow, errors } = await loadAndResolveFlow(pluginDir, "deep-build");
    expect(errors).toEqual([]);
    const review = flow.states["review"];
    expect(review).toBeDefined();
    expect(review.effects).toBeDefined();
    expect(review.effects).toContainEqual({
      type: "persist_review",
      artifact: "REVIEW.md",
    });
  });

  it("feature: review state has persist_review effect", async () => {
    const { flow, errors } = await loadAndResolveFlow(pluginDir, "feature");
    expect(errors).toEqual([]);
    const review = flow.states["review"];
    expect(review).toBeDefined();
    expect(review.effects).toBeDefined();
    expect(review.effects).toContainEqual({
      type: "persist_review",
      artifact: "REVIEW.md",
    });
  });

  it("quick-fix: review state has persist_review effect", async () => {
    const { flow, errors } = await loadAndResolveFlow(pluginDir, "quick-fix");
    expect(errors).toEqual([]);
    const review = flow.states["review"];
    expect(review).toBeDefined();
    expect(review.effects).toBeDefined();
    expect(review.effects).toContainEqual({
      type: "persist_review",
      artifact: "REVIEW.md",
    });
  });
});

// ---------------------------------------------------------------------------
// ship-done fragment: persist_decisions + persist_patterns on ship state
// ---------------------------------------------------------------------------

describe("ship-done fragment effects", () => {
  it("deep-build: ship state has persist_decisions and persist_patterns effects", async () => {
    const { flow, errors } = await loadAndResolveFlow(pluginDir, "deep-build");
    expect(errors).toEqual([]);
    const ship = flow.states["ship"];
    expect(ship).toBeDefined();
    expect(ship.effects).toBeDefined();
    const types = ship.effects!.map((e) => e.type);
    expect(types).toContain("persist_decisions");
    expect(types).toContain("persist_patterns");
  });

  it("feature: ship state has persist_decisions and persist_patterns effects", async () => {
    const { flow, errors } = await loadAndResolveFlow(pluginDir, "feature");
    expect(errors).toEqual([]);
    const ship = flow.states["ship"];
    expect(ship).toBeDefined();
    expect(ship.effects).toBeDefined();
    const types = ship.effects!.map((e) => e.type);
    expect(types).toContain("persist_decisions");
    expect(types).toContain("persist_patterns");
  });

  it("quick-fix: ship state has persist_decisions and persist_patterns effects", async () => {
    const { flow, errors } = await loadAndResolveFlow(pluginDir, "quick-fix");
    expect(errors).toEqual([]);
    const ship = flow.states["ship"];
    expect(ship).toBeDefined();
    expect(ship.effects).toBeDefined();
    const types = ship.effects!.map((e) => e.type);
    expect(types).toContain("persist_decisions");
    expect(types).toContain("persist_patterns");
  });

  it("hotfix: ship state has persist_decisions and persist_patterns effects", async () => {
    const { flow, errors } = await loadAndResolveFlow(pluginDir, "hotfix");
    expect(errors).toEqual([]);
    const ship = flow.states["ship"];
    expect(ship).toBeDefined();
    expect(ship.effects).toBeDefined();
    const types = ship.effects!.map((e) => e.type);
    expect(types).toContain("persist_decisions");
    expect(types).toContain("persist_patterns");
  });
});

// ---------------------------------------------------------------------------
// implement-verify fragment: persist_decisions on implement state
// ---------------------------------------------------------------------------

describe("implement-verify fragment effects (single-type implement)", () => {
  it("quick-fix: implement state has persist_decisions effect", async () => {
    const { flow, errors } = await loadAndResolveFlow(pluginDir, "quick-fix");
    expect(errors).toEqual([]);
    const implement = flow.states["implement"];
    expect(implement).toBeDefined();
    expect(implement.effects).toBeDefined();
    expect(implement.effects).toContainEqual({ type: "persist_decisions" });
  });

  it("hotfix: implement state has persist_decisions effect", async () => {
    const { flow, errors } = await loadAndResolveFlow(pluginDir, "hotfix");
    expect(errors).toEqual([]);
    const implement = flow.states["implement"];
    expect(implement).toBeDefined();
    expect(implement.effects).toBeDefined();
    expect(implement.effects).toContainEqual({ type: "persist_decisions" });
  });
});

// ---------------------------------------------------------------------------
// Wave implement states in deep-build and feature: persist_decisions
// ---------------------------------------------------------------------------

describe("wave implement state effects", () => {
  it("deep-build: implement state (wave) has persist_decisions effect", async () => {
    const { flow, errors } = await loadAndResolveFlow(pluginDir, "deep-build");
    expect(errors).toEqual([]);
    const implement = flow.states["implement"];
    expect(implement).toBeDefined();
    expect(implement.type).toBe("wave");
    expect(implement.effects).toBeDefined();
    expect(implement.effects).toContainEqual({ type: "persist_decisions" });
  });

  it("feature: implement state (wave) has persist_decisions effect", async () => {
    const { flow, errors } = await loadAndResolveFlow(pluginDir, "feature");
    expect(errors).toEqual([]);
    const implement = flow.states["implement"];
    expect(implement).toBeDefined();
    expect(implement.type).toBe("wave");
    expect(implement.effects).toBeDefined();
    expect(implement.effects).toContainEqual({ type: "persist_decisions" });
  });
});
