/**
 * pr-review-entry.test.ts
 *
 * Migration guard: verifies that old split entry points no longer exist
 * (merged into unified PrReview view).
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const uiDir = join(__dirname, "..");

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
