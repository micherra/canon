import { CORRECTNESS_SCAN_PRINCIPLE_ID } from "@shared/constants.ts";
import type { ReviewEntry } from "@shared/schema.ts";
import { describe, expect, it } from "vitest";
import { analyzeDrift } from "../analyzer.ts";
import { formatDriftReport } from "../reporter.ts";

function makeReview(overrides: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    files: ["src/a.ts"],
    honored: [],
    review_id: "rev_1",
    score: {
      conventions: { passed: 0, total: 0 },
      opinions: { passed: 1, total: 1 },
      rules: { passed: 1, total: 1 },
    },
    timestamp: "2026-03-15T00:00:00Z",
    verdict: "CLEAN",
    violations: [],
    ...overrides,
  };
}

describe("analyzeDrift", () => {
  it("returns empty report for no data", () => {
    const report = analyzeDrift([], ["p1", "p2"]);
    expect(report.total_reviews).toBe(0);
    expect(report.most_violated).toEqual([]);
    expect(report.never_triggered).toEqual(["p1", "p2"]);
    expect(report.trend).toBe("insufficient_data");
  });

  it("counts violations and computes compliance rate", () => {
    const reviews = [
      makeReview({
        honored: ["p2"],
        violations: [{ principle_id: "p1", severity: "rule" }],
      }),
      makeReview({
        honored: ["p1", "p2"],
        violations: [{ principle_id: "p1", severity: "rule" }],
      }),
    ];
    const report = analyzeDrift(reviews, ["p1", "p2"]);

    const p1Stats = report.most_violated.find((s) => s.principle_id === "p1");
    expect(p1Stats).toBeDefined();
    expect(p1Stats!.total_violations).toBe(2);
    expect(p1Stats!.times_honored).toBe(1);
    // compliance = honored / (honored + violations) = 1/3 ≈ 33%
    expect(p1Stats!.compliance_rate).toBe(33);
  });

  it("counts unintentional violations from reviews", () => {
    const reviews = [
      makeReview({
        violations: [{ principle_id: "p1", severity: "rule" }],
      }),
    ];

    const report = analyzeDrift(reviews, ["p1"]);
    const p1Stats = report.most_violated.find((s) => s.principle_id === "p1");
    expect(p1Stats!.unintentional_violations).toBe(1);
    expect(p1Stats!.total_violations).toBe(1);
  });

  it("identifies never-triggered principles", () => {
    const reviews = [makeReview({ honored: ["p1"] })];
    const report = analyzeDrift(reviews, ["p1", "p2", "p3"]);
    expect(report.never_triggered).toEqual(["p2", "p3"]);
  });

  it("computes average scores", () => {
    const reviews = [
      makeReview({
        score: {
          conventions: { passed: 1, total: 2 },
          opinions: { passed: 3, total: 3 },
          rules: { passed: 2, total: 4 },
        },
      }),
      makeReview({
        score: {
          conventions: { passed: 1, total: 2 },
          opinions: { passed: 3, total: 3 },
          rules: { passed: 2, total: 4 },
        },
      }),
    ];
    const report = analyzeDrift(reviews, []);
    expect(report.avg_score.rules).toBe(50);
    expect(report.avg_score.opinions).toBe(100);
    expect(report.avg_score.conventions).toBe(50);
  });

  it("detects improving trend", () => {
    // 8 reviews: first 4 have violations, last 4 are clean
    const reviews: ReviewEntry[] = [];
    for (let i = 0; i < 4; i++) {
      reviews.push(
        makeReview({
          review_id: `rev_${i}`,
          violations: [
            { principle_id: "p1", severity: "rule" },
            { principle_id: "p2", severity: "rule" },
          ],
        }),
      );
    }
    for (let i = 4; i < 8; i++) {
      reviews.push(makeReview({ review_id: `rev_${i}`, violations: [] }));
    }
    const report = analyzeDrift(reviews, ["p1", "p2"]);
    expect(report.trend).toBe("improving");
  });

  it("detects declining trend", () => {
    const reviews: ReviewEntry[] = [];
    for (let i = 0; i < 4; i++) {
      reviews.push(makeReview({ review_id: `rev_${i}`, violations: [] }));
    }
    for (let i = 4; i < 8; i++) {
      reviews.push(
        makeReview({
          review_id: `rev_${i}`,
          violations: [
            { principle_id: "p1", severity: "rule" },
            { principle_id: "p2", severity: "rule" },
          ],
        }),
      );
    }
    const report = analyzeDrift(reviews, ["p1", "p2"]);
    expect(report.trend).toBe("declining");
  });

  it("detects stable trend", () => {
    const reviews: ReviewEntry[] = [];
    for (let i = 0; i < 8; i++) {
      reviews.push(
        makeReview({
          review_id: `rev_${i}`,
          violations: [{ principle_id: "p1", severity: "rule" }],
        }),
      );
    }
    const report = analyzeDrift(reviews, ["p1"]);
    expect(report.trend).toBe("stable");
  });

  it("returns insufficient_data trend for < 6 reviews", () => {
    const reviews = [makeReview(), makeReview(), makeReview()];
    const report = analyzeDrift(reviews, []);
    expect(report.trend).toBe("insufficient_data");
  });

  it("filters by principleId", () => {
    const reviews = [
      makeReview({
        honored: ["p2"],
        violations: [{ principle_id: "p1", severity: "rule" }],
      }),
      makeReview({ honored: ["p2"] }),
    ];
    const report = analyzeDrift(reviews, ["p1", "p2"], {
      principleId: "p1",
    });
    // Only the first review mentions p1
    expect(report.total_reviews).toBe(1);
  });

  it("filters by lastN", () => {
    const reviews = [makeReview({ review_id: "old" }), makeReview({ review_id: "new" })];
    const report = analyzeDrift(reviews, [], { lastN: 1 });
    expect(report.total_reviews).toBe(1);
  });

  it("computes violation directories", () => {
    const reviews = [
      makeReview({
        files: ["src/routes/users.ts"],
        violations: [{ principle_id: "p1", severity: "rule" }],
      }),
      makeReview({
        files: ["src/routes/auth.ts"],
        violations: [
          { principle_id: "p1", severity: "rule" },
          { principle_id: "p2", severity: "strong-opinion" },
        ],
      }),
    ];
    const report = analyzeDrift(reviews, ["p1", "p2"]);
    expect(report.violation_directories.length).toBeGreaterThan(0);
    expect(report.violation_directories[0].directory).toBe("src/routes");
  });
});

