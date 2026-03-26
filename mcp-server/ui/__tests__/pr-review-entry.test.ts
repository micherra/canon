/**
 * pr-review-entry.test.ts
 *
 * Verifies that pr-review.html exists, contains the correct <script> tag
 * pointing to pr-review.ts, and has the #app mount target.
 *
 * Also verifies that old split entry points no longer exist (merged into unified view).
 *
 * This is a simple file-existence and content test — no browser runtime needed.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiDir = join(__dirname, "..");

// ── HTML entry point ──

describe("pr-review.html entry point", () => {
  const htmlPath = join(uiDir, "pr-review.html");

  it("exists", () => {
    expect(existsSync(htmlPath)).toBe(true);
  });

  it("has correct <title>", () => {
    const content = readFileSync(htmlPath, "utf-8");
    expect(content).toContain("<title>Canon PR Review</title>");
  });

  it("has a <script> tag pointing to ./pr-review.ts", () => {
    const content = readFileSync(htmlPath, "utf-8");
    expect(content).toContain('src="./pr-review.ts"');
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

describe("pr-review.ts entry point", () => {
  const tsPath = join(uiDir, "pr-review.ts");

  it("exists", () => {
    expect(existsSync(tsPath)).toBe(true);
  });

  it("imports PrReview from ./PrReview.svelte", () => {
    const content = readFileSync(tsPath, "utf-8");
    expect(content).toContain("PrReview");
    expect(content).toContain("./PrReview.svelte");
  });

  it("uses mount() from svelte", () => {
    const content = readFileSync(tsPath, "utf-8");
    expect(content).toContain('from "svelte"');
    expect(content).toContain("mount(");
  });
});

// ── PrReview.svelte unified component ──

describe("PrReview.svelte unified component", () => {
  const sveltePath = join(uiDir, "PrReview.svelte");

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

  it("calls show_pr_impact tool via bridge", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("show_pr_impact");
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

  it("imports NarrativeSummary child component", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("NarrativeSummary");
    expect(content).toContain("./components/NarrativeSummary.svelte");
  });

  it("imports ChangeStoryGrid child component", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("ChangeStoryGrid");
    expect(content).toContain("./components/ChangeStoryGrid.svelte");
  });

  it("imports ImpactTabs child component", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("ImpactTabs");
    expect(content).toContain("./components/ImpactTabs.svelte");
  });

  it("imports VerdictStrip child component", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("VerdictStrip");
    expect(content).toContain("./components/VerdictStrip.svelte");
  });

  it("imports HotspotList child component", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("HotspotList");
    expect(content).toContain("./components/HotspotList.svelte");
  });

  it("imports SubGraph child component", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("SubGraph");
    expect(content).toContain("./components/SubGraph.svelte");
  });

  it("imports PrDetailPanel child component", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("PrDetailPanel");
    expect(content).toContain("./components/PrDetailPanel.svelte");
  });

  it("imports UnifiedPrOutput type from stores/pr-review", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("UnifiedPrOutput");
    expect(content).toContain("./stores/pr-review");
  });

  it("reads prep data from data.prep (not data directly)", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("data.prep");
  });

  it("shows VerdictStrip when hasReview is true", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("hasReview");
    expect(content).toContain("VerdictStrip");
  });

  it("shows Run Review button when hasReview is false", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("Run Review");
    expect(content).toContain("handleRunReview");
  });

  it("handleRunReview sends message to bridge", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("handleRunReview");
    expect(content).toContain("bridge.sendMessage");
  });

  it("renders staleness warning when isStale is true", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("staleness-warning");
    expect(content).toContain("{#if isStale}");
  });

  it("isStale threshold is 3_600_000ms (1 hour)", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("3_600_000");
  });

  it("renders review impact panels section when hasReview", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("panel-left");
    expect(content).toContain("panel-center");
    expect(content).toContain("panel-right");
  });
});

// ── Deleted files — old split entry points must NOT exist ──

describe("old split entry points are deleted", () => {
  it("PrReviewPrep.svelte does NOT exist", () => {
    expect(existsSync(join(uiDir, "PrReviewPrep.svelte"))).toBe(false);
  });

  it("PrImpact.svelte does NOT exist", () => {
    expect(existsSync(join(uiDir, "PrImpact.svelte"))).toBe(false);
  });

  it("pr-review-prep.html does NOT exist", () => {
    expect(existsSync(join(uiDir, "pr-review-prep.html"))).toBe(false);
  });

  it("pr-impact.html does NOT exist", () => {
    expect(existsSync(join(uiDir, "pr-impact.html"))).toBe(false);
  });

  it("pr-review-prep.ts does NOT exist", () => {
    expect(existsSync(join(uiDir, "pr-review-prep.ts"))).toBe(false);
  });

  it("pr-impact.ts does NOT exist", () => {
    expect(existsSync(join(uiDir, "pr-impact.ts"))).toBe(false);
  });
});
