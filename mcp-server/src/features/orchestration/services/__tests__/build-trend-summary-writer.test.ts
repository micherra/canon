/**
 * build-trend-summary-writer — unit tests.
 *
 * Tests pure functions (computeRecurringViolations, computeTierDistribution,
 * computeMostRetriedStates, formatTrendSummary) and the integration entry point
 * (tryWriteBuildTrendSummary).
 *
 * Mock strategy:
 *  - Mock `@app/server-state.ts` to control projectDir
 *  - Mock `@platform/storage/drift/drift-db.ts` to inject controlled DriftDb responses
 *  - Use real temp dirs for filesystem tests
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewEntry } from "@shared/schema.ts";
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
  computeMostRetriedStates,
  computeRecurringViolations,
  computeTierDistribution,
  formatTrendSummary,
  tryWriteBuildTrendSummary,
} from "../build-trend-summary-writer.ts";

// ---- Fixtures ----

function makeFlowRun(overrides: Partial<FlowRunEntry> = {}): FlowRunEntry {
  return {
    completed: "2026-01-15T11:00:00.000Z",
    flow: "feature",
    run_id: `run_${Math.random().toString(36).slice(2, 8)}`,
    skipped_states: [],
    started: "2026-01-15T10:00:00.000Z",
    state_durations: {},
    state_iterations: {},
    task: "Build something",
    tier: "medium",
    total_duration_ms: 3600000,
    total_spawns: 5,
    ...overrides,
  };
}

function makeReview(overrides: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    files: ["src/foo.ts"],
    honored: [],
    review_id: `rev_${Math.random().toString(36).slice(2, 8)}`,
    score: {
      conventions: { passed: 0, total: 0 },
      opinions: { passed: 1, total: 1 },
      rules: { passed: 1, total: 1 },
    },
    timestamp: new Date().toISOString(),
    verdict: "CLEAN",
    violations: [],
    ...overrides,
  };
}

// 5 minimal flow runs to satisfy the >= 5 threshold
const FIVE_RUNS: FlowRunEntry[] = [
  makeFlowRun({ tier: "small", total_duration_ms: 1800000 }),
  makeFlowRun({ tier: "medium", total_duration_ms: 3600000 }),
  makeFlowRun({ tier: "medium", total_duration_ms: 7200000 }),
  makeFlowRun({ tier: "large", total_duration_ms: 10800000 }),
  makeFlowRun({ tier: "large", total_duration_ms: 14400000 }),
];

// ---- computeRecurringViolations ----

describe("computeRecurringViolations", () => {
  test("returns empty array when no violations exist", () => {
    const reviews = [makeReview(), makeReview()];
    expect(computeRecurringViolations(reviews)).toEqual([]);
  });

  test("returns empty array when violations appear only once each", () => {
    const reviews = [
      makeReview({ violations: [{ principle_id: "deep-modules", severity: "rule" }] }),
      makeReview({ violations: [{ principle_id: "no-magic-numbers", severity: "convention" }] }),
    ];
    expect(computeRecurringViolations(reviews)).toEqual([]);
  });

  test("returns violations appearing in 2+ reviews", () => {
    const reviews = [
      makeReview({ violations: [{ principle_id: "deep-modules", severity: "rule" }] }),
      makeReview({ violations: [{ principle_id: "deep-modules", severity: "rule" }] }),
      makeReview({ violations: [{ principle_id: "no-magic-numbers", severity: "convention" }] }),
    ];
    const result = computeRecurringViolations(reviews);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ count: 2, principle_id: "deep-modules" });
  });

  test("sorts by count descending", () => {
    const reviews = [
      makeReview({
        violations: [
          { principle_id: "a", severity: "rule" },
          { principle_id: "b", severity: "rule" },
        ],
      }),
      makeReview({
        violations: [
          { principle_id: "a", severity: "rule" },
          { principle_id: "b", severity: "rule" },
        ],
      }),
      makeReview({ violations: [{ principle_id: "b", severity: "rule" }] }),
    ];
    const result = computeRecurringViolations(reviews);
    // b appears 3 times, a appears 2 times
    expect(result[0].principle_id).toBe("b");
    expect(result[0].count).toBe(3);
    expect(result[1].principle_id).toBe("a");
    expect(result[1].count).toBe(2);
  });

  test("handles reviews with no violations array", () => {
    const reviews = [makeReview({ violations: undefined }), makeReview({ violations: [] })];
    expect(computeRecurringViolations(reviews)).toEqual([]);
  });
});

// ---- computeTierDistribution ----

describe("computeTierDistribution", () => {
  test("returns empty array for empty input", () => {
    expect(computeTierDistribution([])).toEqual([]);
  });

  test("counts runs per tier correctly", () => {
    const runs = [
      makeFlowRun({ tier: "small" }),
      makeFlowRun({ tier: "medium" }),
      makeFlowRun({ tier: "medium" }),
      makeFlowRun({ tier: "large" }),
    ];
    const result = computeTierDistribution(runs);
    const medium = result.find((t) => t.tier === "medium");
    expect(medium?.count).toBe(2);
    const small = result.find((t) => t.tier === "small");
    expect(small?.count).toBe(1);
  });

  test("sorts by count descending", () => {
    const runs = FIVE_RUNS;
    const result = computeTierDistribution(runs);
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].count).toBeGreaterThanOrEqual(result[i + 1].count);
    }
  });

  test("computes avg duration correctly", () => {
    const runs = [
      makeFlowRun({ tier: "medium", total_duration_ms: 3600000 }),
      makeFlowRun({ tier: "medium", total_duration_ms: 7200000 }),
    ];
    const result = computeTierDistribution(runs);
    const medium = result.find((t) => t.tier === "medium");
    expect(medium?.avg_duration_ms).toBe(5400000); // (3600000 + 7200000) / 2
  });

  test("returns null avg_duration_ms when no runs have duration", () => {
    const runs = [makeFlowRun({ tier: "small", total_duration_ms: 0 })];
    const result = computeTierDistribution(runs);
    const small = result.find((t) => t.tier === "small");
    expect(small?.avg_duration_ms).toBeNull();
  });

  test("uses 'unknown' tier when tier field is empty", () => {
    const runs = [makeFlowRun({ tier: "" })];
    const result = computeTierDistribution(runs);
    expect(result[0].tier).toBe("unknown");
  });
});

// ---- computeMostRetriedStates ----

describe("computeMostRetriedStates", () => {
  test("returns empty array for empty input", () => {
    expect(computeMostRetriedStates([])).toEqual([]);
  });

  test("returns empty array when no states have multiple iterations", () => {
    const runs = [makeFlowRun({ state_iterations: { implement: 1, review: 1 } })];
    expect(computeMostRetriedStates(runs)).toEqual([]);
  });

  test("aggregates iterations across runs", () => {
    const runs = [
      makeFlowRun({ state_iterations: { fix: 3, review: 2 } }),
      makeFlowRun({ state_iterations: { fix: 2 } }),
    ];
    const result = computeMostRetriedStates(runs);
    const fix = result.find((s) => s.state === "fix");
    expect(fix?.total_iterations).toBe(5);
  });

  test("sorts by total iterations descending", () => {
    const runs = [makeFlowRun({ state_iterations: { fix: 5, implement: 4, review: 3 } })];
    const result = computeMostRetriedStates(runs);
    for (let i = 0; i < result.length - 1; i++) {
      expect(result[i].total_iterations).toBeGreaterThanOrEqual(result[i + 1].total_iterations);
    }
  });

  test("limits to top 5 states", () => {
    const stateIterations: Record<string, number> = {};
    for (let i = 0; i < 10; i++) {
      stateIterations[`state_${i}`] = i + 2; // All > 1
    }
    const runs = [makeFlowRun({ state_iterations: stateIterations })];
    const result = computeMostRetriedStates(runs);
    expect(result.length).toBeLessThanOrEqual(5);
  });
});

// ---- formatTrendSummary ----

describe("formatTrendSummary", () => {
  const baseData = {
    mostRetriedStates: [{ state: "fix", total_iterations: 5 }],
    recurringViolations: [{ count: 3, principle_id: "deep-modules" }],
    runCount: 10,
    tierDistribution: [
      { avg_duration_ms: 3600000, count: 5, tier: "medium" },
      { avg_duration_ms: 1800000, count: 3, tier: "small" },
    ],
  };

  test("output is under 100 lines", () => {
    const md = formatTrendSummary(baseData);
    const lines = md.split("\n");
    expect(lines.length).toBeLessThan(100);
  });

  test("contains all three section headings", () => {
    const md = formatTrendSummary(baseData);
    expect(md).toContain("## Recurring Violations");
    expect(md).toContain("## Tier Distribution");
    expect(md).toContain("## Most-Retried States");
  });

  test("contains principle_id in recurring violations", () => {
    const md = formatTrendSummary(baseData);
    expect(md).toContain("deep-modules");
    expect(md).toContain("3");
  });

  test("contains tier names and run counts", () => {
    const md = formatTrendSummary(baseData);
    expect(md).toContain("medium");
    expect(md).toContain("small");
  });

  test("contains most-retried state name", () => {
    const md = formatTrendSummary(baseData);
    expect(md).toContain("fix");
    expect(md).toContain("5");
  });

  test("shows 'no recurring violations' message when none", () => {
    const data = { ...baseData, recurringViolations: [] };
    const md = formatTrendSummary(data);
    expect(md).toContain("No recurring violations");
  });

  test("shows 'no states' message when mostRetriedStates is empty", () => {
    const data = { ...baseData, mostRetriedStates: [] };
    const md = formatTrendSummary(data);
    expect(md).toContain("No states with multiple iterations");
  });
});

// ---- tryWriteBuildTrendSummary ----

describe("tryWriteBuildTrendSummary", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "canon-trend-ws-"));
    mockGetAllFlowRuns.mockReset();
    mockGetReviews.mockReset();
  });

  afterEach(async () => {
    await rm(workspace, { force: true, recursive: true });
  });

  test("returns true (graceful skip) when fewer than 5 runs exist", async () => {
    mockGetAllFlowRuns.mockReturnValue([makeFlowRun(), makeFlowRun(), makeFlowRun()]);
    const result = await tryWriteBuildTrendSummary(workspace);
    expect(result).toBe(true);
    // No file written
    await expect(readFile(join(workspace, "build-trend-summary.md"), "utf-8")).rejects.toThrow();
  });

  test("returns true and writes file when >= 5 runs exist", async () => {
    mockGetAllFlowRuns.mockReturnValue(FIVE_RUNS);
    mockGetReviews.mockReturnValue([]);
    const result = await tryWriteBuildTrendSummary(workspace);
    expect(result).toBe(true);
    const content = await readFile(join(workspace, "build-trend-summary.md"), "utf-8");
    expect(content).toContain("Build Trend Summary");
  });

  test("written file contains correct section headings", async () => {
    mockGetAllFlowRuns.mockReturnValue(FIVE_RUNS);
    mockGetReviews.mockReturnValue([]);
    await tryWriteBuildTrendSummary(workspace);
    const content = await readFile(join(workspace, "build-trend-summary.md"), "utf-8");
    expect(content).toContain("## Recurring Violations");
    expect(content).toContain("## Tier Distribution");
    expect(content).toContain("## Most-Retried States");
  });

  test("output file is under 100 lines", async () => {
    const manyRuns = Array.from({ length: 10 }, (_, i) =>
      makeFlowRun({
        state_iterations: { fix: i + 2, review: i + 2 },
        tier: i % 2 === 0 ? "small" : "large",
      }),
    );
    const reviews = [
      makeReview({ violations: [{ principle_id: "deep-modules", severity: "rule" }] }),
      makeReview({ violations: [{ principle_id: "deep-modules", severity: "rule" }] }),
    ];
    mockGetAllFlowRuns.mockReturnValue(manyRuns);
    mockGetReviews.mockReturnValue(reviews);
    await tryWriteBuildTrendSummary(workspace);
    const content = await readFile(join(workspace, "build-trend-summary.md"), "utf-8");
    const lines = content.split("\n");
    expect(lines.length).toBeLessThan(100);
  });

  test("returns false (never throws) when getDriftDb throws", async () => {
    const { getDriftDb } = await import("@platform/storage/drift/drift-db.ts");
    vi.mocked(getDriftDb).mockImplementationOnce(() => {
      throw new Error("DB connection failed");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());
    const result = await tryWriteBuildTrendSummary(workspace);
    expect(result).toBe(false);
    warnSpy.mockRestore();
  });

  test("returns false when getAllFlowRuns throws", async () => {
    mockGetAllFlowRuns.mockImplementation(() => {
      throw new Error("query failed");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(vi.fn());
    const result = await tryWriteBuildTrendSummary(workspace);
    expect(result).toBe(false);
    warnSpy.mockRestore();
  });

  test("correct tier distribution counts appear in output", async () => {
    const runs = [
      ...Array.from({ length: 3 }, () => makeFlowRun({ tier: "large" })),
      ...Array.from({ length: 2 }, () => makeFlowRun({ tier: "small" })),
    ];
    mockGetAllFlowRuns.mockReturnValue(runs);
    mockGetReviews.mockReturnValue([]);
    await tryWriteBuildTrendSummary(workspace);
    const content = await readFile(join(workspace, "build-trend-summary.md"), "utf-8");
    expect(content).toContain("large");
    expect(content).toContain("small");
    // 3 large runs should appear before 2 small (sorted desc)
    const largeIdx = content.indexOf("large");
    const smallIdx = content.indexOf("small");
    expect(largeIdx).toBeLessThan(smallIdx);
  });

  test("most-retried states sorted by total iterations desc", async () => {
    const runs = [
      makeFlowRun({ state_iterations: { fix: 10, implement: 2 } }),
      makeFlowRun({ state_iterations: { fix: 5 } }),
      makeFlowRun({ state_iterations: { rebuild: 8 } }),
      makeFlowRun({ state_iterations: {} }),
      makeFlowRun({ state_iterations: {} }),
    ];
    mockGetAllFlowRuns.mockReturnValue(runs);
    mockGetReviews.mockReturnValue([]);
    await tryWriteBuildTrendSummary(workspace);
    const content = await readFile(join(workspace, "build-trend-summary.md"), "utf-8");
    // Extract just the Most-Retried States section to search within
    const sectionStart = content.indexOf("## Most-Retried States");
    expect(sectionStart).toBeGreaterThan(-1);
    const sectionContent = content.slice(sectionStart);
    // fix (15 total) should appear before rebuild (8 total) in the table
    const fixIdx = sectionContent.indexOf("fix");
    const rebuildIdx = sectionContent.indexOf("rebuild");
    expect(fixIdx).toBeLessThan(rebuildIdx);
  });
});
