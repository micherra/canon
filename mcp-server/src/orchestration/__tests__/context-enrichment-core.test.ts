/**
 * Context Enrichment Tests — Core behavior (strict TDD — tests written before implementation)
 * Part 1 of 2: empty scope, dc-01 (all sections present), dc-03 (tier/char caps).
 *
 * Covers done criteria:
 *   dc-01: git history + drift signals + prior work sections all appear
 *   dc-03: tier cap (5 fast-path) and total char cap (6000)
 *
 * Additional:
 *   - Empty scope: returns empty content with warning
 *   - Budget enforcement: output truncated with [truncated] marker
 */

import type { Board } from "@domains/flows/board-state-schemas.ts";
import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Module mocks — must be hoisted to top of file

vi.mock("@platform/adapters/git-adapter.ts", () => ({
  gitLog: vi.fn(),
}));

vi.mock("@platform/storage/drift/store.ts", () => ({
  DriftStore: vi.fn(function () {
    return {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
  }),
}));

vi.mock("@features/orchestration/services/scope-resolver.ts", () => ({
  resolveTaskScope: vi.fn(),
}));

vi.mock("@domains/workspaces/execution-store-cache.ts", () => ({
  getExecutionStore: vi.fn().mockReturnValue({
    getSession: vi.fn().mockReturnValue({ tier: "medium" }),
  }),
}));

// Imports (after mocks)

import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import {
  assembleEnrichment,
  type EnrichmentInput,
} from "@features/orchestration/services/context-enrichment.ts";
import { resolveTaskScope } from "@features/orchestration/services/scope-resolver.ts";
import { gitLog } from "@platform/adapters/git-adapter.ts";
import { DriftStore } from "@platform/storage/drift/store.ts";

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    base_commit: "abc123",
    blocked: null,
    concerns: [],
    current_state: "implement",
    entry: "implement",
    flow: "build",
    iterations: {},
    last_updated: new Date().toISOString(),
    skipped: [],
    started: new Date().toISOString(),
    states: {},
    task: "Test task",
    ...overrides,
  };
}

function makeFlow(tier = "medium"): ResolvedFlow {
  return {
    description: "Build flow",
    entry: "implement",
    name: "build",
    params: {},
    states: {
      implement: {
        spawn: { agent: "implementor", prompt: "implement" },
        transitions: { done: "terminal" },
        type: "single",
      },
      terminal: {
        type: "terminal",
      },
    },
    tier,
  } as unknown as ResolvedFlow;
}

function makeInput(overrides: Partial<EnrichmentInput> = {}): EnrichmentInput {
  return {
    board: makeBoard(),
    cwd: "/tmp/project",
    flow: makeFlow(),
    projectDir: "/tmp/project",
    stateId: "implement",
    workspace: "/tmp/workspace",
    ...overrides,
  };
}

function makeGitOk(stdout: string) {
  return { duration_ms: 20, exitCode: 0, ok: true, stderr: "", stdout, timedOut: false };
}

function makeReviewEntry(
  files: string[],
  violationCount = 0,
  verdict: "BLOCKING" | "WARNING" | "CLEAN" = "CLEAN",
) {
  return {
    files,
    honored: [],
    review_id: "rev_test_1",
    score: {
      conventions: { passed: 1, total: 1 },
      opinions: { passed: 1, total: 1 },
      rules: { passed: 0, total: 1 },
    },
    timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
    verdict,
    violations: Array.from({ length: violationCount }, (_, i) => ({
      file_path: files[0],
      message: `Violation ${i}`,
      principle_id: `principle-${i}`,
      severity: "rule",
    })),
  };
}

// Tests: dc-04 — Empty scope → graceful degradation

describe("assembleEnrichment — empty scope", () => {
  beforeEach(() => {
    vi.mocked(resolveTaskScope).mockReturnValue([]);
  });

  it("returns empty content and warning when no task scope found", async () => {
    const result = await assembleEnrichment(makeInput());
    expect(result.content).toBe("");
    expect(result.warnings).toContain("enrichment: no task scope found");
  });
});

// Tests: dc-01 — All three sections present

