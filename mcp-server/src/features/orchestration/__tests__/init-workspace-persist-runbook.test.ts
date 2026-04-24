/**
 * Tests for init_workspace runbook_content and brief_content params (NF-7).
 *
 * Covers: persisting runbook and planning brief at creation time,
 * and backward compatibility when neither param is provided.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

let tmpDirs: string[] = [];

function makeTmpProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "persist-runbook-test-"));
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
  task: "add the feature",
  tier: "small" as const,
};

describe("init_workspace — runbook and brief persistence (NF-7)", () => {
  it("persists runbook_content to plans/${slug}/runbook.md when provided", async () => {
    const projectDir = makeTmpProjectDir();
    const runbookContent = "# Runbook\n\nStep 1: do the thing\n";

    const result = await initWorkspaceFlow(
      { ...baseInput, runbook_content: runbookContent },
      projectDir,
      "/fake/plugin",
    );

    expect(result.created).toBe(true);
    const runbookPath = join(result.workspace, "plans", result.slug, "runbook.md");
    expect(existsSync(runbookPath)).toBe(true);
    expect(readFileSync(runbookPath, "utf8")).toBe(runbookContent);
  });

  it("persists brief_content to plans/${slug}/planning-brief.md when provided", async () => {
    const projectDir = makeTmpProjectDir();
    const briefContent = "# Planning Brief\n\nContext: fix all the things\n";

    const result = await initWorkspaceFlow(
      { ...baseInput, brief_content: briefContent },
      projectDir,
      "/fake/plugin",
    );

    expect(result.created).toBe(true);
    const briefPath = join(result.workspace, "plans", result.slug, "planning-brief.md");
    expect(existsSync(briefPath)).toBe(true);
    expect(readFileSync(briefPath, "utf8")).toBe(briefContent);
  });

  it("persists both runbook and brief when both params are provided", async () => {
    const projectDir = makeTmpProjectDir();
    const runbookContent = "# Runbook\n\nstep: implement\n";
    const briefContent = "# Brief\n\ngoal: ship it\n";

    const result = await initWorkspaceFlow(
      { ...baseInput, brief_content: briefContent, runbook_content: runbookContent },
      projectDir,
      "/fake/plugin",
    );

    expect(result.created).toBe(true);
    const plansDir = join(result.workspace, "plans", result.slug);
    expect(readFileSync(join(plansDir, "runbook.md"), "utf8")).toBe(runbookContent);
    expect(readFileSync(join(plansDir, "planning-brief.md"), "utf8")).toBe(briefContent);
  });

  it("does not create runbook.md or planning-brief.md when neither param is provided (backward compat)", async () => {
    const projectDir = makeTmpProjectDir();

    const result = await initWorkspaceFlow({ ...baseInput }, projectDir, "/fake/plugin");

    expect(result.created).toBe(true);
    const plansDir = join(result.workspace, "plans", result.slug);
    expect(existsSync(join(plansDir, "runbook.md"))).toBe(false);
    expect(existsSync(join(plansDir, "planning-brief.md"))).toBe(false);
  });
});
