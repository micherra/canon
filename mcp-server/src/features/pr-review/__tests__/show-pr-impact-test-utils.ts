/**
 * Shared test utilities for show-pr-impact test files.
 *
 * Extracted from the 8 show-pr-impact test files to reduce duplication
 * and allow merging related files without exceeding 600-line limits.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { getPrReviewData } from "../tools/pr-review-data.ts";

// ---------------------------------------------------------------------------
// Shared fixture constants
// ---------------------------------------------------------------------------

export const SHARED_SAMPLE_SCORE = {
  conventions: { passed: 1, total: 1 },
  opinions: { passed: 0, total: 1 },
  rules: { passed: 1, total: 1 },
};

export const SHARED_SAMPLE_PREP = {
  blast_radius: [],
  diff_command: "git diff main..HEAD --name-status",
  files: [],
  impact_files: [],
  incremental: false,
  layers: [],
  narrative: "No changed files.",
  net_new_files: 0,
  total_files: 0,
  total_violations: 0,
};

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal ReviewEntry-compatible object for use with DriftStore.appendReview.
 * All fields used by show-pr-impact are included; callers override what they need.
 */
export function makeSharedReview(
  overrides: Partial<{
    review_id: string;
    branch: string;
    pr_number: number;
    verdict: "BLOCKING" | "WARNING" | "CLEAN";
    files: string[];
    violations: Array<{ principle_id: string; severity: string; file_path?: string }>;
  }> = {},
) {
  return {
    branch: overrides.branch,
    files: overrides.files ?? ["src/a.ts"],
    honored: [],
    pr_number: overrides.pr_number,
    review_id: overrides.review_id ?? `rev_${Math.random().toString(36).slice(2)}`,
    score: SHARED_SAMPLE_SCORE,
    timestamp: new Date().toISOString(),
    verdict: overrides.verdict ?? ("CLEAN" as const),
    violations: overrides.violations ?? [],
  };
}

/**
 * Builds a minimal PrReviewDataOutput stub for mocking getPrReviewData.
 * Pass fileOverrides to include specific files with their status.
 */
export function makePrepStub(
  fileOverrides: Array<{ path: string; status: string; layer?: string }> = [],
) {
  return {
    blast_radius: [],
    diff_command: "git diff main",
    files: fileOverrides.map((f) => ({
      layer: f.layer ?? "tools",
      path: f.path,
      status: f.status,
    })),
    impact_files: [],
    incremental: false,
    layers: [],
    narrative: "Test narrative.",
    net_new_files: 0,
    total_files: fileOverrides.length,
    total_violations: 0,
  };
}

// ---------------------------------------------------------------------------
// beforeEach / afterEach hook factories
// ---------------------------------------------------------------------------

/**
 * Creates a standard before/after lifecycle for tests that need a tmpDir.
 * Returns a getter for tmpDir; assigns it in beforeEach.
 *
 * Usage:
 *   const getTmpDir = useTmpDir("canon-pr-my-test-");
 *   ...
 *   const result = await showPrImpact(getTmpDir());
 */
export function useTmpDir(prefix: string): () => string {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), prefix));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
    vi.restoreAllMocks();
  });

  return () => tmpDir;
}

/**
 * Standard mock reset for tests using existsSync + getPrReviewData.
 * Call in beforeEach after setting up mocks.
 */
export function resetMocksWithDefaultPrep(existsSyncMock: ReturnType<typeof vi.fn>) {
  existsSyncMock.mockReturnValue(false);
  vi.mocked(getPrReviewData).mockReset();
  vi.mocked(getPrReviewData).mockResolvedValue(SHARED_SAMPLE_PREP as never);
}
