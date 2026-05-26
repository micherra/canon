/**
 * Tests for seed_from parameter in init_workspace.
 *
 * Covers: path validation for seedFromPriorWorkspace — absolute path check,
 * .canon/workspaces/ segment check, workspace existence check.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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

import { initWorkspaceFlow } from "../tools/init-workspace.ts";
import { seedFromPriorWorkspace } from "../tools/seed-workspace.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seed-test-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Create a minimal prior workspace under .canon/workspaces/ so path validation passes.
 */
function makePriorWorkspace(baseDir: string): string {
  const ws = join(baseDir, ".canon", "workspaces", "main", "prior-task");
  mkdirSync(ws, { recursive: true });
  return ws;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

describe("seedFromPriorWorkspace", () => {
  it("returns seeded: true when source workspace exists and path is valid", async () => {
    const baseDir = makeTmpDir();
    const source = makePriorWorkspace(baseDir);
    const targetDir = join(baseDir, ".canon", "workspaces", "main", "new-task");
    mkdirSync(targetDir, { recursive: true });

    const result = await seedFromPriorWorkspace(source);

    expect(result.seeded).toBe(true);
    expect(result.warnings).toHaveLength(0);
  });

  it("returns seeded: false with warning when source workspace does not exist", async () => {
    const baseDir = makeTmpDir();
    const source = join(baseDir, ".canon", "workspaces", "main", "nonexistent");
    const targetDir = join(baseDir, ".canon", "workspaces", "main", "new-task");
    mkdirSync(targetDir, { recursive: true });

    const result = await seedFromPriorWorkspace(source);

    expect(result.seeded).toBe(false);
    expect(
      result.warnings.some(
        (w) => w.includes("not found") || w.includes("does not exist") || w.includes("nonexistent"),
      ),
    ).toBe(true);
  });

  it("returns warning and seeded: false when a relative path is provided", async () => {
    const result = await seedFromPriorWorkspace("../relative/path");

    expect(result.seeded).toBe(false);
    expect(
      result.warnings.some(
        (w) =>
          w.includes("absolute") ||
          w.includes("traversal") ||
          w.includes("invalid") ||
          w.includes("relative"),
      ),
    ).toBe(true);
  });

  it("returns warning and seeded: false when path does not contain .canon/workspaces/ segment", async () => {
    const baseDir = makeTmpDir();
    const source = join(baseDir, "some", "other", "path");
    mkdirSync(source, { recursive: true });

    const targetDir = join(baseDir, ".canon", "workspaces", "main", "new-task");
    mkdirSync(targetDir, { recursive: true });

    const result = await seedFromPriorWorkspace(source);

    expect(result.seeded).toBe(false);
    expect(
      result.warnings.some(
        (w) => w.includes(".canon/workspaces") || w.includes("invalid") || w.includes("workspace"),
      ),
    ).toBe(true);
  });
});

describe("initWorkspaceFlow — seed_from integration", () => {
  const baseInput = {
    base_commit: "abc123",
    branch: "main",
    flow_name: "fast-path",
    task: "new task",
    tier: "small" as const,
  };

  it("creates workspace normally when seed_from is not provided", async () => {
    const projectDir = makeTmpDir();

    const result = await initWorkspaceFlow({ ...baseInput }, projectDir, "/fake/plugin");

    expect(result.created).toBe(true);
    expect(result.seeded_from).toBeUndefined();
  });

  it("includes seeded_from in result when seed_from is provided and valid", async () => {
    const projectDir = makeTmpDir();
    const priorWs = makePriorWorkspace(projectDir);

    const result = await initWorkspaceFlow(
      { ...baseInput, seed_from: priorWs },
      projectDir,
      "/fake/plugin",
    );

    expect(result.created).toBe(true);
    expect(result.seeded_from).toBe(priorWs);
  });

  it("still creates workspace successfully even when seed_from path is invalid (best-effort)", async () => {
    const projectDir = makeTmpDir();
    const nonexistentSource = join(projectDir, ".canon", "workspaces", "main", "ghost-task");

    const result = await initWorkspaceFlow(
      { ...baseInput, seed_from: nonexistentSource },
      projectDir,
      "/fake/plugin",
    );

    // Workspace creation must succeed even if seeding fails
    expect(result.created).toBe(true);
  });
});
