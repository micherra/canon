/**
 * Edge case and CSS token tests for generateReviewHtml.
 *
 * Split from generate-review-html.test.ts to stay within the 600-line file limit.
 * Covers:
 *   - CSS design tokens present in output
 *   - Empty section states (no blast radius, no subsystems, no layer data)
 *   - Overflow note for many violations
 *   - Grouped violation display
 *   - Proportional bar widths
 *   - Compliance data edge cases
 *   - Purity and no-JavaScript invariants
 */

import { describe, expect, it } from "vitest";
import { generateReviewHtml } from "../tools/generate-review-html.ts";
import type { UnifiedPrOutput } from "../tools/show-pr-impact.ts";

// ── Fixture factory (minimal duplicate for independence) ─────────────────────

function makePrep(overrides: Partial<UnifiedPrOutput["prep"]> = {}): UnifiedPrOutput["prep"] {
  return {
    blast_radius: [],
    diff_command: "git diff main..HEAD",
    files: [
      { layer: "features", path: "src/features/foo.ts", status: "modified" },
      { layer: "shared", path: "src/shared/bar.ts", status: "added" },
    ],
    impact_files: [],
    incremental: false,
    layers: [
      { file_count: 1, name: "features" },
      { file_count: 1, name: "shared" },
    ],
    narrative: "2 files changed",
    net_new_files: 1,
    total_files: 2,
    total_violations: 0,
    ...overrides,
  };
}

function makeReview(
  overrides: Partial<NonNullable<UnifiedPrOutput["review"]>> = {},
): NonNullable<UnifiedPrOutput["review"]> {
  return {
    files: ["src/features/foo.ts", "src/shared/bar.ts"],
    honored: ["functions-do-one-thing", "deep-modules"],
    score: {
      conventions: { passed: 3, total: 4 },
      opinions: { passed: 2, total: 3 },
      rules: { passed: 1, total: 2 },
    },
    verdict: "WARNING",
    violations: [
      {
        file_path: "src/features/foo.ts",
        message: "Function does too many things",
        principle_id: "functions-do-one-thing",
        severity: "rule",
      },
      {
        file_path: "src/shared/bar.ts",
        message: "Missing error handling",
        principle_id: "errors-are-values",
        severity: "strong-opinion",
      },
    ],
    ...overrides,
  };
}

function makeFixture(overrides: Partial<UnifiedPrOutput> = {}): UnifiedPrOutput {
  return {
    blast_radius_by_file: [
      { dep_count: 42, file: "src/core/engine.ts" },
      { dep_count: 17, file: "src/shared/utils.ts" },
    ],
    co_change_warnings: [],
    has_review: true,
    hotspots: [],
    prep: makePrep(),
    review: makeReview(),
    status: "ok",
    subgraph: { edges: [], layers: [], nodes: [] },
    subsystems: [{ directory: "src/new-feature", file_count: 4, label: "new" }],
    ...overrides,
  };
}

// ── Suite 7: CSS design tokens ────────────────────────────────────────────────

describe("generateReviewHtml — CSS design tokens", () => {
  it("includes --bg CSS custom property", () => {
    const html = generateReviewHtml(makeFixture());
    expect(html).toContain("--bg:");
  });

  it("includes --text CSS custom property", () => {
    const html = generateReviewHtml(makeFixture());
    expect(html).toContain("--text:");
  });

  it("includes --accent CSS custom property", () => {
    const html = generateReviewHtml(makeFixture());
    expect(html).toContain("--accent:");
  });

  it("includes --danger CSS custom property", () => {
    const html = generateReviewHtml(makeFixture());
    expect(html).toContain("--danger:");
  });

  it("includes --success CSS custom property", () => {
    const html = generateReviewHtml(makeFixture());
    expect(html).toContain("--success:");
  });

  it("contains a style block", () => {
    const html = generateReviewHtml(makeFixture());
    expect(html).toContain("<style>");
    expect(html).toContain("</style>");
  });
});

