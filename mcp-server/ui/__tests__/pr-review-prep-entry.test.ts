/**
 * pr-review-prep-entry.test.ts
 *
 * Verifies that the PR Review Prep MCP App entry files exist and are wired
 * correctly — parallel to the pr-impact-entry.test.ts pattern.
 *
 * Updated for Wave 2 redesign: narrative banner, bucket sections, layer tabs,
 * blast radius panels replace the old strategy/risk/file-by-layer layout.
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

  it("renders narrative banner with data.narrative", () => {
    // Wave 2: narrative banner replaces old review strategy description
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("narrative");
    expect(content).toContain("data.narrative");
  });

  it("renders layer navigation tabs", () => {
    // Wave 2: horizontal layer tabs replace old collapsed layer groups
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("layer-tabs");
    expect(content).toContain("activeLayer");
  });

  it("has All tab that resets activeLayer to null", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("All");
    expect(content).toContain("null");
  });

  it("renders needs-attention bucket section", () => {
    // Wave 2: three bucket sections replace strategy/risk/layer panels
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("needs-attention");
    expect(content).toContain("needsAttention");
  });

  it("renders worth-a-look bucket section", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("worth-a-look");
    expect(content).toContain("worthALook");
  });

  it("renders low-risk bucket section", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("low-risk");
    expect(content).toContain("lowRisk");
  });

  it("low-risk bucket is collapsed by default", () => {
    // collapsedBuckets is initialized with "low-risk" already in the set
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain('new Set(["low-risk"])');
  });

  it("uses filteredFiles derived state for layer filtering", () => {
    // Layer tabs filter files across all buckets via filteredFiles
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("filteredFiles");
  });

  it("renders reason text on each file row", () => {
    // Wave 2: file.reason replaces numeric priority score display
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("file.reason");
    expect(content).toContain("reason-text");
  });

  it("does NOT display priority_score values", () => {
    // priority_score is internal — not shown to users
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).not.toContain("priority_score.toFixed");
    expect(content).not.toContain("priority-badge");
  });

  it("renders blast radius panels", () => {
    // Wave 2: expandable blast radius panels for high-impact files
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("blast_radius");
    expect(content).toContain("blast-radius");
    expect(content).toContain("expandedBlastRadius");
  });

  it("blast radius shows affected file count", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("affects");
    expect(content).toContain("affected.length");
  });

  it("blast radius groups by depth", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("depth");
    expect(content).toContain("Direct dependents");
  });

  it("has collapsible bucket sections (collapsedBuckets)", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("collapsedBuckets");
    expect(content).toContain("toggleBucket");
  });

  it("shows incremental badge when data.incremental is true", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("incremental");
    expect(content).toContain("last_reviewed_sha");
  });

  it("shows error warning when data.error is set", () => {
    // The header bar shows a warning if the tool returned an error (partial data case)
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("data.error");
  });

  it("imports getLayerColor from lib/constants", () => {
    // Layer dots are colored using getLayerColor — verifies the constants contract
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("getLayerColor");
    expect(content).toContain("lib/constants");
  });

  it("preserves status icon helpers", () => {
    // statusIcon and statusClass helpers are kept from old component
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("statusIcon");
    expect(content).toContain("statusClass");
  });

  it("preserves shortPath helper", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("shortPath");
  });

  it("preserves formatAge helper", () => {
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).toContain("formatAge");
  });

  it("does NOT have old review strategy or risk areas", () => {
    // Old panels removed; buckets are the new model
    const content = readFileSync(sveltePath, "utf-8");
    expect(content).not.toContain("Review Strategy");
    expect(content).not.toContain("Risk Areas");
    expect(content).not.toContain("sortBy");
  });
});
