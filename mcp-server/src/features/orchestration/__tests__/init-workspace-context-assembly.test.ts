/**
 * Tests for init-workspace.ts — conventions context assembly.
 *
 * Covers:
 * - Workspace init with .canon/CONVENTIONS.md present includes conventions in cache prefix
 * - Workspace init without .canon/CONVENTIONS.md still succeeds
 *
 * Note: project_structure (tryGenerateStructure) was removed 2026-05-05;
 * tests for that section have been removed accordingly.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock loadAndResolveFlow to avoid needing real flow files
vi.mock("@domains/flows/flow-parser.ts", () => ({
  loadAndResolveFlow: vi.fn().mockResolvedValue({
    description: "test",
    entry: "build",
    name: "fast-path",
    spawn_instructions: {},
    states: {
      build: { transitions: { done: "done" }, type: "single" },
      done: { type: "terminal" },
    },
  }),
}));

import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { initWorkspaceFlow } from "../tools/init-workspace.ts";

let tmpDirs: string[] = [];

function makeTmpProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "init-ws-ctx-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

const baseInput = {
  base_commit: "abc123",
  branch: "main",
  flow_name: "fast-path",
  task: "test context assembly",
  tier: "small" as const,
};

// project_structure — graceful degradation (no KG DB)

describe("initWorkspaceFlow — project_structure graceful degradation", () => {
  it("succeeds without KG DB (no project_structure section)", async () => {
    const projectDir = makeTmpProjectDir();
    // No KG DB seeded

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");
    expect(result.created).toBe(true);

    const store = getExecutionStore(result.workspace);
    const cachePrefix = store.getCachePrefix();
    // Should succeed — cache prefix exists but doesn't need project_structure
    expect(cachePrefix).toBeTruthy();
  });

  it("result.created is true even when KG DB is missing", async () => {
    const projectDir = makeTmpProjectDir();

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");
    expect(result.created).toBe(true);
    expect(result.workspace).toBeTruthy();
  });
});

// conventions — CONVENTIONS.md present

describe("initWorkspaceFlow — conventions in cache prefix", () => {
  it("cache prefix contains '## Conventions' when .canon/CONVENTIONS.md exists", async () => {
    const projectDir = makeTmpProjectDir();
    const canonDir = join(projectDir, ".canon");
    mkdirSync(canonDir, { recursive: true });
    writeFileSync(
      join(canonDir, "CONVENTIONS.md"),
      "# Project Conventions\n\nUse TypeScript strict mode.",
    );

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");
    expect(result.created).toBe(true);

    const store = getExecutionStore(result.workspace);
    const cachePrefix = store.getCachePrefix();
    expect(cachePrefix).toContain("## Conventions");
    expect(cachePrefix).toContain("Use TypeScript strict mode.");
  });

  it("cache prefix includes full CONVENTIONS.md content", async () => {
    const projectDir = makeTmpProjectDir();
    const canonDir = join(projectDir, ".canon");
    mkdirSync(canonDir, { recursive: true });
    const conventionsContent = "## Test Conventions\n\n- Always write tests first.\n- Use vitest.";
    writeFileSync(join(canonDir, "CONVENTIONS.md"), conventionsContent);

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    const store = getExecutionStore(result.workspace);
    const cachePrefix = store.getCachePrefix();
    expect(cachePrefix).toContain("Always write tests first.");
    expect(cachePrefix).toContain("Use vitest.");
  });
});

// conventions — graceful degradation (no CONVENTIONS.md)

describe("initWorkspaceFlow — conventions graceful degradation", () => {
  it("succeeds without CONVENTIONS.md", async () => {
    const projectDir = makeTmpProjectDir();
    // No .canon/CONVENTIONS.md

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");
    expect(result.created).toBe(true);
  });

  it("cache prefix is valid even without CONVENTIONS.md", async () => {
    const projectDir = makeTmpProjectDir();

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    const store = getExecutionStore(result.workspace);
    const cachePrefix = store.getCachePrefix();
    expect(cachePrefix).toBeTruthy();
    expect(cachePrefix).toContain("## Workspace");
  });
});

// Both KG DB and CONVENTIONS.md present

describe("initWorkspaceFlow — conventions present alongside other content", () => {
  it("cache prefix contains conventions section when present", async () => {
    const projectDir = makeTmpProjectDir();
    const canonDir = join(projectDir, ".canon");
    mkdirSync(canonDir, { recursive: true });
    writeFileSync(join(canonDir, "CONVENTIONS.md"), "## Conventions\n\nTDD always.");

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    const store = getExecutionStore(result.workspace);
    const cachePrefix = store.getCachePrefix();
    expect(cachePrefix).toContain("## Conventions");
    expect(cachePrefix).toContain("TDD always.");
  });
});