describe("correctness-scan exclusion from analytics", () => {
  it("excludes correctness-scan from most_violated even when stored in review", () => {
    // Simulate a stored review that contains a correctness-scan violation (new behavior).
    // The analyzer must not count it in most_violated.
    const reviews = [
      makeReview({
        violations: [{ principle_id: CORRECTNESS_SCAN_PRINCIPLE_ID, severity: "rule" }],
      }),
    ];
    const report = analyzeDrift(reviews, []);
    const cs = report.most_violated.find((s) => s.principle_id === CORRECTNESS_SCAN_PRINCIPLE_ID);
    expect(cs).toBeUndefined();
    expect(report.most_violated).toHaveLength(0);
  });

  it("excludes correctness-scan from violation_directories", () => {
    const reviews = [
      makeReview({
        files: ["src/routes/users.ts"],
        violations: [{ principle_id: CORRECTNESS_SCAN_PRINCIPLE_ID, severity: "rule" }],
      }),
    ];
    const report = analyzeDrift(reviews, []);
    // No directories recorded because the only violation is correctness-scan
    expect(report.violation_directories).toHaveLength(0);
  });

  it("counts real violations in most_violated but not correctness-scan when both stored", () => {
    // Mixed stored review — real principle + correctness-scan.
    // Only real principle should appear in analytics.
    const reviews = [
      makeReview({
        files: ["src/routes/users.ts"],
        violations: [
          {
            principle_id: "thin-handlers",
            severity: "strong-opinion",
            file_path: "src/routes/users.ts",
          },
          { principle_id: CORRECTNESS_SCAN_PRINCIPLE_ID, severity: "rule" },
        ],
      }),
    ];
    const report = analyzeDrift(reviews, []);
    const ids = report.most_violated.map((s) => s.principle_id);
    expect(ids).toContain("thin-handlers");
    expect(ids).not.toContain(CORRECTNESS_SCAN_PRINCIPLE_ID);
    // violation_directories only counts thin-handlers
    expect(report.violation_directories.length).toBeGreaterThan(0);
    const totalViolations = report.violation_directories.reduce(
      (sum, d) => sum + d.total_violations,
      0,
    );
    expect(totalViolations).toBe(1); // only thin-handlers
  });

  it("correctness-scan does not inflate most_violated when many are present", () => {
    // 5 reviews each with one correctness-scan violation.
    // most_violated should remain empty (no real principles).
    const reviews = Array.from({ length: 5 }, (_, i) =>
      makeReview({
        review_id: `rev_${i}`,
        violations: [{ principle_id: CORRECTNESS_SCAN_PRINCIPLE_ID, severity: "rule" }],
      }),
    );
    const report = analyzeDrift(reviews, []);
    expect(report.most_violated).toHaveLength(0);
  });
});

