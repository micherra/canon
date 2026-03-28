/**
 * Tests for the explore flow's optional dependencies role.
 *
 * Covers:
 * 1. Parse explore.md and verify the dependencies role has optional: true
 * 2. loadAndResolveFlow("explore") succeeds and the resolved state has the correct role structure
 * 3. isRoleOptional returns true for the dependencies role entry and false for codebase
 */

import { describe, it, expect } from "vitest";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { loadAndResolveFlow } from "../orchestration/flow-parser.ts";
import { isRoleOptional } from "../orchestration/transitions.ts";
import type { RoleEntry } from "../orchestration/flow-schema.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pluginDir = resolve(__dirname, "../../.."); // mcp-server/src/__tests__ → project root

// ---------------------------------------------------------------------------
// Parse explore.md and verify role structure
// ---------------------------------------------------------------------------

describe("explore.md role structure", () => {
  it("parses explore.md and finds the dependencies role marked as optional", async () => {
    const result = await loadAndResolveFlow(pluginDir, "explore");
    expect(result.errors).toHaveLength(0);

    const researchState = result.flow.states["research"];
    expect(researchState).toBeDefined();
    expect(researchState.roles).toBeDefined();

    const roles = researchState.roles as RoleEntry[];
    const dependenciesRole = roles.find((r) =>
      typeof r === "string" ? r === "dependencies" : r.name === "dependencies",
    );

    expect(dependenciesRole).toBeDefined();
    expect(typeof dependenciesRole).toBe("object");
    expect(dependenciesRole).toEqual({ name: "dependencies", optional: true });
  });

  it("parses explore.md and finds codebase role is required (not optional)", async () => {
    const result = await loadAndResolveFlow(pluginDir, "explore");
    expect(result.errors).toHaveLength(0);

    const researchState = result.flow.states["research"];
    const roles = researchState.roles as RoleEntry[];
    const codebaseRole = roles.find((r) =>
      typeof r === "string" ? r === "codebase" : r.name === "codebase",
    );

    expect(codebaseRole).toBeDefined();
    // codebase should remain as a plain string (required)
    expect(typeof codebaseRole).toBe("string");
    expect(codebaseRole).toBe("codebase");
  });
});

// ---------------------------------------------------------------------------
// loadAndResolveFlow("explore") succeeds with correct structure
// ---------------------------------------------------------------------------

describe("loadAndResolveFlow explore", () => {
  it("loads explore flow without errors", async () => {
    const result = await loadAndResolveFlow(pluginDir, "explore");
    expect(result.errors).toHaveLength(0);
    expect(result.flow.name).toBe("explore");
  });

  it("resolves research state as parallel type with two roles", async () => {
    const result = await loadAndResolveFlow(pluginDir, "explore");
    const researchState = result.flow.states["research"];

    expect(researchState.type).toBe("parallel");
    expect(researchState.roles).toHaveLength(2);
  });

  it("has synthesize and done states", async () => {
    const result = await loadAndResolveFlow(pluginDir, "explore");
    expect(result.flow.states["synthesize"]).toBeDefined();
    expect(result.flow.states["done"]).toBeDefined();
    expect(result.flow.states["done"].type).toBe("terminal");
  });
});

// ---------------------------------------------------------------------------
// isRoleOptional correctly classifies explore roles
// ---------------------------------------------------------------------------

describe("isRoleOptional for explore roles", () => {
  it("returns true for dependencies role entry {name: dependencies, optional: true}", () => {
    const dependenciesRole: RoleEntry = { name: "dependencies", optional: true };
    expect(isRoleOptional(dependenciesRole)).toBe(true);
  });

  it("returns false for codebase role (plain string)", () => {
    const codebaseRole: RoleEntry = "codebase";
    expect(isRoleOptional(codebaseRole)).toBe(false);
  });

  it("returns false for a role object without optional flag", () => {
    const roleWithoutOptional: RoleEntry = { name: "some-role" };
    expect(isRoleOptional(roleWithoutOptional)).toBe(false);
  });
});
