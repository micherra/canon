/**
 * Tests for seed_from parameter in init_workspace.
 *
 * Covers: copying handoffs/*.md and research/*.md from a prior workspace
 * into the seeded/ subdirectory of the new workspace, with proper error
 * handling for missing paths, path traversal attempts, and non-.md files.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
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

import { initWorkspaceFlow, seedFromPriorWorkspace } from "../tools/init-workspace.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "seed-test-"));
  tmpDirs.push(dir);
  return dir;
}

/**
 * Create a fake prior workspace with the expected directory structure
 * under .canon/workspaces/ so path validation passes.
 */
function makePriorWorkspace(
  baseDir: string,
  opts: {
    handoffs?: Record<string, string>;
    research?: Record<string, string>;
    nonMdFiles?: string[];
    skipHandoffs?: boolean;
    skipResearch?: boolean;
  } = {},
): string {
  // Path must contain .canon/workspaces/ to pass validation
  const ws = join(baseDir, ".canon", "workspaces", "main", "prior-task");

  if (!opts.skipHandoffs) {
    mkdirSync(join(ws, "handoffs"), { recursive: true });
    for (const [name, content] of Object.entries(opts.handoffs ?? { "handoff-1.md": "# Handoff 1" })) {
      writeFileSync(join(ws, "handoffs", name), content);
    }
  } else {
    mkdirSync(ws, { recursive: true });
  }

  if (!opts.skipResearch) {
    mkdirSync(join(ws, "research"), { recursive: true });
    for (const [name, content] of Object.entries(opts.research ?? { "research-1.md": "# Research 1" })) {
      writeFileSync(join(ws, "research", name), content);
    }
  }

  for (const name of opts.nonMdFiles ?? []) {
    const dir = name.startsWith("handoffs/") ? join(ws, "handoffs") : join(ws, "research");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(ws, name), "binary content");
  }

  return ws;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

