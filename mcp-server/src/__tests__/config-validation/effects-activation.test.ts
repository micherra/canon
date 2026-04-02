/**
 * Effects activation tests — verifies that effects declarations in flow fragments
 * and flow files propagate correctly through fragment resolution to the final
 * resolved flow. These tests exercise real flow files on disk.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAndResolveFlow } from "../../orchestration/flow-parser.ts";

const testDir = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(testDir, "../../../.."); // mcp-server/src/__tests__/config-validation → project root

// ---------------------------------------------------------------------------
// review-fix-loop fragment: persist_review on review state
// ---------------------------------------------------------------------------

describe("review-fix-loop fragment effects", () => {
  it("epic: review state has persist_review effect", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "epic");
    const review = flow.states["review"];
    expect(review).toBeDefined();
    expect(review.effects).toBeDefined();
    expect(review.effects).toContainEqual({
      type: "persist_review",
      artifact: "REVIEW.md",
    });
  });

  it("feature: review state has persist_review effect", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "feature");
    const review = flow.states["review"];
    expect(review).toBeDefined();
    expect(review.effects).toBeDefined();
    expect(review.effects).toContainEqual({
      type: "persist_review",
      artifact: "REVIEW.md",
    });
  });

  it("quick-fix: review state has persist_review effect", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "quick-fix");
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
// ship-done fragment: no persist_decisions or persist_patterns (removed)
// ---------------------------------------------------------------------------

describe("ship-done fragment effects", () => {
  it("epic: ship state does not have persist_decisions or persist_patterns effects", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "epic");
    const ship = flow.states["ship"];
    expect(ship).toBeDefined();
    const types = ship.effects?.map((e) => e.type) ?? [];
    expect(types).not.toContain("persist_decisions");
    expect(types).not.toContain("persist_patterns");
  });

  it("feature: ship state does not have persist_decisions or persist_patterns effects", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "feature");
    const ship = flow.states["ship"];
    expect(ship).toBeDefined();
    const types = ship.effects?.map((e) => e.type) ?? [];
    expect(types).not.toContain("persist_decisions");
    expect(types).not.toContain("persist_patterns");
  });

  it("quick-fix: ship state does not have persist_decisions or persist_patterns effects", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "quick-fix");
    const ship = flow.states["ship"];
    expect(ship).toBeDefined();
    const types = ship.effects?.map((e) => e.type) ?? [];
    expect(types).not.toContain("persist_decisions");
    expect(types).not.toContain("persist_patterns");
  });

  it("hotfix: ship state does not have persist_decisions or persist_patterns effects", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "hotfix");
    const ship = flow.states["ship"];
    expect(ship).toBeDefined();
    const types = ship.effects?.map((e) => e.type) ?? [];
    expect(types).not.toContain("persist_decisions");
    expect(types).not.toContain("persist_patterns");
  });
});

// ---------------------------------------------------------------------------
// implement-verify fragment: no persist_decisions (removed)
// ---------------------------------------------------------------------------

describe("implement-verify fragment effects (single-type implement)", () => {
  it("quick-fix: implement state does not have persist_decisions effect", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "quick-fix");
    const implement = flow.states["implement"];
    expect(implement).toBeDefined();
    const types = implement.effects?.map((e) => e.type) ?? [];
    expect(types).not.toContain("persist_decisions");
  });

  it("hotfix: implement state does not have persist_decisions effect", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "hotfix");
    const implement = flow.states["implement"];
    expect(implement).toBeDefined();
    const types = implement.effects?.map((e) => e.type) ?? [];
    expect(types).not.toContain("persist_decisions");
  });
});

// ---------------------------------------------------------------------------
// Wave implement states in epic and feature: no persist_decisions
// ---------------------------------------------------------------------------

describe("wave implement state effects", () => {
  it("epic: implement state (wave) does not have persist_decisions effect", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "epic");
    const implement = flow.states["implement"];
    expect(implement).toBeDefined();
    expect(implement.type).toBe("wave");
    const types = implement.effects?.map((e) => e.type) ?? [];
    expect(types).not.toContain("persist_decisions");
  });

  it("feature: implement state (wave) does not have persist_decisions effect", async () => {
    const flow = await loadAndResolveFlow(pluginDir, "feature");
    const implement = flow.states["implement"];
    expect(implement).toBeDefined();
    expect(implement.type).toBe("wave");
    const types = implement.effects?.map((e) => e.type) ?? [];
    expect(types).not.toContain("persist_decisions");
  });
});
