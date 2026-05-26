/**
 * get-cross-run-analysis tool tests.
 *
 * Tests cover: empty analysis, recurring violations, planner patterns,
 * since filter, analysis_window, missing run-summary.json handling.
 * getDriftDb is mocked; real tmp directories for file I/O.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ArchiveManifestEntry } from "../../../platform/storage/drift/drift-analytics-types.ts";
import type { RunSummary } from "../history-types.ts";

// ---- Mock getDriftDb ----

const mockGetArchiveManifests =
  vi.fn<(filter?: { branch?: string; flow?: string; limit?: number }) => ArchiveManifestEntry[]>();
const mockGetReviews = vi.fn(() => []);
const mockGetAllFlowRuns = vi.fn(() => []);

vi.mock("@platform/storage/drift/drift-db.ts", () => ({
  getDriftDb: vi.fn(() => ({
    getAllFlowRuns: mockGetAllFlowRuns,
    getArchiveManifests: mockGetArchiveManifests,
    getReviews: mockGetReviews,
  })),
}));

import { getCrossRunAnalysis } from "../tools/get-cross-run-analysis.ts";

// ---- Helpers ----

let tmpDir: string;

function makeArchivePath(slug: string): string {
  const archivePath = join(tmpDir, slug);
  mkdirSync(archivePath, { recursive: true });
  return archivePath;
}

function makeArchiveEntry(
  slug: string,
  archivePath: string,
  hasSummary = true,
  overrides: Partial<ArchiveManifestEntry> = {},
): ArchiveManifestEntry {
  return {
    archive_id: `arch_${slug}`,
    archive_path: archivePath,
    archived_at: "2026-04-24T10:00:00.000Z",
    artifact_types: ["plans"],
    branch: "feat/test",
    flow: "feature",
    has_run_summary: hasSummary,
    sanitized_branch: "feat--test",
    slug,
    source_run_id: null,
    task: "test task",
    tier: "feature",
    ...overrides,
  };
}

function makeRunSummary(archiveId: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    archive_id: archiveId,
    artifact_inventory: { directories: [], files: [], total_files: 0 },
    decision_summaries: [],
    planner_context: null,
    review_results: [],
    run_metadata: {
      archived_at: "2026-04-24T10:00:00.000Z",
      branch: "feat/test",
      completed_at: "2026-04-24T10:00:00.000Z",
      flow: "feature",
      slug: archiveId,
      started_at: "2026-04-24T09:00:00.000Z",
      task: "test task",
      tier: "feature",
      total_duration_ms: 3600000,
    },
    step_outcomes: [],
    version: 1,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = join(tmpdir(), `cross-run-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(tmpDir, { recursive: true });
  vi.clearAllMocks();
  mockGetArchiveManifests.mockReturnValue([]);
  mockGetReviews.mockReturnValue([]);
  mockGetAllFlowRuns.mockReturnValue([]);
});

afterEach(() => {
  rmSync(tmpDir, { force: true, recursive: true });
});

// ---- Tests ----

describe("getCrossRunAnalysis", () => {
  test("returns empty analysis when no data exists", async () => {
    mockGetArchiveManifests.mockReturnValue([]);

    const result = await getCrossRunAnalysis({ project_dir: "/tmp/proj" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.recurring_violations).toEqual([]);
    expect(result.fix_cycle_patterns).toEqual([]);
    expect(result.agent_performance_trends).toEqual([]);
    expect(result.total_archived_runs).toBe(0);
  });

  test("returns recurring violations from run summaries", async () => {
    const archivePath1 = makeArchivePath("run-001");
    const archivePath2 = makeArchivePath("run-002");

    const summary1 = makeRunSummary("arch_run-001", {
      review_results: [
        {
          files_reviewed: 3,
          honored: [],
          principles_checked: 5,
          verdict: "needs-revision",
          violations: [
            { file_path: "src/foo.ts", message: "", principle_id: "fail-closed", severity: "rule" },
          ],
        },
      ],
      run_metadata: {
        ...makeRunSummary("x").run_metadata,
        completed_at: "2026-04-24T10:00:00.000Z",
      },
    });
    const summary2 = makeRunSummary("arch_run-002", {
      review_results: [
        {
          files_reviewed: 2,
          honored: [],
          principles_checked: 5,
          verdict: "needs-revision",
          violations: [
            { file_path: "src/bar.ts", message: "", principle_id: "fail-closed", severity: "rule" },
          ],
        },
      ],
      run_metadata: {
        ...makeRunSummary("x").run_metadata,
        completed_at: "2026-04-25T10:00:00.000Z",
      },
    });

    writeFileSync(join(archivePath1, "run-summary.json"), JSON.stringify(summary1));
    writeFileSync(join(archivePath2, "run-summary.json"), JSON.stringify(summary2));

    mockGetArchiveManifests.mockReturnValue([
      makeArchiveEntry("run-001", archivePath1),
      makeArchiveEntry("run-002", archivePath2),
    ]);

    const result = await getCrossRunAnalysis({ project_dir: "/tmp/proj" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // fail-closed appears in both runs → recurring (occurrence_count >= 2)
    expect(result.recurring_violations).toHaveLength(1);
    expect(result.recurring_violations[0].principle_id).toBe("fail-closed");
    expect(result.recurring_violations[0].occurrence_count).toBe(2);
  });

  test("returns planner pattern analysis from run summaries", async () => {
    const archivePath1 = makeArchivePath("run-planner-001");
    const summary1 = makeRunSummary("arch_run-planner-001", {
      planner_context: {
        assumptions: ["Tests pass", "No regressions"],
        effort_estimate: "medium",
        outcome: "implement feature",
        recommended_approach: "use existing patterns",
        runbook_steps: [],
        value_estimate: "high",
      },
    });
    writeFileSync(join(archivePath1, "run-summary.json"), JSON.stringify(summary1));

    mockGetArchiveManifests.mockReturnValue([makeArchiveEntry("run-planner-001", archivePath1)]);

    const result = await getCrossRunAnalysis({ project_dir: "/tmp/proj" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.planner_patterns.total_runs_with_planner).toBe(1);
    expect(result.planner_patterns.value_distribution).toHaveLength(1);
    expect(result.planner_patterns.value_distribution[0].value).toBe("high");
  });

  test("respects since filter — excludes runs archived before the cutoff", async () => {
    const archivePathOld = makeArchivePath("run-old");
    const archivePathNew = makeArchivePath("run-new");

    const oldSummary = makeRunSummary("arch_run-old", {
      run_metadata: {
        ...makeRunSummary("x").run_metadata,
        archived_at: "2026-01-01T00:00:00.000Z",
      },
    });
    const newSummary = makeRunSummary("arch_run-new", {
      run_metadata: {
        ...makeRunSummary("x").run_metadata,
        archived_at: "2026-04-24T10:00:00.000Z",
      },
    });

    writeFileSync(join(archivePathOld, "run-summary.json"), JSON.stringify(oldSummary));
    writeFileSync(join(archivePathNew, "run-summary.json"), JSON.stringify(newSummary));

    mockGetArchiveManifests.mockReturnValue([
      makeArchiveEntry("run-old", archivePathOld, true, {
        archived_at: "2026-01-01T00:00:00.000Z",
      }),
      makeArchiveEntry("run-new", archivePathNew, true, {
        archived_at: "2026-04-24T10:00:00.000Z",
      }),
    ]);

    const result = await getCrossRunAnalysis({
      project_dir: "/tmp/proj",
      since: "2026-04-01T00:00:00.000Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Only the new run passes the since filter
    expect(result.total_archived_runs).toBe(1);
  });

  test("returns correct analysis_window from summaries", async () => {
    const archivePath1 = makeArchivePath("run-window");
    const summary = makeRunSummary("arch_run-window", {
      run_metadata: {
        archived_at: "2026-04-20T12:05:00.000Z",
        branch: "feat/test",
        completed_at: "2026-04-20T12:00:00.000Z",
        flow: "feature",
        slug: "run-window",
        started_at: "2026-04-20T08:00:00.000Z",
        task: "test",
        tier: "feature",
        total_duration_ms: 14400000,
      },
    });
    writeFileSync(join(archivePath1, "run-summary.json"), JSON.stringify(summary));
    mockGetArchiveManifests.mockReturnValue([makeArchiveEntry("run-window", archivePath1)]);

    const result = await getCrossRunAnalysis({ project_dir: "/tmp/proj" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // analysis_window should include the run's timestamps
    expect(result.analysis_window.from).toBeTruthy();
    expect(result.analysis_window.to).toBeTruthy();
  });

  test("handles missing run-summary.json gracefully (skips that archive)", async () => {
    const archivePath1 = makeArchivePath("run-no-summary");
    // Do NOT write run-summary.json — archive says has_run_summary: true but file missing

    mockGetArchiveManifests.mockReturnValue([
      makeArchiveEntry("run-no-summary", archivePath1, true),
    ]);

    const result = await getCrossRunAnalysis({ project_dir: "/tmp/proj" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Gracefully skipped — no summaries loaded
    expect(result.total_archived_runs).toBe(0);
  });

  test("archives with has_run_summary: false are skipped", async () => {
    const archivePath1 = makeArchivePath("run-no-flag");
    const summary = makeRunSummary("arch_run-no-flag");
    writeFileSync(join(archivePath1, "run-summary.json"), JSON.stringify(summary));

    // Mark has_run_summary as false even though file exists
    mockGetArchiveManifests.mockReturnValue([makeArchiveEntry("run-no-flag", archivePath1, false)]);

    const result = await getCrossRunAnalysis({ project_dir: "/tmp/proj" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.total_archived_runs).toBe(0);
  });
});