// ── Suite 8: Edge cases ───────────────────────────────────────────────────────

describe("generateReviewHtml — edge cases", () => {
  it("shows No blast radius data when blast_radius_by_file is empty", () => {
    const html = generateReviewHtml(makeFixture({ blast_radius_by_file: [] }));
    expect(html).toContain("No blast radius data");
  });

  it("shows No new subsystems detected when subsystems is empty", () => {
    const html = generateReviewHtml(makeFixture({ subsystems: [] }));
    expect(html).toContain("No new subsystems detected");
  });

  it("shows No layer data when prep.layers is empty", () => {
    const html = generateReviewHtml(makeFixture({ prep: makePrep({ layers: [] }) }));
    expect(html).toContain("No layer data");
  });

  it("shows overflow note when more than 5 violations and no recommendations", () => {
    const violations = Array.from({ length: 7 }, (_, i) => ({
      file_path: `src/file${i}.ts`,
      message: `Violation ${i}`,
      principle_id: `principle-${i}`,
      severity: "convention" as const,
    }));
    const html = generateReviewHtml(
      makeFixture({ review: makeReview({ verdict: "WARNING", violations }) }),
    );
    expect(html).toContain("Showing top 5 of 7");
  });

  it("stats row marks violation count in danger color when > 0", () => {
    const html = generateReviewHtml(makeFixture());
    expect(html).toContain("stat-value--danger");
  });

  it("stats row shows files changed label when violations are zero", () => {
    const html = generateReviewHtml(
      makeFixture({ review: makeReview({ verdict: "CLEAN", violations: [] }) }),
    );
    expect(html).toContain("files changed");
  });

  it("groups violations by principle and shows file count", () => {
    const violations = [
      {
        file_path: "src/a.ts",
        message: "msg1",
        principle_id: "functions-do-one-thing",
        severity: "rule" as const,
      },
      {
        file_path: "src/b.ts",
        message: "msg2",
        principle_id: "functions-do-one-thing",
        severity: "rule" as const,
      },
      {
        file_path: "src/c.ts",
        message: "msg3",
        principle_id: "validate-at-trust-boundaries",
        severity: "convention" as const,
      },
    ];
    const html = generateReviewHtml(
      makeFixture({ review: makeReview({ verdict: "BLOCKING", violations }) }),
    );
    expect(html).toContain("functions-do-one-thing");
    expect(html).toContain("2 files");
    expect(html).toContain("validate-at-trust-boundaries");
    expect(html).toContain("1 file");
  });

  it("subsystems panel shows removed label with correct styling class", () => {
    const html = generateReviewHtml(
      makeFixture({ subsystems: [{ directory: "src/old", file_count: 5, label: "removed" }] }),
    );
    expect(html).toContain("label-removed");
    expect(html).toContain("removed");
  });

  it("blast radius bars have width proportional to max dep_count", () => {
    const html = generateReviewHtml(
      makeFixture({
        blast_radius_by_file: [
          { dep_count: 100, file: "src/top.ts" },
          { dep_count: 50, file: "src/mid.ts" },
        ],
      }),
    );
    expect(html).toContain("width: 100%");
    expect(html).toContain("width: 50%");
  });

  it("compliance score shows No compliance data when all totals are zero", () => {
    const html = generateReviewHtml(
      makeFixture({
        review: makeReview({
          score: {
            conventions: { passed: 0, total: 0 },
            opinions: { passed: 0, total: 0 },
            rules: { passed: 0, total: 0 },
          },
          verdict: "CLEAN",
          violations: [],
        }),
      }),
    );
    expect(html).toContain("No compliance data");
  });

  it("is a pure function — same input produces identical output", () => {
    const data = makeFixture();
    const html1 = generateReviewHtml(data);
    const html2 = generateReviewHtml(data);
    expect(html1).toBe(html2);
  });

  it("contains no JavaScript — no script tags in output", () => {
    const html = generateReviewHtml(makeFixture());
    expect(html).not.toMatch(/<script\b/i);
  });
});