describe("seedFromPriorWorkspace", () => {
  it("copies handoffs/*.md to seeded/handoffs/", async () => {
    const baseDir = makeTmpDir();
    const source = makePriorWorkspace(baseDir, {
      handoffs: { "handoff-a.md": "# Handoff A", "handoff-b.md": "# Handoff B" },
      research: {},
    });

    const targetDir = join(baseDir, ".canon", "workspaces", "main", "new-task");
    mkdirSync(targetDir, { recursive: true });

    const result = await seedFromPriorWorkspace(source, targetDir);

    expect(result.seeded).toBe(true);
    expect(existsSync(join(targetDir, "seeded", "handoffs", "handoff-a.md"))).toBe(true);
    expect(existsSync(join(targetDir, "seeded", "handoffs", "handoff-b.md"))).toBe(true);
    const content = await readFile(join(targetDir, "seeded", "handoffs", "handoff-a.md"), "utf-8");
    expect(content).toBe("# Handoff A");
  });

  it("copies research/*.md to seeded/research/", async () => {
    const baseDir = makeTmpDir();
    const source = makePriorWorkspace(baseDir, {
      handoffs: {},
      research: { "research-synthesis.md": "# Research Synthesis" },
    });

    const targetDir = join(baseDir, ".canon", "workspaces", "main", "new-task");
    mkdirSync(targetDir, { recursive: true });

    const result = await seedFromPriorWorkspace(source, targetDir);

    expect(result.seeded).toBe(true);
    expect(existsSync(join(targetDir, "seeded", "research", "research-synthesis.md"))).toBe(true);
    const content = await readFile(join(targetDir, "seeded", "research", "research-synthesis.md"), "utf-8");
    expect(content).toBe("# Research Synthesis");
  });

  it("returns seeded: false with warning when source workspace does not exist", async () => {
    const baseDir = makeTmpDir();
    const source = join(baseDir, ".canon", "workspaces", "main", "nonexistent");
    const targetDir = join(baseDir, ".canon", "workspaces", "main", "new-task");
    mkdirSync(targetDir, { recursive: true });

    const result = await seedFromPriorWorkspace(source, targetDir);

    expect(result.seeded).toBe(false);
    expect(result.warnings.some((w) => w.includes("not found") || w.includes("does not exist") || w.includes("nonexistent"))).toBe(true);
  });

  it("returns warning but still copies research when handoffs/ directory is missing", async () => {
    const baseDir = makeTmpDir();
    const source = makePriorWorkspace(baseDir, {
      skipHandoffs: true,
      research: { "research-1.md": "# Research" },
    });

    const targetDir = join(baseDir, ".canon", "workspaces", "main", "new-task");
    mkdirSync(targetDir, { recursive: true });

    const result = await seedFromPriorWorkspace(source, targetDir);

    // Should still succeed (seeded: true) but with a warning about missing handoffs
    expect(result.seeded).toBe(true);
    expect(result.warnings.some((w) => w.includes("handoffs"))).toBe(true);
    // Research should still be copied
    expect(existsSync(join(targetDir, "seeded", "research", "research-1.md"))).toBe(true);
  });

  it("does not copy non-.md files", async () => {
    const baseDir = makeTmpDir();
    const source = makePriorWorkspace(baseDir, {
      handoffs: { "handoff.md": "# Handoff" },
      research: {},
      nonMdFiles: ["handoffs/binary.bin", "handoffs/image.png"],
    });

    const targetDir = join(baseDir, ".canon", "workspaces", "main", "new-task");
    mkdirSync(targetDir, { recursive: true });

    await seedFromPriorWorkspace(source, targetDir);

    expect(existsSync(join(targetDir, "seeded", "handoffs", "binary.bin"))).toBe(false);
    expect(existsSync(join(targetDir, "seeded", "handoffs", "image.png"))).toBe(false);
    expect(existsSync(join(targetDir, "seeded", "handoffs", "handoff.md"))).toBe(true);
  });

  it("returns warning and seeded: false when a relative path is provided (path traversal attempt)", async () => {
    const targetDir = makeTmpDir();

    const result = await seedFromPriorWorkspace("../relative/path", targetDir);

    expect(result.seeded).toBe(false);
    expect(result.warnings.some((w) => w.includes("absolute") || w.includes("traversal") || w.includes("invalid") || w.includes("relative"))).toBe(true);
  });

  it("returns warning and seeded: false when path does not contain .canon/workspaces/ segment", async () => {
    const baseDir = makeTmpDir();
    // A valid absolute path but outside the .canon/workspaces/ tree
    const source = join(baseDir, "some", "other", "path");
    mkdirSync(source, { recursive: true });

    const targetDir = join(baseDir, ".canon", "workspaces", "main", "new-task");
    mkdirSync(targetDir, { recursive: true });

    const result = await seedFromPriorWorkspace(source, targetDir);

    expect(result.seeded).toBe(false);
    expect(result.warnings.some((w) => w.includes(".canon/workspaces") || w.includes("invalid") || w.includes("workspace"))).toBe(true);
  });

  it("produces seeded: true with empty target directories when source directories are empty", async () => {
    const baseDir = makeTmpDir();
    const source = makePriorWorkspace(baseDir, {
      handoffs: {},
      research: {},
    });

    const targetDir = join(baseDir, ".canon", "workspaces", "main", "new-task");
    mkdirSync(targetDir, { recursive: true });

    const result = await seedFromPriorWorkspace(source, targetDir);

    expect(result.seeded).toBe(true);
    // Directories should exist but be empty
    expect(existsSync(join(targetDir, "seeded", "handoffs"))).toBe(true);
    expect(existsSync(join(targetDir, "seeded", "research"))).toBe(true);
    const handoffFiles = await readdir(join(targetDir, "seeded", "handoffs"));
    const researchFiles = await readdir(join(targetDir, "seeded", "research"));
    expect(handoffFiles).toHaveLength(0);
    expect(researchFiles).toHaveLength(0);
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
    // Create a valid prior workspace
    const priorWs = join(projectDir, ".canon", "workspaces", "main", "prior-task");
    mkdirSync(join(priorWs, "handoffs"), { recursive: true });
    mkdirSync(join(priorWs, "research"), { recursive: true });
    writeFileSync(join(priorWs, "handoffs", "prior-handoff.md"), "# Prior handoff");

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
