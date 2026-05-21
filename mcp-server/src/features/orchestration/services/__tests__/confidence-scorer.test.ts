/**
 * confidence-scorer — unit tests.
 *
 * Tests cover:
 *  1. All-clean signals return autonomous tier (score >= 80)
 *  2. High blast radius (>50) returns supervised tier
 *  3. Security files always return supervised regardless of other signals
 *  4. override_tier short-circuits scoring
 *  5. Insufficient build history (<5 runs) penalizes score
 *  6. Medium signals return light-touch tier (score 40-79)
 *  7. gatherSignals returns correct ConfidenceSignals shape (mocked DriftDbAdapter + graphQuery)
 *  8. Security file pattern matching — positive + negative cases
 *  9. Boundary: score exactly at 80 → autonomous
 * 10. Boundary: score exactly at 40 → light-touch
 * 11. Boundary: score below 40 → supervised
 * 12. avg_retry_count penalty capped at 20 points
 *
 * Mock strategy:
 *  - confidence-scorer.ts no longer imports drift-db directly; DriftDbAdapter is passed in
 *  - Mock `@features/knowledge-graph/tools/graph-query.ts` to control graphQuery
 *  - computeConfidence is pure: no mocks needed
 *  - gatherSignals tests pass a mock DriftDbAdapter as the third argument
 *  - vi.mock factories must not reference outer variables (hoisting constraint)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- Module mocks (before imports) ----
// vi.mock is hoisted before variable declarations. Factories must use only
// vi.fn() inline — no references to outer let/const variables.

vi.mock("@features/knowledge-graph/tools/graph-query.ts", () => ({
  graphQuery: vi.fn(() => ({ count: 0, ok: true, query_type: "blast_radius", results: [] })),
}));

import { graphQuery } from "@features/knowledge-graph/tools/graph-query.ts";

// Import subject under test
import type { ConfidenceSignals, DriftDbAdapter } from "../confidence-scorer.ts";
import { computeConfidence, gatherSignals, hasSecurityFiles } from "../confidence-scorer.ts";

// ---- Helpers ----

function makeCleanSignals(overrides: Partial<ConfidenceSignals> = {}): ConfidenceSignals {
  return {
    blast_radius: { max_depth: 1, total_affected_files: 3 },
    build_history: {
      avg_retry_count: 0,
      clean_review_rate: 1.0,
      recent_failure_rate: 0,
      recent_runs: 10,
    },
    compliance: {
      has_clean_streak: true,
      max_violation_streak: 0,
      total_active_violations: 0,
    },
    file_paths: ["src/foo.ts"],
    has_security_files: false,
    ...overrides,
  };
}

// ---- computeConfidence tests ----

describe("computeConfidence", () => {
  it("all-clean signals return autonomous tier with score >= 80", () => {
    const result = computeConfidence(makeCleanSignals());
    expect(result.tier).toBe("autonomous");
    expect(result.score).toBeGreaterThanOrEqual(80);
    expect(result.signals_used).toEqual(["baseline"]);
  });

  it("high blast radius (>50 files) with poor history returns supervised tier", () => {
    const result = computeConfidence(
      makeCleanSignals({
        blast_radius: { max_depth: 4, total_affected_files: 51 },
        build_history: {
          avg_retry_count: 3,
          clean_review_rate: 0.3,
          recent_failure_rate: 0.5,
          recent_runs: 10,
        },
      }),
    );
    expect(result.tier).toBe("supervised");
    expect(result.score).toBeLessThan(40);
    expect(result.signals_used).toContain("blast_radius.total_affected_files");
  });

  it("security files always return supervised regardless of other signals", () => {
    // Even with perfect build history and zero blast radius
    const result = computeConfidence(
      makeCleanSignals({
        has_security_files: true,
      }),
    );
    expect(result.tier).toBe("supervised");
    expect(result.score).toBe(0);
    expect(result.signals_used).toEqual(["has_security_files"]);
    expect(result.reasoning).toContain("security-sensitive");
  });

  it("override_tier short-circuits scoring and returns the forced tier", () => {
    const resultSupervised = computeConfidence(makeCleanSignals({ override_tier: "supervised" }));
    expect(resultSupervised.tier).toBe("supervised");
    expect(resultSupervised.score).toBe(-1);
    expect(resultSupervised.signals_used).toEqual(["override_tier"]);
    expect(resultSupervised.reasoning).toContain("user override");

    // Override takes effect even over terrible signals
    const resultAutonomous = computeConfidence(
      makeCleanSignals({
        blast_radius: { max_depth: 4, total_affected_files: 100 },
        has_security_files: false,
        override_tier: "autonomous",
      }),
    );
    expect(resultAutonomous.tier).toBe("autonomous");
    expect(resultAutonomous.score).toBe(-1);
  });

  it("insufficient build history (<5 runs) penalizes score by 30 points", () => {
    const baseline = computeConfidence(makeCleanSignals());
    const insufficient = computeConfidence(
      makeCleanSignals({
        build_history: {
          avg_retry_count: 0,
          clean_review_rate: 1.0,
          recent_failure_rate: 0,
          recent_runs: 3, // < 5
        },
      }),
    );
    expect(insufficient.score).toBeLessThan(baseline.score);
    expect(baseline.score - insufficient.score).toBe(30);
    expect(insufficient.signals_used).toContain("build_history.recent_runs");
  });

  it("medium signals return light-touch tier (40 <= score < 80)", () => {
    // Moderate blast radius + some failures → light-touch
    // score = 100 - 20 (blast 21-50) - 9 (0.3*30) - 3 (0.3*10) = 68
    const result = computeConfidence(
      makeCleanSignals({
        blast_radius: { max_depth: 2, total_affected_files: 25 }, // -20
        build_history: {
          avg_retry_count: 0,
          clean_review_rate: 0.7, // -9
          recent_failure_rate: 0.3, // -3
          recent_runs: 8,
        },
      }),
    );
    expect(result.tier).toBe("light-touch");
    expect(result.score).toBeGreaterThanOrEqual(40);
    expect(result.score).toBeLessThan(80);
  });

  it("boundary: score exactly 80 → autonomous tier", () => {
    // Start at 100, subtract 20 (blast_radius 21-50)
    // Result: 80 → autonomous
    const result = computeConfidence(
      makeCleanSignals({
        blast_radius: { max_depth: 1, total_affected_files: 21 }, // -20
      }),
    );
    expect(result.score).toBe(80);
    expect(result.tier).toBe("autonomous");
  });

  it("boundary: score exactly 40 → light-touch tier", () => {
    // 100 - 30 (blast radius > 50) - 30 (clean_review_rate = 0) = 40
    const result = computeConfidence(
      makeCleanSignals({
        blast_radius: { max_depth: 1, total_affected_files: 51 }, // -30
        build_history: {
          avg_retry_count: 0,
          clean_review_rate: 0, // -30
          recent_failure_rate: 0,
          recent_runs: 8,
        },
      }),
    );
    expect(result.score).toBe(40);
    expect(result.tier).toBe("light-touch");
  });

  it("boundary: score below 40 → supervised tier", () => {
    // 100 - 30 (blast radius > 50) - 30 (clean_review_rate = 0) - 10 (failure_rate = 1.0) = 30
    const result = computeConfidence(
      makeCleanSignals({
        blast_radius: { max_depth: 1, total_affected_files: 51 }, // -30
        build_history: {
          avg_retry_count: 0,
          clean_review_rate: 0, // -30
          recent_failure_rate: 1.0, // -10
          recent_runs: 8,
        },
      }),
    );
    expect(result.score).toBe(30);
    expect(result.tier).toBe("supervised");
  });

  it("avg_retry_count penalty is capped at 20 points", () => {
    // avg_retry_count = 10 would be 50 pts without cap, capped at 20
    const withHighRetry = computeConfidence(
      makeCleanSignals({
        build_history: {
          avg_retry_count: 10,
          clean_review_rate: 1.0,
          recent_failure_rate: 0,
          recent_runs: 10,
        },
      }),
    );
    // avg_retry_count = 4 → 4 * 5 = 20 (exactly at cap)
    const withModerateRetry = computeConfidence(
      makeCleanSignals({
        build_history: {
          avg_retry_count: 4,
          clean_review_rate: 1.0,
          recent_failure_rate: 0,
          recent_runs: 10,
        },
      }),
    );
    // Both should be penalized 20 points (the cap)
    expect(withHighRetry.score).toBe(withModerateRetry.score);
    expect(withHighRetry.score).toBe(80); // 100 - 20
    expect(withHighRetry.signals_used).toContain("build_history.avg_retry_count");
  });
});

// ---- hasSecurityFiles tests ----

describe("hasSecurityFiles", () => {
  it("matches principles/ path (positive); NOT src/features/principles (negative)", () => {
    expect(hasSecurityFiles(["principles/my-principle.md"])).toBe(true);
    expect(hasSecurityFiles(["src/features/principles/tool.ts"])).toBe(false);
  });

  it("matches rules/ path", () => {
    expect(hasSecurityFiles(["rules/agent-budget.md"])).toBe(true);
  });

  it("matches hooks/ path; NOT src/hooks-utils.ts", () => {
    expect(hasSecurityFiles(["hooks/pre-commit.sh"])).toBe(true);
    expect(hasSecurityFiles(["src/hooks-utils.ts"])).toBe(false);
  });

  it("matches .canon/config.json exactly; NOT other config files", () => {
    expect(hasSecurityFiles([".canon/config.json"])).toBe(true);
    expect(hasSecurityFiles([".canon/config-backup.json"])).toBe(false);
    expect(hasSecurityFiles(["src/config.json"])).toBe(false);
  });

  it("returns false for ordinary source files", () => {
    expect(
      hasSecurityFiles([
        "src/foo.ts",
        "mcp-server/src/features/orchestration/services/confidence-scorer.ts",
        "templates/prd.md",
      ]),
    ).toBe(false);
  });

  it("returns true when any file in the list matches", () => {
    expect(hasSecurityFiles(["src/foo.ts", "hooks/pre-commit.sh"])).toBe(true);
  });

  it("returns false for empty file list", () => {
    expect(hasSecurityFiles([])).toBe(false);
  });
});

// ---- DriftDbAdapter mock factory ----

function makeMockDriftDb(overrides?: {
  flowRuns?: Array<{ state_iterations: unknown; gate_pass_rate: number | null | undefined }>;
  violationHistory?: unknown[];
  pathEffects?: Array<{ violation_streak: number; clean_streak: number }>;
}): DriftDbAdapter {
  return {
    getAllFlowRuns: vi.fn(() => overrides?.flowRuns ?? []),
    getSignals: vi.fn(() => ({
      getFileViolationHistory: vi.fn(() => overrides?.violationHistory ?? []),
      getPathEffects: vi.fn(() => overrides?.pathEffects ?? []),
    })),
  };
}

// ---- gatherSignals tests ----

describe("gatherSignals", () => {
  beforeEach(() => {
    vi.mocked(graphQuery).mockReturnValue({
      count: 0,
      ok: true,
      query_type: "blast_radius",
      results: [],
    } as ReturnType<typeof graphQuery>);
  });

  it("returns ConfidenceSignals shape with correct file_paths", async () => {
    const mockDb = makeMockDriftDb();
    const result = await gatherSignals(["src/foo.ts", "src/bar.ts"], "/mock/project", mockDb);

    expect(result.file_paths).toEqual(["src/foo.ts", "src/bar.ts"]);
    expect(typeof result.build_history.recent_runs).toBe("number");
    expect(typeof result.build_history.clean_review_rate).toBe("number");
    expect(typeof result.blast_radius.total_affected_files).toBe("number");
    expect(typeof result.compliance.total_active_violations).toBe("number");
    expect(typeof result.has_security_files).toBe("boolean");
  });

  it("sets has_security_files based on file path patterns", async () => {
    const mockDb = makeMockDriftDb();
    const resultSafe = await gatherSignals(["src/foo.ts"], "/mock/project", mockDb);
    expect(resultSafe.has_security_files).toBe(false);

    const resultSecurity = await gatherSignals(["hooks/pre-commit.sh"], "/mock/project", mockDb);
    expect(resultSecurity.has_security_files).toBe(true);
  });

  it("aggregates blast radius total and max depth from graphQuery results", async () => {
    vi.mocked(graphQuery).mockReturnValue({
      count: 15,
      ok: true,
      query_type: "blast_radius",
      results: [
        { depth: 3, file_path: "a.ts" },
        { depth: 2, file_path: "b.ts" },
      ],
    } as ReturnType<typeof graphQuery>);

    const mockDb = makeMockDriftDb();
    const result = await gatherSignals(["src/foo.ts"], "/mock/project", mockDb);
    expect(result.blast_radius.total_affected_files).toBe(15);
    expect(result.blast_radius.max_depth).toBe(3);
  });

  it("uses worst-case defaults when driftDb is not provided", async () => {
    // No driftDb argument — drift-dependent signals stay at worst-case defaults
    const result = await gatherSignals(["src/foo.ts"], "/mock/project");

    // Worst-case defaults: clean_review_rate=0, recent_failure_rate=1, recent_runs=0, avg_retry_count=4
    expect(result.build_history.recent_runs).toBe(0);
    expect(result.build_history.clean_review_rate).toBe(0);
    expect(result.build_history.recent_failure_rate).toBe(1);
    expect(result.build_history.avg_retry_count).toBe(4);
    // Compliance also worst-case when driftDb absent
    expect(result.compliance.max_violation_streak).toBe(10);
    expect(result.compliance.total_active_violations).toBe(10);
    expect(result.compliance.has_clean_streak).toBe(false);
  });

  it("uses worst-case defaults when driftDb.getAllFlowRuns throws", async () => {
    const failingDb: DriftDbAdapter = {
      getAllFlowRuns: vi.fn(() => {
        throw new Error("SQLITE_CANTOPEN");
      }),
      getSignals: vi.fn(() => ({
        getFileViolationHistory: vi.fn(() => []),
        getPathEffects: vi.fn(() => []),
      })),
    };

    const result = await gatherSignals(["src/foo.ts"], "/mock/project", failingDb);

    // Worst-case defaults preserved after error — avg_retry_count is penalizing, not zero
    expect(result.build_history.recent_runs).toBe(0);
    expect(result.build_history.clean_review_rate).toBe(0);
    expect(result.build_history.recent_failure_rate).toBe(1);
    expect(result.build_history.avg_retry_count).toBe(4);
  });

  it("uses worst-case compliance defaults when getSignals throws", async () => {
    const failingComplianceDb: DriftDbAdapter = {
      getAllFlowRuns: vi.fn(() => []),
      getSignals: vi.fn(() => {
        throw new Error("signals_unavailable");
      }),
    };

    const result = await gatherSignals(["src/foo.ts"], "/mock/project", failingComplianceDb);

    // Compliance failure must produce penalizing values, not optimistic zeros
    expect(result.compliance.max_violation_streak).toBe(10);
    expect(result.compliance.total_active_violations).toBe(10);
    expect(result.compliance.has_clean_streak).toBe(false);
  });

  it("counts only actual retries (state_iterations - 1), not baseline attempts", async () => {
    // 3 runs, each with 2 states. First run: both states ran once (no retries).
    // Second run: one state retried once → 1 actual retry.
    // Third run: one state retried twice → 2 actual retries.
    // total actual retries = 0 + 1 + 2 = 3; avg = 3 / 3 = 1.0
    const db = makeMockDriftDb({
      flowRuns: [
        { gate_pass_rate: 1.0, state_iterations: { implement: 1, verify: 1 } },
        { gate_pass_rate: 1.0, state_iterations: { implement: 2, verify: 1 } },
        { gate_pass_rate: 1.0, state_iterations: { implement: 3, verify: 1 } },
      ],
    });

    const result = await gatherSignals(["src/foo.ts"], "/mock/project", db);
    expect(result.build_history.avg_retry_count).toBeCloseTo(1.0, 5);
  });

  it("clean build (all state_iterations=1) yields avg_retry_count of 0", async () => {
    // A perfectly clean 5-step build — no state ever retried
    const db = makeMockDriftDb({
      flowRuns: [
        {
          gate_pass_rate: 1.0,
          state_iterations: { implement: 1, learn: 1, review: 1, ship: 1, verify: 1 },
        },
      ],
    });

    const result = await gatherSignals(["src/foo.ts"], "/mock/project", db);
    expect(result.build_history.avg_retry_count).toBe(0);
  });
});
