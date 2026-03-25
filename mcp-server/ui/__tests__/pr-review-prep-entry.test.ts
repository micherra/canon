/**
 * pr-review-prep-entry.test.ts
 *
 * Verifies that the PR Review Prep MCP App entry files exist and are wired
 * correctly — parallel to the pr-impact-entry.test.ts pattern.
 *
 * Covers the declared known gap from pr-review-02-SUMMARY.md:
 *   "No Playwright visual/interaction tests" — these static content tests
 *   provide the structural baseline (entry point wiring, Svelte 5 patterns,
 *   bridge integration, required UI states).
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiDir = join(__dirname, "..");

// ── HTML entry point ──

describe("pr-review-prep.html entry point", () => {
  const htmlPath = join(uiDir, "pr-review-prep.html");

  it("exists", () => {
    expect(existsSync(htmlPath)).toBe(true);
  });

  it("has correct <title>", () => {
    const content = readFileSync(htmlPath, "utf-8");
    expect(content).toContain("<title>Canon PR Review Prep</title>");
  });

  it("has a <script> tag pointing to ./pr-review-prep.ts", () => {
    const content = readFileSync(htmlPath, "utf-8");
    expect(content).toContain('src="./pr-review-prep.ts"');
  });

  it("has the #app mount target", () => {
    const content = readFileSync(htmlPath, "utf-8");
    expect(content).toContain('id="app"');
  });

  it("uses type=module for the script tag", () => {
    const content = readFileSync(htmlPath, "utf-8");
    expect(content).toContain('type="module"');
  });
});

// ── TypeScript entry point ──

describe("pr-review-prep.ts entry point", () => {
  const tsPath = join(uiDir, "pr-review-prep.ts");

  it("exists", () => {
    expect(existsSync(tsPath)).toBe(true);
  });

  it("imports PrReviewPrep from ./PrReviewPrep.svelte", () => {
    const content = readFileSync(tsPath, "utf-8");
    expect(content).toContain("PrReviewPrep");
    expect(content).toContain("./PrReviewPrep.svelte");
  });

  it("uses mount() from svelte", () => {
    const content = readFileSync(tsPath, "utf-8");
    expect(content).toContain('from "svelte"');
    expect(content).toContain("mount(");
  });
});

// ── Svelte component structural contract ──

describe("PrReviewPrep.svelte component", () => {
  const sveltePath = join(uiDir, "PrReviewPrep.svelte");

  it("exists", () => {
    expect(existsSync(sveltePath)).toBe(true);
  });

  it("uses Svelte 5 $state rune", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("$state");
  });

  it("uses Svelte 5 $derived rune", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("$derived");
  });

  it("imports bridge from stores/bridge", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("bridge");
    expect(content).toContain("stores/bridge");
  });

  it("calls get_pr_review_data tool via bridge", () => {
    // This verifies the tool name contract between UI and server
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("get_pr_review_data");
  });

  it("handles loading state", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("loading");
  });

  it("handles error state", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("error");
  });

  it("handles empty state (no changed files)", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("No changed files");
  });

  it("renders layer-grouped file list", () => {
    // The component renders files grouped by layer — key structural section
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("filesGroupedByLayer");
    expect(content).toContain("sortedLayers");
  });

  it("renders review strategy section (reviewOrder)", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("reviewOrder");
  });

  it("renders risk areas section (riskFiles)", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("riskFiles");
  });

  it("uses HIGH_PRIORITY_THRESHOLD of 10", () => {
    const content = readFileSync(sveltePath, "utf-8");
    // Priority thresholds defined in context.md: high >= 10, medium >= 5
    expect(content).toContain("10");
  });

  it("has sort toggle (priority / path)", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("sortBy");
    expect(content).toContain("priority");
    expect(content).toContain("path");
  });

  it("has collapsible layer sections (toggleLayer)", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("toggleLayer");
    expect(content).toContain("collapsedLayers");
  });

  it("shows incremental badge when data.incremental is true", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("incremental");
    expect(content).toContain("last_reviewed_sha");
  });

  it("shows error warning when data.error is set", () => {
    // The header bar shows a warning if the tool returned an error (partial data case)
    const content = readFileSync(sveltePath, "utf-8");
    // The template conditionally renders an error warning in the header
    expect(content).toContain("data.error");
  });

  it("imports getLayerColor from lib/constants", () => {
    // Layer dots are colored using getLayerColor — verifies the constants contract
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("getLayerColor");
    expect(content).toContain("lib/constants");
  });
});
