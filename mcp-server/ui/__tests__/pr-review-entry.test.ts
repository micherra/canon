/**
 * pr-review-entry.test.ts
 *
 * Migration guard: verifies that old split entry points no longer exist
 * (merged into unified PrReview view).
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const Dirname = dirname(fileURLToPath(import.meta.url));
const uiDir = join(Dirname, "..");

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
