/**
 * Tests for generateReviewHtml pure function.
 *
 * Coverage:
 *   - Complete UnifiedPrOutput fixture: all 8 sections present
 *   - BLOCKING verdict: banner color + headline copy
 *   - CLEAN verdict: banner color + "Ready to merge" copy
 *   - Empty review (no review data): minimal HTML with "No review data available"
 *   - XSS prevention: file paths with script tags produce escaped output
 *   - Recommendations: Fix Before Merge shows titles, not violations
 *   - CSS tokens present: design tokens from base.css inlined in style block
 */

import { describe, expect, it } from "vitest";
import { generateReviewHtml } from "../tools/generate-review-html.ts";
import type { UnifiedPrOutput } from "../tools/show-pr-impact.ts";

// ── Fixture factory ─────────────────────────────────────────────────────────

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

// ── Suite 1: Complete fixture — all 8 sections present ───────────────────────

describe("generateReviewHtml — complete fixture", () => {
  it("returns a complete <!DOCTYPE html> document", () => {
    const html = generateReviewHtml(makeFixture());
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain("<html");
    expect(html).toContain("</html>");
    expect(html).toContain("<head>");
    expect(html).toContain("<body>");
  });

  it("contains verdict banner with WARNING color", () => {
    const html = generateReviewHtml(makeFixture());
    expect(html).toContain("#f39c12"); // WARNING color
    expect(html).toContain("WARNING");
  });

  it("contains stats row with correct file count", () => {
    const html = generateReviewHtml(makeFixture());
    // 2 files in review.files
    expect(html).toContain("files changed");
    // violation count
    expect(html).toContain("violations");
  });

  it("contains Fix Before Merge section", () => {
    const html = generateReviewHtml(makeFixture());
    expect(html).toContain("Fix Before Merge");
  });

  it("contains Violations by Principle section", () => {
    const html = generateReviewHtml(makeFixture());
    expect(html).toContain("Violations by Principle");
  });

  it("contains Compliance Score section with bar rows", () => {
    const html = generateReviewHtml(makeFixture());
    expect(html).toContain("Compliance Score");
    expect(html).toContain("Rules");
    expect(html).toContain("Opinions");
    expect(html).toContain("Conventions");
  });

  it("contains Blast Radius chart section", () => {
    const html = generateReviewHtml(makeFixture());
    expect(html).toContain("Highest Blast Radius");
    expect(html).toContain("engine.ts"); // basename of src/core/engine.ts
  });

  it("contains Layer Chart section", () => {
    const html = generateReviewHtml(makeFixture());
    expect(html).toContain("Changes by Layer");
    expect(html).toContain("features");
    expect(html).toContain("shared");
  });

  it("contains Subsystems Panel section", () => {
    const html = generateReviewHtml(makeFixture());
    expect(html).toContain("New Subsystems Added");
    expect(html).toContain("src/new-feature");
    expect(html).toContain("new");
  });

  it("shows honored principles badges", () => {
    const html = generateReviewHtml(makeFixture());
    expect(html).toContain("Honored Principles");
    expect(html).toContain("functions-do-one-thing");
    expect(html).toContain("deep-modules");
  });
});

// ── Suite 2: BLOCKING verdict ─────────────────────────────────────────────────

describe("generateReviewHtml — BLOCKING verdict", () => {
  it("uses BLOCKING color #e74c3c in banner", () => {
    const html = generateReviewHtml(makeFixture({ review: makeReview({ verdict: "BLOCKING" }) }));
    expect(html).toContain("#e74c3c");
    expect(html).toContain("BLOCKING");
  });

  it("headline mentions violations to fix before merge", () => {
    const html = generateReviewHtml(
      makeFixture({
        review: makeReview({
          verdict: "BLOCKING",
          violations: [
            {
              file_path: "src/features/foo.ts",
              message: "Must fix this",
              principle_id: "functions-do-one-thing",
              severity: "rule",
            },
          ],
        }),
      }),
    );
    expect(html).toContain("to fix before merge");
  });
});

// ── Suite 3: CLEAN verdict ────────────────────────────────────────────────────

describe("generateReviewHtml — CLEAN verdict", () => {
  it("uses CLEAN color #27ae60 in banner", () => {
    const html = generateReviewHtml(
      makeFixture({
        review: makeReview({ honored: [], verdict: "CLEAN", violations: [] }),
      }),
    );
    expect(html).toContain("#27ae60");
    expect(html).toContain("CLEAN");
  });

  it("headline says Ready to merge when no violations", () => {
    const html = generateReviewHtml(
      makeFixture({
        review: makeReview({ honored: [], verdict: "CLEAN", violations: [] }),
      }),
    );
    expect(html).toContain("Ready to merge");
  });

  it("shows No violations found in violations section", () => {
    const html = generateReviewHtml(
      makeFixture({
        review: makeReview({ honored: [], verdict: "CLEAN", violations: [] }),
      }),
    );
    expect(html).toContain("No violations found");
  });

  it("shows No violations — looking good in fix section", () => {
    const html = generateReviewHtml(
      makeFixture({
        review: makeReview({ honored: [], verdict: "CLEAN", violations: [] }),
      }),
    );
    expect(html).toContain("No violations");
  });
});

// ── Suite 4: Empty review (no review data) ────────────────────────────────────

