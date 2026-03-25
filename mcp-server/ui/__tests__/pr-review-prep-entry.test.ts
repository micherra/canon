/**
 * pr-review-prep-entry.test.ts
 *
 * Verifies that the PR Review Prep MCP App entry files exist and are wired
 * correctly — parallel to the pr-impact-entry.test.ts pattern.
 *
 * Updated for v2 redesign (Wave 4): thin container composing NarrativeSummary,
 * ChangeStoryGrid, ImpactTabs — replaces old bucket-based monolithic layout.
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

// ── Svelte component structural contract (v2 thin container) ──

describe("PrReviewPrep.svelte component (v2 container)", () => {
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

  it("passes narrative to NarrativeSummary", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("narrative={data.narrative}");
  });

  it("passes totalFiles to NarrativeSummary", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("totalFiles={data.total_files}");
  });

  it("passes violationCount to NarrativeSummary", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("violationCount={totalViolations}");
  });

  it("passes netNewFiles to NarrativeSummary", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("netNewFiles={netNewFiles}");
  });

  it("computes totalViolations via $derived", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("totalViolations");
    expect(content).toContain("violations?.length");
  });

  it("computes netNewFiles via $derived", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("netNewFiles");
  });

  it("passes onPrompt={handlePrompt} to child components", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("onPrompt={handlePrompt}");
  });

  it("handlePrompt calls bridge.sendMessage", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("bridge.sendMessage");
    expect(content).toContain("handlePrompt");
  });

  it("renders staleness warning when isStale is true", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("staleness-warning");
    expect(content).toContain("isStale");
  });

  it("isStale threshold is 3_600_000ms (1 hour)", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("3_600_000");
  });

  it("shows incremental badge when data.incremental is true", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("incremental");
    expect(content).toContain("last_reviewed_sha");
  });

  it("passes blast_radius to ImpactTabs", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("blast_radius");
    expect(content).toContain("blastRadius={data.blast_radius}");
  });

  it("does NOT contain old bucket-section markup (removed in v2)", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).not.toContain("bucket-section");
  });

  it("does NOT contain old layer-tabs markup (removed in v2)", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).not.toContain("layer-tabs");
  });

  it("does NOT contain toggleBucket helper (removed in v2)", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).not.toContain("toggleBucket");
  });

  it("does NOT contain expandedBlastRadius state (removed in v2)", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).not.toContain("expandedBlastRadius");
  });

  it("does NOT have old review strategy or risk areas", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).not.toContain("Review Strategy");
    expect(content).not.toContain("Risk Areas");
    expect(content).not.toContain("sortBy");
  });
});