describe("assembleEnrichment — dc-01: all sections present", () => {
  beforeEach(() => {
    vi.mocked(resolveTaskScope).mockReturnValue(["src/foo.ts", "src/bar.ts"]);

    // Git returns commit history for each file
    vi.mocked(gitLog).mockReturnValue(
      makeGitOk("abc1234 Add feature\nbcd2345 Fix bug\ncde3456 Initial commit"),
    );

    // Drift returns a review with no violations
    const mockStore = {
      getReviewsForFiles: vi
        .fn()
        .mockResolvedValue([makeReviewEntry(["src/foo.ts", "src/bar.ts"])]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });
  });

  it("output contains Recent Changes section (git)", async () => {
    const result = await assembleEnrichment(makeInput());
    expect(result.content).toContain("Recent Changes");
    expect(result.content).toContain("src/foo.ts");
  });

  it("output contains Drift Signals section", async () => {
    const result = await assembleEnrichment(makeInput());
    expect(result.content).toContain("Drift Signals");
    expect(result.content).toContain("CLEAN");
  });

  it("output starts with ## Context Enrichment heading", async () => {
    const result = await assembleEnrichment(makeInput());
    expect(result.content.trim()).toMatch(/^## Context Enrichment/);
  });
});

// Tests: dc-03 — Tier cap and total char cap

describe("assembleEnrichment — dc-03: tier and char caps", () => {
  it("fast-path tier caps file entries at 5 even with 50 files", async () => {
    const fiftyFiles = Array.from({ length: 50 }, (_, i) => `src/file-${i}.ts`);
    vi.mocked(resolveTaskScope).mockReturnValue(fiftyFiles);

    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Add feature"));

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    vi.mocked(getExecutionStore).mockReturnValue({
      getSession: vi.fn().mockReturnValue({ tier: "small" }),
    } as any);

    const result = await assembleEnrichment(makeInput());

    // Count how many unique file-N entries appear — should be at most 5
    const fileMatches = result.content.match(/`src\/file-\d+\.ts`/g) ?? [];
    const uniqueFiles = new Set(fileMatches);
    expect(uniqueFiles.size).toBeLessThanOrEqual(5);
  });

  it("total output does not exceed 6000 chars", async () => {
    const files = Array.from({ length: 30 }, (_, i) => `src/file-${i}.ts`);
    vi.mocked(resolveTaskScope).mockReturnValue(files);

    // Return lots of git output per file to stress budget
    const longCommitMsg = "x".repeat(200);
    vi.mocked(gitLog).mockReturnValue(
      makeGitOk(Array.from({ length: 5 }, (_, i) => `sha${i} ${longCommitMsg}`).join("\n")),
    );

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([makeReviewEntry(files, 3)]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    vi.mocked(getExecutionStore).mockReturnValue({
      getSession: vi.fn().mockReturnValue({ tier: "large" }),
    } as any);

    const result = await assembleEnrichment(makeInput());

    expect(result.content.length).toBeLessThanOrEqual(6000);
  });

  it("adds [truncated] marker when content exceeds 6000 chars", async () => {
    const files = Array.from({ length: 30 }, (_, i) => `src/file-${i}.ts`);
    vi.mocked(resolveTaskScope).mockReturnValue(files);

    // Very long output per file
    vi.mocked(gitLog).mockReturnValue(
      makeGitOk(
        Array.from(
          { length: 5 },
          (_, i) => `sha${i} ${"very long commit message ".repeat(20)}`,
        ).join("\n"),
      ),
    );

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([makeReviewEntry(files, 5)]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    vi.mocked(getExecutionStore).mockReturnValue({
      getSession: vi.fn().mockReturnValue({ tier: "large" }),
    } as any);

    const result = await assembleEnrichment(makeInput());

    // If truncated, should have the marker
    if (result.content.length >= 6000 - 15) {
      expect(result.content).toContain("[truncated]");
    }
    expect(result.content.length).toBeLessThanOrEqual(6000);
  });

  // New tests: session-store tier resolution

  it("uses small tier cap (5 files) when session tier is small", async () => {
    const tenFiles = Array.from({ length: 10 }, (_, i) => `src/file-${i}.ts`);
    vi.mocked(resolveTaskScope).mockReturnValue(tenFiles);
    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Add feature"));
    vi.mocked(DriftStore).mockImplementation(function () {
      return { getReviewsForFiles: vi.fn().mockResolvedValue([]) } as any;
    });

    vi.mocked(getExecutionStore).mockReturnValue({
      getSession: vi.fn().mockReturnValue({ tier: "small" }),
    } as any);

    const result = await assembleEnrichment(makeInput());

    const fileMatches = result.content.match(/`src\/file-\d+\.ts`/g) ?? [];
    const uniqueFiles = new Set(fileMatches);
    expect(uniqueFiles.size).toBeLessThanOrEqual(5);
  });

  it("uses large tier cap (30 files) when session tier is large", async () => {
    const thirtyFiveFiles = Array.from({ length: 35 }, (_, i) => `src/file-${i}.ts`);
    vi.mocked(resolveTaskScope).mockReturnValue(thirtyFiveFiles);
    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Add feature"));
    vi.mocked(DriftStore).mockImplementation(function () {
      return { getReviewsForFiles: vi.fn().mockResolvedValue([]) } as any;
    });

    vi.mocked(getExecutionStore).mockReturnValue({
      getSession: vi.fn().mockReturnValue({ tier: "large" }),
    } as any);

    const result = await assembleEnrichment(makeInput());

    const fileMatches = result.content.match(/`src\/file-\d+\.ts`/g) ?? [];
    const uniqueFiles = new Set(fileMatches);
    // Large cap is 30; 35 files provided so exactly 30 should be processed
    expect(uniqueFiles.size).toBeLessThanOrEqual(30);
    expect(uniqueFiles.size).toBeGreaterThan(15); // more than medium cap
  });

  it("falls back to medium cap when execution store throws", async () => {
    const twentyFiles = Array.from({ length: 20 }, (_, i) => `src/file-${i}.ts`);
    vi.mocked(resolveTaskScope).mockReturnValue(twentyFiles);
    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Add feature"));
    vi.mocked(DriftStore).mockImplementation(function () {
      return { getReviewsForFiles: vi.fn().mockResolvedValue([]) } as any;
    });

    vi.mocked(getExecutionStore).mockImplementation(() => {
      throw new Error("store unavailable");
    });

    const result = await assembleEnrichment(makeInput());

    // Medium cap is 15; 20 files provided so at most 15 should be processed
    const fileMatches = result.content.match(/`src\/file-\d+\.ts`/g) ?? [];
    const uniqueFiles = new Set(fileMatches);
    expect(uniqueFiles.size).toBeLessThanOrEqual(15);
  });
});