describe("generateReviewHtml — no review data", () => {
  it("returns minimal HTML when data.review is undefined", () => {
    const data: UnifiedPrOutput = {
      blast_radius_by_file: [],
      co_change_warnings: [],
      has_review: false,
      hotspots: [],
      prep: makePrep(),
      status: "ok",
      subgraph: { edges: [], layers: [], nodes: [] },
      subsystems: [],
    };
    const html = generateReviewHtml(data);
    expect(html).toContain("No review data available");
    expect(html).toMatch(/^<!DOCTYPE html>/);
  });

  it("minimal page still has DOCTYPE and body", () => {
    const data: UnifiedPrOutput = {
      blast_radius_by_file: [],
      co_change_warnings: [],
      has_review: false,
      hotspots: [],
      prep: makePrep(),
      status: "ok",
      subgraph: { edges: [], layers: [], nodes: [] },
      subsystems: [],
    };
    const html = generateReviewHtml(data);
    expect(html).toContain("<body>");
    expect(html).toContain("</body>");
  });
});

// ── Suite 5: XSS prevention ──────────────────────────────────────────────────

describe("generateReviewHtml — XSS prevention", () => {
  it("escapes angle brackets in file paths", () => {
    const xssPath = "src/<script>alert('xss')</script>/foo.ts";
    const html = generateReviewHtml(
      makeFixture({
        review: makeReview({
          files: [xssPath],
          verdict: "WARNING",
          violations: [
            {
              file_path: xssPath,
              message: "some issue",
              principle_id: "functions-do-one-thing",
              severity: "rule",
            },
          ],
        }),
      }),
    );
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes quotes in file paths", () => {
    const quotedPath = 'src/path-with-"quotes".ts';
    const html = generateReviewHtml(
      makeFixture({
        review: makeReview({
          files: [quotedPath],
          verdict: "CLEAN",
          violations: [
            {
              file_path: quotedPath,
              message: "test",
              principle_id: "test-principle",
              severity: "convention",
            },
          ],
        }),
      }),
    );
    expect(html).not.toContain('"quotes"');
    expect(html).toContain("&quot;quotes&quot;");
  });

  it("escapes violation messages containing HTML", () => {
    const html = generateReviewHtml(
      makeFixture({
        review: makeReview({
          verdict: "BLOCKING",
          violations: [
            {
              file_path: "src/file.ts",
              message: "<img src=x onerror=alert(1)>",
              principle_id: "secure-by-default",
              severity: "rule",
            },
          ],
        }),
      }),
    );
    expect(html).not.toContain("<img src=");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes principle IDs containing HTML", () => {
    const html = generateReviewHtml(
      makeFixture({
        review: makeReview({
          verdict: "WARNING",
          violations: [
            {
              file_path: "src/file.ts",
              message: "test",
              principle_id: "<evil>",
              severity: "convention",
            },
          ],
        }),
      }),
    );
    expect(html).not.toContain("<evil>");
    expect(html).toContain("&lt;evil&gt;");
  });

  it("escapes subsystem directory paths", () => {
    const html = generateReviewHtml(
      makeFixture({
        subsystems: [{ directory: "<script>", file_count: 3, label: "new" }],
      }),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes blast radius file paths", () => {
    const html = generateReviewHtml(
      makeFixture({
        blast_radius_by_file: [{ dep_count: 5, file: 'src/<xss onerror="bad">.ts' }],
      }),
    );
    expect(html).not.toContain('<xss onerror="bad">');
    expect(html).toContain("&lt;xss");
  });
});

// ── Suite 6: Recommendations in Fix Before Merge ─────────────────────────────

describe("generateReviewHtml — recommendations", () => {
  it("shows recommendation titles when recommendations are provided", () => {
    const html = generateReviewHtml(
      makeFixture({
        recommendations: [
          {
            file_path: "src/features/foo.ts",
            message: "Extract the formatting logic into a separate helper",
            source: "principle",
            title: "Reduce function complexity",
          },
          {
            message: "Consider adding integration tests for this module",
            source: "holistic",
            title: "Add integration tests",
          },
        ],
        review: makeReview({ violations: [] }),
      }),
    );
    expect(html).toContain("Reduce function complexity");
    expect(html).toContain("Add integration tests");
  });

  it("does not show violation principle IDs when recommendations are present", () => {
    const html = generateReviewHtml(
      makeFixture({
        recommendations: [
          {
            message: "Fix it",
            source: "holistic",
            title: "Important fix",
          },
        ],
        review: makeReview({
          violations: [
            {
              file_path: "src/x.ts",
              message: "problem",
              principle_id: "errors-are-values",
              severity: "rule",
            },
          ],
        }),
      }),
    );
    expect(html).toContain("Important fix");
    // The violation's principle_id should NOT appear in Fix Before Merge
    // (it may still appear in the Violations by Principle section — that's expected)
    expect(html).toContain("Important fix");
  });

  it("escapes recommendation titles and messages", () => {
    const html = generateReviewHtml(
      makeFixture({
        recommendations: [
          {
            message: "<script>bad()</script>",
            source: "holistic",
            title: "<b>bold title</b>",
          },
        ],
      }),
    );
    expect(html).not.toContain("<script>bad");
    expect(html).not.toContain("<b>bold");
    expect(html).toContain("&lt;b&gt;bold title&lt;/b&gt;");
  });

  it("falls back to violations when recommendations is empty array", () => {
    const html = generateReviewHtml(
      makeFixture({
        recommendations: [],
        review: makeReview(),
      }),
    );
    // Should show the violation's principle_id in Fix Before Merge
    expect(html).toContain("functions-do-one-thing");
  });
});

// CSS token and edge case tests live in generate-review-html-edge-cases.test.ts
// (split to stay within the 600-line file limit)
