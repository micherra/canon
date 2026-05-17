/**
 * build-trend-summary-writer — unit tests.
 *
 * Tests cover:
 *  1. Produces summary with 3 sections when >= 5 flow runs exist
 *  2. Output is under 100 lines
 *  3. Gracefully skips (returns true, no file written) when < 5 runs
 *  4. Returns false (never throws) when DB access fails
 *  5. Includes correct tier distribution counts
 *  6. Includes most-retried states sorted by total iterations
 *
 * Mock strategy:
 *  - Mock `@platform/storage/drift/drift-db.ts` to control getDriftDb
 *  - Mock `@app/server-state.ts` to control projectDir
 *  - Use real temp dirs for filesystem tests
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ---- Module mocks (must be before imports) ----

vi.mock("@app/server-state.ts", () => ({
  projectDir: "/Users/mock/project",
}));

const mockGetAllFlowRuns = vi.fn();
const mockGetReviews = vi.fn();

vi.mock("@platform/storage/drift/drift-db.ts", () => ({
  getDriftDb: vi.fn(() => ({
    getAllFlowRuns: mockGetAllFlowRuns,
    getReviews: mockGetReviews,
  })),
}));

// Import after mocks
import type { FlowRunEntry } from "@platform/storage/drift/drift-analytics-types.ts";
import {
  extractTrendData,
  formatTrendMarkdown,
  tryWriteBuildTrendSummary,
} from "../build-trend-summary-writer.ts";

// ---- Test fixtures ----

function makeFlowRun(overrides: Partial<FlowRunEntry> = {}): FlowRunEntry {
  return {
    completed: "2026-01-15T11:00:00.000Z",
    flow: "feature",
    run_id: `run-${Math.random().toString(36).slice(2)}`,
    skipped_states: [],
    started: "2026-01-15T10:00:00.000Z",
    state_durations: {},
    state_iterations: {},
    task: "Build something",
    tier: "medium",
    total_duration_ms: 3600000,
    total_spawns: 3,
    ...overrides,
  };
}

const FIVE_RUNS: FlowRunEntry[] = [
  makeFlowRun({ tier: "small", total_duration_ms: 600000 }),
  makeFlowRun({ tier: "medium", total_duration_ms: 1800000 }),
  makeFlowRun({ tier: "medium", total_duration_ms: 2400000 }),
  makeFlowRun({ tier: "large", total_duration_ms: 7200000 }),
  makeFlowRun({
    state_iterations: { implement: 3, review: 2 },
    tier: "medium",
    total_duration_ms: 3000000,
  }),
];

// ---- extractTrendData ----

describe("extractTrendData", () => {
  test("counts tier distribution correctly", () => {
    const data = extractTrendData(FIVE_RUNS, []);

    expect(data.tierDistribution.small).toBe(1);
    expect(data.tierDistribution.medium).toBe(3);
    expect(data.tierDistribution.large).toBe(1);
  });

  test("computes average duration per tier", () => {
    const data = extractTrendData(FIVE_RUNS, []);

    // medium: (1800000 + 2400000 + 3000000) / 3 = 2400000 ms = 40m
    expect(data.tierDistribution.avgDurationMsByTier.medium).toBe(2400000);
    // small: 600000 / 1 = 600000 ms = 10m
    expect(data.tierDistribution.avgDurationMsByTier.small).toBe(600000);
    // large: 7200000 / 1 = 7200000 ms = 120m
    expect(data.tierDistribution.avgDurationMsByTier.large).toBe(7200000);
  });

  test("identifies most-retried states sorted by total iterations descending", () => {
    const runs: FlowRunEntry[] = [
      makeFlowRun({ state_iterations: { implement: 3, review: 1 } }),
      makeFlowRun({ state_iterations: { implement: 2, review: 2 } }),
      makeFlowRun({ state_iterations: { implement: 1 } }),
      makeFlowRun({ state_iterations: {} }),
      makeFlowRun({ state_iterations: { design: 4 } }),
    ];

    const data = extractTrendData(runs, []);

    // implement: 3+2+1 = 6 across 3 builds
    // review: 1+2 = 3 across 2 builds
    // design: 4 across 1 build
    expect(data.mostRetriedStates[0].state).toBe("implement");
    expect(data.mostRetriedStates[0].totalIterations).toBe(6);
    expect(data.mostRetriedStates[0].buildsAffected).toBe(3);

    // Second should be design (4) or review (3) — design has more total iterations
    expect(data.mostRetriedStates[1].state).toBe("design");
    expect(data.mostRetriedStates[1].totalIterations).toBe(4);
  });

  test("returns empty mostRetriedStates when no state_iterations exist", () => {
    const runs = FIVE_RUNS.map((r) => ({ ...r, state_iterations: {} }));
    const data = extractTrendData(runs, []);

    expect(data.mostRetriedStates).toEqual([]);
  });

  test("counts lookback as the number of runs provided", () => {
    const data = extractTrendData(FIVE_RUNS, []);
    expect(data.lookbackCount).toBe(5);
  });

  test("builds recurring violations from reviews", () => {
    const emptyScore = {
      conventions: { passed: 0, total: 0 },
      opinions: { passed: 0, total: 0 },
      rules: { passed: 0, total: 0 },
    };
    const reviews = [
      {
        files: [],
        honored: [],
        review_id: "rev-1",
        score: emptyScore,
        timestamp: "2026-01-10T00:00:00.000Z",
        verdict: "BLOCKING" as const,
        violations: [
          { principle_id: "deep-modules", severity: "rule" },
          { principle_id: "no-llm-calls", severity: "strong-opinion" },
        ],
      },
      {
        files: [],
        honored: [],
        review_id: "rev-2",
        score: emptyScore,
        timestamp: "2026-01-15T00:00:00.000Z",
        verdict: "BLOCKING" as const,
        violations: [{ principle_id: "deep-modules", severity: "rule" }],
      },
    ];

    const data = extractTrendData(FIVE_RUNS, reviews);

    // deep-modules appears twice (recurring)
    expect(data.recurringViolations.length).toBeGreaterThan(0);
    const deepModules = data.recurringViolations.find((v) => v.principle_id === "deep-modules");
    expect(deepModules).toBeDefined();
    expect(deepModules?.occurrence_count).toBe(2);
  });
});

// ---- formatTrendMarkdown ----

describe("formatTrendMarkdown", () => {
  const baseTrendData = {
    generatedAt: "2026-01-15T12:00:00.000Z",
    lookbackCount: 5,
    mostRetriedStates: [
      { buildsAffected: 3, state: "implement", totalIterations: 6 },
      { buildsAffected: 2, state: "review", totalIterations: 3 },
    ],
    recurringViolations: [
      {
        affected_files: [],
        first_seen: "2026-01-10T00:00:00.000Z",
        last_seen: "2026-01-15T00:00:00.000Z",
        occurrence_count: 2,
        principle_id: "deep-modules",
        severity: "rule",
      },
    ],
    tierDistribution: {
      avgDurationMsByTier: { large: 7200000, medium: 2400000, small: 600000 },
      large: 1,
      medium: 3,
      small: 1,
    },
  };

  test("output contains all three required section headers", () => {
    const md = formatTrendMarkdown(baseTrendData);

    expect(md).toContain("## Recurring Violations");
    expect(md).toContain("## Tier Distribution");
    expect(md).toContain("## Most-Retried States");
  });

  test("output is under 100 lines", () => {
    const md = formatTrendMarkdown(baseTrendData);
    const lineCount = md.split("\n").length;
    expect(lineCount).toBeLessThan(100);
  });

  test("includes correct tier counts in Tier Distribution section", () => {
    const md = formatTrendMarkdown(baseTrendData);

    expect(md).toContain("| small |");
    expect(md).toContain("| medium |");
    expect(md).toContain("| large |");
    // Check counts appear
    expect(md).toMatch(/small.*1/s);
    expect(md).toMatch(/medium.*3/s);
    expect(md).toMatch(/large.*1/s);
  });

  test("includes most-retried states sorted by total iterations", () => {
    const md = formatTrendMarkdown(baseTrendData);

    const implementIdx = md.indexOf("implement");
    const reviewIdx = md.indexOf("review");
    expect(implementIdx).toBeLessThan(reviewIdx);
    expect(md).toContain("6"); // implement total iterations
    expect(md).toContain("3"); // review total iterations
  });

  test("includes recurring violations with principle_id", () => {
    const md = formatTrendMarkdown(baseTrendData);
    expect(md).toContain("deep-modules");
    expect(md).toContain("2"); // occurrence count
  });

  test("shows 'No violations found' when recurringViolations is empty", () => {
    const data = { ...baseTrendData, recurringViolations: [] };
    const md = formatTrendMarkdown(data);
    expect(md).toContain("No violations found");
  });

  test("shows 'No retried states found' when mostRetriedStates is empty", () => {
    const data = { ...baseTrendData, mostRetriedStates: [] };
    const md = formatTrendMarkdown(data);
    expect(md).toContain("No retried states found");
  });

  test("formats duration in minutes for tier distribution", () => {
    const md = formatTrendMarkdown(baseTrendData);
    // 600000ms = 10m, 2400000ms = 40m, 7200000ms = 120m
    expect(md).toMatch(/10m/);
    expect(md).toMatch(/40m/);
  });
});

// ---- tryWriteBuildTrendSummary ----

describe("tryWriteBuildTrendSummary", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "canon-trend-ws-"));
    mockGetAllFlowRuns.mockReturnValue(FIVE_RUNS);
    mockGetReviews.mockReturnValue([]);
  });

  afterEach(async () => {
    await rm(workspace, { force: true, recursive: true });
    vi.clearAllMocks();
  });

  test("writes build-trend-summary.md to workspace when >= 5 flow runs exist", async () => {
    const result = await tryWriteBuildTrendSummary(workspace);

    expect(result).toBe(true);
    const summaryPath = join(workspace, "build-trend-summary.md");
    expect(existsSync(summaryPath)).toBe(true);
    const content = await readFile(summaryPath, "utf-8");
    expect(content).toContain("# Build Trend Summary");
  });

  test("written file contains all three sections", async () => {
    await tryWriteBuildTrendSummary(workspace);

    const content = await readFile(join(workspace, "build-trend-summary.md"), "utf-8");
    expect(content).toContain("## Recurring Violations");
    expect(content).toContain("## Tier Distribution");
    expect(content).toContain("## Most-Retried States");
  });

  test("written file is under 100 lines", async () => {
    await tryWriteBuildTrendSummary(workspace);

    const content = await readFile(join(workspace, "build-trend-summary.md"), "utf-8");
    const lineCount = content.split("\n").length;
    expect(lineCount).toBeLessThan(100);
  });

  test("returns true without writing file when fewer than 5 flow runs exist", async () => {
    mockGetAllFlowRuns.mockReturnValue(FIVE_RUNS.slice(0, 4));

    const result = await tryWriteBuildTrendSummary(workspace);

    expect(result).toBe(true);
    const summaryPath = join(workspace, "build-trend-summary.md");
    expect(existsSync(summaryPath)).toBe(false);
  });

  test("returns false (never throws) when DB access fails", async () => {
    mockGetAllFlowRuns.mockImplementation(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());
    const result = await tryWriteBuildTrendSummary(workspace);
    expect(result).toBe(false);
    warnSpy.mockRestore();
  });

  test("includes correct tier distribution counts in written file", async () => {
    mockGetAllFlowRuns.mockReturnValue([
      makeFlowRun({ tier: "small" }),
      makeFlowRun({ tier: "small" }),
      makeFlowRun({ tier: "medium" }),
      makeFlowRun({ tier: "large" }),
      makeFlowRun({ tier: "large" }),
    ]);

    await tryWriteBuildTrendSummary(workspace);

    const content = await readFile(join(workspace, "build-trend-summary.md"), "utf-8");
    // small: 2, medium: 1, large: 2
    expect(content).toMatch(/small.*2/s);
    expect(content).toMatch(/medium.*1/s);
    expect(content).toMatch(/large.*2/s);
  });

  test("includes most-retried states sorted by total iterations descending", async () => {
    mockGetAllFlowRuns.mockReturnValue([
      makeFlowRun({ state_iterations: { design: 5 } }),
      makeFlowRun({ state_iterations: { implement: 2, review: 1 } }),
      makeFlowRun({ state_iterations: { implement: 3 } }),
      makeFlowRun({ state_iterations: { review: 2 } }),
      makeFlowRun({ state_iterations: { implement: 1 } }),
    ]);

    await tryWriteBuildTrendSummary(workspace);

    const content = await readFile(join(workspace, "build-trend-summary.md"), "utf-8");
    const implementIdx = content.indexOf("implement");
    const designIdx = content.indexOf("design");
    // design: 5 total; implement: 6 total — implement should appear first
    // implement(6) > design(5) > review(3)
    expect(implementIdx).toBeLessThan(designIdx);
  });
});
