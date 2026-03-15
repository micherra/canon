import { describe, it, expect } from "vitest";
import { analyzeDrift } from "../drift/analyzer.js";
import type { ReviewEntry, DecisionEntry } from "../schema.js";

function makeReview(overrides: Partial<ReviewEntry> = {}): ReviewEntry {
  return {
    review_id: "rev_1",
    files: ["src/a.ts"],
    violations: [],
    honored: [],
    score: {
      rules: { passed: 1, total: 1 },
      opinions: { passed: 1, total: 1 },
      conventions: { passed: 0, total: 0 },
    },
    verdict: "CLEAN",
    timestamp: "2026-03-15T00:00:00Z",
    ...overrides,
  };
}

function makeDecision(overrides: Partial<DecisionEntry> = {}): DecisionEntry {
  return {
    decision_id: "dec_1",
    principle_id: "p1",
    file_path: "src/a.ts",
    justification: "Justified",
    timestamp: "2026-03-15T00:00:00Z",
    ...overrides,
  };
}

describe("analyzeDrift", () => {
  it("returns empty report for no data", () => {
    const report = analyzeDrift([], [], ["p1", "p2"]);
    expect(report.total_reviews).toBe(0);
    expect(report.total_decisions).toBe(0);
    expect(report.most_violated).toEqual([]);
    expect(report.never_triggered).toEqual(["p1", "p2"]);
    expect(report.trend).toBe("insufficient_data");
  });

  it("counts violations and computes compliance rate", () => {
    const reviews = [
      makeReview({
        violations: [{ principle_id: "p1", severity: "rule" }],
        honored: ["p2"],
      }),
      makeReview({
        violations: [{ principle_id: "p1", severity: "rule" }],
        honored: ["p1", "p2"],
      }),
    ];
    const report = analyzeDrift(reviews, [], ["p1", "p2"]);

    const p1Stats = report.most_violated.find((s) => s.principle_id === "p1");
    expect(p1Stats).toBeDefined();
    expect(p1Stats!.total_violations).toBe(2);
    expect(p1Stats!.times_honored).toBe(1);
    // compliance = honored / (honored + violations) = 1/3 ≈ 33%
    expect(p1Stats!.compliance_rate).toBe(33);
  });

  it("adjusts unintentional violations for decisions", () => {
    const reviews = [
      makeReview({
        violations: [{ principle_id: "p1", severity: "rule" }],
      }),
    ];
    const decisions = [makeDecision({ principle_id: "p1" })];

    const report = analyzeDrift(reviews, decisions, ["p1"]);
    const p1Stats = report.most_violated.find((s) => s.principle_id === "p1");
    expect(p1Stats!.unintentional_violations).toBe(0);
    expect(p1Stats!.intentional_deviations).toBe(1);
    expect(p1Stats!.total_violations).toBe(1);
  });

  it("identifies never-triggered principles", () => {
    const reviews = [
      makeReview({ honored: ["p1"] }),
    ];
    const report = analyzeDrift(reviews, [], ["p1", "p2", "p3"]);
    expect(report.never_triggered).toEqual(["p2", "p3"]);
  });

  it("computes average scores", () => {
    const reviews = [
      makeReview({
        score: {
          rules: { passed: 2, total: 4 },
          opinions: { passed: 3, total: 3 },
          conventions: { passed: 1, total: 2 },
        },
      }),
      makeReview({
        score: {
          rules: { passed: 2, total: 4 },
          opinions: { passed: 3, total: 3 },
          conventions: { passed: 1, total: 2 },
        },
      }),
    ];
    const report = analyzeDrift(reviews, [], []);
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
        })
      );
    }
    for (let i = 4; i < 8; i++) {
      reviews.push(
        makeReview({ review_id: `rev_${i}`, violations: [] })
      );
    }
    const report = analyzeDrift(reviews, [], ["p1", "p2"]);
    expect(report.trend).toBe("improving");
  });

  it("detects declining trend", () => {
    const reviews: ReviewEntry[] = [];
    for (let i = 0; i < 4; i++) {
      reviews.push(
        makeReview({ review_id: `rev_${i}`, violations: [] })
      );
    }
    for (let i = 4; i < 8; i++) {
      reviews.push(
        makeReview({
          review_id: `rev_${i}`,
          violations: [
            { principle_id: "p1", severity: "rule" },
            { principle_id: "p2", severity: "rule" },
          ],
        })
      );
    }
    const report = analyzeDrift(reviews, [], ["p1", "p2"]);
    expect(report.trend).toBe("declining");
  });

  it("detects stable trend", () => {
    const reviews: ReviewEntry[] = [];
    for (let i = 0; i < 8; i++) {
      reviews.push(
        makeReview({
          review_id: `rev_${i}`,
          violations: [{ principle_id: "p1", severity: "rule" }],
        })
      );
    }
    const report = analyzeDrift(reviews, [], ["p1"]);
    expect(report.trend).toBe("stable");
  });

  it("returns insufficient_data trend for < 6 reviews", () => {
    const reviews = [makeReview(), makeReview(), makeReview()];
    const report = analyzeDrift(reviews, [], []);
    expect(report.trend).toBe("insufficient_data");
  });

  it("filters by principleId", () => {
    const reviews = [
      makeReview({
        violations: [{ principle_id: "p1", severity: "rule" }],
        honored: ["p2"],
      }),
      makeReview({ honored: ["p2"] }),
    ];
    const report = analyzeDrift(reviews, [], ["p1", "p2"], {
      principleId: "p1",
    });
    // Only the first review mentions p1
    expect(report.total_reviews).toBe(1);
  });

  it("filters by lastN", () => {
    const reviews = [
      makeReview({ review_id: "old" }),
      makeReview({ review_id: "new" }),
    ];
    const report = analyzeDrift(reviews, [], [], { lastN: 1 });
    expect(report.total_reviews).toBe(1);
  });

  it("computes directory hotspots", () => {
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
    const report = analyzeDrift(reviews, [], ["p1", "p2"]);
    expect(report.hotspot_directories.length).toBeGreaterThan(0);
    expect(report.hotspot_directories[0].directory).toBe("src/routes");
  });
});
