/**
 * Scope Resolver Tests
 *
 * Tests for resolveTaskScope — extracts affected file paths from available
 * board artifacts, task plan YAML frontmatter, and review scope.
 *
 * Uses strict TDD: tests written before implementation.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Board } from "../../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// We test resolveTaskScope via a workspace with temp dirs and board objects
// ---------------------------------------------------------------------------

import { resolveTaskScope } from "../scope-resolver.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    flow: "build",
    task: "Test task",
    entry: "research",
    current_state: "research",
    base_commit: "abc123",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: {},
    iterations: {},
    blocked: null,
    concerns: [],
    skipped: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: board artifact source
// ---------------------------------------------------------------------------

describe("resolveTaskScope — board artifact source", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "scope-resolver-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns file paths from board artifacts containing backtick-quoted paths", () => {
    const artifactPath = join(tmpDir, "research-ANALYSIS.md");
    writeFileSync(
      artifactPath,
      "Here are the files:\n`mcp-server/src/adapters/git-adapter.ts`\n`mcp-server/src/drift/store.ts`\n",
    );

    const board = makeBoard({
      states: {
        research: {
          status: "done",
          entries: 1,
          artifacts: [artifactPath],
        },
      },
    });

    const result = resolveTaskScope({
      workspace: tmpDir,
      stateId: "research",
      board,
    });

    expect(result).toContain("mcp-server/src/adapters/git-adapter.ts");
    expect(result).toContain("mcp-server/src/drift/store.ts");
  });

  it("returns empty array when board state has no artifacts", () => {
    const board = makeBoard({
      states: {
        research: {
          status: "done",
          entries: 1,
          artifacts: [],
        },
      },
    });

    const result = resolveTaskScope({
      workspace: tmpDir,
      stateId: "research",
      board,
    });

    expect(result).toEqual([]);
  });

  it("handles missing artifact files gracefully (no throw)", () => {
    const board = makeBoard({
      states: {
        research: {
          status: "done",
          entries: 1,
          artifacts: [join(tmpDir, "nonexistent-file.md")],
        },
      },
    });

    expect(() =>
      resolveTaskScope({ workspace: tmpDir, stateId: "research", board }),
    ).not.toThrow();

    const result = resolveTaskScope({
      workspace: tmpDir,
      stateId: "research",
      board,
    });
    expect(result).toEqual([]);
  });

  it("caps file reads at 50KB to avoid memory issues", () => {
    // Create a file just over 50KB
    const bigContent =
      "`mcp-server/src/first.ts`\n" + "x".repeat(51 * 1024) + "\n`mcp-server/src/after.ts`\n";
    const artifactPath = join(tmpDir, "big-analysis.md");
    writeFileSync(artifactPath, bigContent);

    const board = makeBoard({
      states: {
        research: {
          status: "done",
          entries: 1,
          artifacts: [artifactPath],
        },
      },
    });

    // Should not throw and should extract paths from within the cap
    expect(() =>
      resolveTaskScope({ workspace: tmpDir, stateId: "research", board }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests: task plan files source
// ---------------------------------------------------------------------------

describe("resolveTaskScope — task plan YAML frontmatter source", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "scope-resolver-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns file paths from task plan YAML frontmatter files: field", () => {
    const plansDir = join(tmpDir, "plans", "my-slug");
    mkdirSync(plansDir, { recursive: true });

    const planContent = `---
task_id: "enr-01"
wave: 1
files:
  - mcp-server/src/orchestration/scope-resolver.ts
  - mcp-server/src/adapters/git-adapter.ts
---

## Task content
`;
    writeFileSync(join(plansDir, "enr-01-PLAN.md"), planContent);

    const board = makeBoard();

    const result = resolveTaskScope({
      workspace: tmpDir,
      stateId: "implement",
      board,
      planSlug: "my-slug",
      taskId: "enr-01",
    });

    expect(result).toContain("mcp-server/src/orchestration/scope-resolver.ts");
    expect(result).toContain("mcp-server/src/adapters/git-adapter.ts");
  });

  it("returns empty array when plan file does not exist", () => {
    const board = makeBoard();

    const result = resolveTaskScope({
      workspace: tmpDir,
      stateId: "implement",
      board,
      planSlug: "nonexistent-slug",
      taskId: "enr-01",
    });

    expect(result).toEqual([]);
  });

  it("returns empty array when plan has no files: field in frontmatter", () => {
    const plansDir = join(tmpDir, "plans", "my-slug");
    mkdirSync(plansDir, { recursive: true });

    const planContent = `---
task_id: "enr-01"
wave: 1
---

## Task content without files field
`;
    writeFileSync(join(plansDir, "enr-01-PLAN.md"), planContent);

    const board = makeBoard();

    const result = resolveTaskScope({
      workspace: tmpDir,
      stateId: "implement",
      board,
      planSlug: "my-slug",
      taskId: "enr-01",
    });

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: empty fallback
// ---------------------------------------------------------------------------

describe("resolveTaskScope — fallback", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "scope-resolver-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no scope sources are available", () => {
    const board = makeBoard();

    const result = resolveTaskScope({
      workspace: tmpDir,
      stateId: "implement",
      board,
    });

    expect(result).toEqual([]);
  });

  it("deduplicates file paths when multiple artifact files mention the same path", () => {
    // Two artifact files both mention the same path — result should be deduplicated
    const artifact1 = join(tmpDir, "analysis1.md");
    const artifact2 = join(tmpDir, "analysis2.md");
    writeFileSync(
      artifact1,
      "`mcp-server/src/adapters/git-adapter.ts`\n`mcp-server/src/drift/store.ts`\n",
    );
    writeFileSync(
      artifact2,
      "`mcp-server/src/adapters/git-adapter.ts`\n`mcp-server/src/orchestration/scope-resolver.ts`\n",
    );

    const board = makeBoard({
      states: {
        research: {
          status: "done",
          entries: 1,
          artifacts: [artifact1, artifact2],
        },
      },
    });

    const result = resolveTaskScope({
      workspace: tmpDir,
      stateId: "research",
      board,
    });

    // Should not contain duplicate paths
    const uniquePaths = new Set(result);
    expect(uniquePaths.size).toBe(result.length);
    expect(result).toContain("mcp-server/src/adapters/git-adapter.ts");
    expect(result).toContain("mcp-server/src/drift/store.ts");
    expect(result).toContain("mcp-server/src/orchestration/scope-resolver.ts");
  });
});
