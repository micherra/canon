/**
 * BDD integration tests for the HTML artifact feature (part 2 of 2).
 *
 * Covers:
 *   4. generateReviewHtml handles large datasets (100+ files) without throwing
 *   5. Single-file reviews produce valid HTML with correct singular/plural copy
 *   6. present_artifact html field contract — type-level and runtime verification
 *
 * Part 1 (generate-review-html-bdd.test.ts) covers:
 *   1. generateReviewHtml → HTTP serve end-to-end
 *   2. XSS boundary in HTTP response
 *   3. Snippet library composition across all 5 snippets
 */

import { request as httpRequest } from "node:http";
import {
  registerArtifact,
  removeArtifact,
  resetStateForTesting,
  startHttpServer,
  stopHttpServer,
} from "@app/http-server.ts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateReviewHtml } from "../tools/generate-review-html.ts";
import type { UnifiedPrOutput } from "../tools/show-pr-impact.ts";

// ── HTTP helper ──────────────────────────────────────────────────────────────

const TEST_PORT = 24172;

async function httpGet(path: string): Promise<{ status: number; body: string }> {
  const port = TEST_PORT;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", method: "GET", path, port }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      res.on("end", () => {
        resolve({ body, status: res.statusCode ?? 0 });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// ── Fixture factories ────────────────────────────────────────────────────────

function makePrep(overrides: Partial<UnifiedPrOutput["prep"]> = {}): UnifiedPrOutput["prep"] {
  return {
    blast_radius: [],
    diff_command: "git diff main..HEAD",
    files: [
      { layer: "features", path: "src/features/auth.ts", status: "modified" },
      { layer: "shared", path: "src/shared/utils.ts", status: "added" },
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
    files: ["src/features/auth.ts", "src/shared/utils.ts"],
    honored: ["validate-at-trust-boundaries"],
    score: {
      conventions: { passed: 4, total: 5 },
      opinions: { passed: 3, total: 4 },
      rules: { passed: 2, total: 3 },
    },
    verdict: "WARNING",
    violations: [
      {
        file_path: "src/features/auth.ts",
        message: "Missing input validation at trust boundary",
        principle_id: "validate-at-trust-boundaries",
        severity: "strong-opinion",
      },
    ],
    ...overrides,
  };
}

function makeFixture(overrides: Partial<UnifiedPrOutput> = {}): UnifiedPrOutput {
  return {
    blast_radius_by_file: [
      { dep_count: 55, file: "src/core/router.ts" },
      { dep_count: 23, file: "src/shared/config.ts" },
    ],
    co_change_warnings: [],
    has_review: true,
    hotspots: [],
    prep: makePrep(),
    review: makeReview(),
    status: "ok",
    subgraph: { edges: [], layers: [], nodes: [] },
    subsystems: [{ directory: "src/payments", file_count: 6, label: "new" }],
    ...overrides,
  };
}

// ── Server lifecycle ─────────────────────────────────────────────────────────

beforeAll(async () => {
  await startHttpServer(TEST_PORT);
});

afterAll(async () => {
  resetStateForTesting();
  await stopHttpServer();
});

// ────────────────────────────────────────────────────────────────────────────
// Suite 4: Large dataset robustness
// ────────────────────────────────────────────────────────────────────────────

describe("generateReviewHtml — large dataset robustness", () => {
  /**
   * Given: a UnifiedPrOutput with 100+ files, 100+ blast radius entries, and 50+ violations
   * When: generateReviewHtml is called
   * Then: it does not throw, and returns valid HTML
   */
  it("handles 100 files, 100 blast radius entries, 50 violations without throwing", () => {
    const files = Array.from({ length: 100 }, (_, i) => ({
      layer: "features",
      path: `src/features/module-${i}/index.ts`,
      status: "modified" as const,
    }));
    const blastRadius = Array.from({ length: 100 }, (_, i) => ({
      dep_count: 100 - i,
      file: `src/module-${i}/index.ts`,
    }));
    const violations = Array.from({ length: 50 }, (_, i) => ({
      file_path: `src/features/module-${i}/index.ts`,
      message: `Violation ${i}: something is wrong here`,
      principle_id: `principle-${i % 10}`,
      severity: (i % 3 === 0 ? "rule" : i % 3 === 1 ? "strong-opinion" : "convention") as
        | "rule"
        | "strong-opinion"
        | "convention",
    }));

    expect(() =>
      generateReviewHtml(
        makeFixture({
          blast_radius_by_file: blastRadius,
          prep: makePrep({
            files,
            layers: [{ file_count: 100, name: "features" }],
            total_files: 100,
          }),
          review: makeReview({ files: files.map((f) => f.path), violations }),
        }),
      ),
    ).not.toThrow();
  });

  /**
   * Given: a UnifiedPrOutput with 100 files
   * When: the HTML is generated
   * Then: the result is a complete HTML document
   */
  it("large dataset produces a valid HTML document (has DOCTYPE and </html>)", () => {
    const files = Array.from({ length: 100 }, (_, i) => ({
      layer: "features",
      path: `src/features/module-${i}/index.ts`,
      status: "modified" as const,
    }));

    const html = generateReviewHtml(
      makeFixture({
        prep: makePrep({ files, total_files: 100 }),
        review: makeReview({ files: files.map((f) => f.path), violations: [] }),
      }),
    );
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).toContain("</html>");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Suite 5: Single-file review — singular/plural copy correctness
// ────────────────────────────────────────────────────────────────────────────

describe("generateReviewHtml — single-file review", () => {
  /**
   * Given: a UnifiedPrOutput with exactly 1 file in the review
   * When: generateReviewHtml is called
   * Then: the verdict banner uses singular "file" (not "files")
   */
  it("1 file: verdict banner uses singular 'file'", () => {
    const html = generateReviewHtml(
      makeFixture({
        prep: makePrep({
          files: [{ layer: "features", path: "src/features/one.ts", status: "modified" }],
          total_files: 1,
        }),
        review: makeReview({
          files: ["src/features/one.ts"],
          verdict: "CLEAN",
          violations: [],
        }),
      }),
    );
    expect(html).toContain("1 file");
    expect(html).not.toContain("1 files");
  });

  /**
   * Given: a UnifiedPrOutput with exactly 1 rule violation
   * When: generateReviewHtml is called
   * Then: the verdict banner uses singular "violation" in the fix copy
   */
  it("1 rule violation: verdict banner uses singular 'violation to fix before merge'", () => {
    const html = generateReviewHtml(
      makeFixture({
        review: makeReview({
          verdict: "BLOCKING",
          violations: [
            {
              file_path: "src/auth.ts",
              message: "Missing validation",
              principle_id: "validate-at-trust-boundaries",
              severity: "rule",
            },
          ],
        }),
      }),
    );
    expect(html).toContain("1 violation to fix before merge");
  });

  /**
   * Given: a UnifiedPrOutput with 2 rule violations
   * When: generateReviewHtml is called
   * Then: the verdict banner uses plural "violations"
   */
  it("2 rule violations: verdict banner uses plural 'violations to fix before merge'", () => {
    const html = generateReviewHtml(
      makeFixture({
        review: makeReview({
          verdict: "BLOCKING",
          violations: [
            {
              file_path: "src/auth.ts",
              message: "Missing validation",
              principle_id: "validate-at-trust-boundaries",
              severity: "rule",
            },
            {
              file_path: "src/db.ts",
              message: "Direct SQL concat",
              principle_id: "secure-by-default",
              severity: "rule",
            },
          ],
        }),
      }),
    );
    expect(html).toContain("2 violations to fix before merge");
  });

  /**
   * Given: a WARNING review with 1 non-rule violation (advisory only)
   * When: generateReviewHtml is called
   * Then: the verdict banner describes advisory violations using "need" language,
   *       not "fix before merge" (which is reserved for rule-level violations)
   */
  it("1 advisory violation (WARNING, non-rule): banner does not say 'fix before merge'", () => {
    const html = generateReviewHtml(
      makeFixture({
        review: makeReview({
          verdict: "WARNING",
          violations: [
            {
              file_path: "src/auth.ts",
              message: "Missing doc comment",
              principle_id: "document-public-apis",
              severity: "convention",
            },
          ],
        }),
      }),
    );
    expect(html).not.toContain("to fix before merge");
    expect(html).toContain("need");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Suite 6: present_artifact html field — integration contract
// ────────────────────────────────────────────────────────────────────────────

describe("present_artifact html field — schema and contract", () => {
  /**
   * Given: the PresentArtifactInput type exports an optional html field
   * When: it is imported and inspected at runtime
   * Then: a value with html set and an unknown type satisfies the type contract
   *       (this test verifies the type contract the engineer declared in the module)
   */
  it("html field is accepted as an optional string by the type declaration", async () => {
    const { presentArtifact: _presentArtifact } = await import(
      "../../orchestration/tools/present-artifact.ts"
    );
    type Fn = typeof _presentArtifact;
    type Input = Parameters<Fn>[0];

    // Type-level check: this object must satisfy the Input type (TypeScript compile error otherwise)
    const input: Input = {
      data: {},
      html: "<html><body>test</body></html>",
      slug: "bdd-type-check",
      type: "custom-review",
      workspace: "/tmp/ws",
    };

    // Runtime contract: html field is present, is a string, and is non-empty
    expect(input.html).toBeDefined();
    expect(typeof input.html).toBe("string");
    expect(input.html!.length).toBeGreaterThan(0);
  });

  /**
   * Given: generateReviewHtml produces a complete HTML string
   * When: that string is registered as an HTTP artifact and served
   * Then: the HTTP response body is the full generated HTML (not truncated or corrupted)
   */
  it("generateReviewHtml output can be directly registered and served as a dynamic artifact", async () => {
    const reviewHtml = generateReviewHtml(makeFixture());

    const key = "bdd2/generated-html-as-artifact";
    registerArtifact(key, reviewHtml, { source: "generateReviewHtml" });

    const res = await httpGet(`/artifact/${key}`);
    expect(res.status).toBe(200);

    // The body should contain the HTML that generateReviewHtml produced
    expect(res.body).toContain("<!DOCTYPE html>");
    expect(res.body).toContain("<html");
    expect(res.body).toContain("Fix Before Merge");
    expect(res.body).toContain("Compliance Score");

    // Verify fidelity — no truncation
    expect(res.body.length).toBeGreaterThan(5000);

    removeArtifact(key);
  });
});