describe("historical drift-report view — resolved violations feed most_violated (sug_KKKKKK1)", () => {
  it("most_violated is non-empty and keyed by principle_id when fed open+resolved violations", () => {
    // Simulates the shape getReviews({ includeResolvedViolations: true }) returns:
    // violations that are historically resolved still appear in the ReviewEntry.
    const reviews = [
      makeReview({
        review_id: "rev_1",
        violations: [{ principle_id: "fail-closed-by-default", severity: "rule" }],
      }),
    ];
    const report = analyzeDrift(reviews, ["fail-closed-by-default"]);
    expect(report.most_violated).not.toHaveLength(0);
    const stats = report.most_violated.find((s) => s.principle_id === "fail-closed-by-default");
    expect(stats).toBeDefined();
    expect(stats!.total_violations).toBe(1);
  });

  it("never_triggered excludes a principle that was violated-then-resolved", () => {
    const reviews = [
      makeReview({
        review_id: "rev_1",
        violations: [{ principle_id: "hooks-fail-closed", severity: "rule" }],
      }),
    ];
    const report = analyzeDrift(reviews, ["hooks-fail-closed", "never-touched-principle"]);
    expect(report.never_triggered).toEqual(["never-touched-principle"]);
  });

  it("a principle with 1 resolved + 0 open rows counts exactly once (no double-count)", () => {
    // Open and resolved violation rows are disjoint at the DB level — the
    // ReviewEntry the analyzer receives carries each violation exactly once
    // regardless of its resolution status.
    const reviews = [
      makeReview({
        review_id: "rev_1",
        violations: [{ principle_id: "observable-best-effort", severity: "strong-opinion" }],
      }),
    ];
    const report = analyzeDrift(reviews, ["observable-best-effort"]);
    const stats = report.most_violated.find((s) => s.principle_id === "observable-best-effort");
    expect(stats!.total_violations).toBe(1);
  });
});

describe("v1 craft field removed", () => {
  it("analyzeDrift returns a DriftReport without a craft field", () => {
    const report = analyzeDrift([], []);
    expect((report as Record<string, unknown>).craft).toBeUndefined();
  });

  it("analyzeDrift returns no craft field even with holistic recommendations present", () => {
    const reviews = [
      makeReview({
        recommendations: [
          { title: "H1", message: "msg", source: "holistic" as const },
          { title: "P1", message: "msg", source: "principle" as const },
        ],
      }),
    ];
    const report = analyzeDrift(reviews, []);
    expect((report as Record<string, unknown>).craft).toBeUndefined();
    // avg_score is still present and correct
    expect(report.avg_score).toBeDefined();
  });

  it("formatDriftReport output contains no 'Craft:' line", () => {
    const report = analyzeDrift([], []);
    const output = formatDriftReport(report);
    expect(output).not.toContain("Craft:");
  });

  it("formatDriftReport with holistic recommendations still contains no 'Craft:' line", () => {
    const reviews = [
      makeReview({
        recommendations: [{ title: "H1", message: "msg", source: "holistic" as const }],
      }),
    ];
    const report = analyzeDrift(reviews, []);
    const output = formatDriftReport(report);
    expect(output).not.toContain("Craft:");
    expect(output).toContain("Avg score:");
  });
});
