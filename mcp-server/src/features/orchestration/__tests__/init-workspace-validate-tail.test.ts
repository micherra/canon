/**
 * Tests for init_workspace runbook tail validation (v2_1b-10).
 *
 * Covers: validateRunbookTail verifying the last three steps are
 * ship → context-sync → learn in that order, and backward compatibility
 * when runbook_content is absent.
 */

import { mkdtempSync, rmSync } from "node:fs";
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
import { validateRunbookTailForTest } from "../tools/init-workspace.ts";

let tmpDirs: string[] = [];

function makeTmpProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "validate-tail-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

// Helper to build a minimal runbook YAML code block with given step IDs
function makeRunbook(stepIds: string[]): string {
  const steps = stepIds
    .map(
      (id, i) => `\`\`\`yaml
- id: ${id}
  agent: engineer
  artifacts:
    - outcome:done
  hitl: none
\`\`\``,
    )
    .join("\n\n");
  return `# Runbook\n\n${steps}\n`;
}

describe("validateRunbookTail", () => {
  it("returns null for a valid runbook ending with ship → context-sync → learn", () => {
    const runbook = makeRunbook(["implement", "verify", "review", "ship", "context-sync", "learn"]);
    const result = validateRunbookTailForTest(runbook);
    expect(result).toBeNull();
  });

  it("returns an issue when ship is missing (only context-sync → learn)", () => {
    const runbook = makeRunbook(["implement", "verify", "context-sync", "learn"]);
    const result = validateRunbookTailForTest(runbook);
    expect(result).not.toBeNull();
    expect(result).toContain("ship");
  });

  it("returns an issue when learn is in wrong position (learn before context-sync)", () => {
    const runbook = makeRunbook(["implement", "learn", "context-sync", "ship"]);
    const result = validateRunbookTailForTest(runbook);
    expect(result).not.toBeNull();
  });

  it("returns an issue when only context-sync is present without ship or learn", () => {
    const runbook = makeRunbook(["implement", "verify", "context-sync"]);
    const result = validateRunbookTailForTest(runbook);
    expect(result).not.toBeNull();
    expect(result).toContain("ship");
  });

  it("returns null when the runbook has exactly the three mandatory tail steps", () => {
    const runbook = makeRunbook(["ship", "context-sync", "learn"]);
    const result = validateRunbookTailForTest(runbook);
    expect(result).toBeNull();
  });

  it("returns an issue when learn is the wrong order — context-sync after learn", () => {
    const runbook = makeRunbook(["implement", "ship", "learn", "context-sync"]);
    const result = validateRunbookTailForTest(runbook);
    expect(result).not.toBeNull();
  });

  it("returns an issue when ship is last but context-sync and learn are missing", () => {
    const runbook = makeRunbook(["implement", "verify", "ship"]);
    const result = validateRunbookTailForTest(runbook);
    expect(result).not.toBeNull();
  });
});

describe("initWorkspaceFlow — runbook tail validation integration", () => {
  const baseInput = {
    base_commit: "abc123",
    branch: "main",
    flow_name: "fast-path",
    task: "add the feature",
    tier: "small" as const,
  };

  it("reports tail issue in preflight_issues when runbook tail is invalid", async () => {
    const projectDir = makeTmpProjectDir();
    const badRunbook = makeRunbook(["implement", "verify", "context-sync", "learn"]);

    const result = await initWorkspaceFlow(
      { ...baseInput, runbook_content: badRunbook },
      projectDir,
      "/fake/plugin",
    );

    expect(result.created).toBe(true);
    expect(result.preflight_issues).toBeDefined();
    expect(result.preflight_issues!.some((i) => i.includes("ship"))).toBe(true);
  });

  it("reports no tail issues when runbook tail is valid", async () => {
    const projectDir = makeTmpProjectDir();
    const goodRunbook = makeRunbook(["implement", "ship", "context-sync", "learn"]);

    const result = await initWorkspaceFlow(
      { ...baseInput, runbook_content: goodRunbook },
      projectDir,
      "/fake/plugin",
    );

    expect(result.created).toBe(true);
    expect(result.preflight_issues).toBeUndefined();
  });

  it("skips tail validation when runbook_content is absent (backward compat)", async () => {
    const projectDir = makeTmpProjectDir();

    const result = await initWorkspaceFlow({ ...baseInput }, projectDir, "/fake/plugin");

    expect(result.created).toBe(true);
    expect(result.preflight_issues).toBeUndefined();
  });
});
