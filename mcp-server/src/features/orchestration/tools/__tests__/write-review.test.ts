/**
 * write-review.ts tests — confidence adapter integration
 *
 * Tests that writeReview correctly handles the optional confidenceAdapter:
 * - Backward compat: no confidenceAdapter → violations without confidence
 * - With adapter: populates missing confidence
 * - Pre-existing confidence is preserved (not overwritten)
 * - Generated markdown includes Confidence column
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfidenceAnnotation } from "@shared/lib/confidence.ts";
import { afterEach, describe, expect, it } from "vitest";
import { seedExecution } from "../../__tests__/seed-execution-test-helper.ts";
import { type ConfidenceAdapter, type WriteReviewInput, writeReview } from "../write-review.ts";

// ---- Helpers ----

async function makeTmpWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "write-review-test-"));
  seedExecution(workspace);
  return workspace;
}

const baseInput: WriteReviewInput = {
  workspace: "", // filled in per test
  slug: "test-slug",
  verdict: "changes_required",
  violations: [
    {
      principle_id: "errors-are-values",
      severity: "rule",
      file_path: "src/foo.ts",
    },
  ],
  honored: ["simplicity-first"],
  score: {
    rules: { passed: 3, total: 4 },
    opinions: { passed: 5, total: 5 },
    conventions: { passed: 2, total: 3 },
  },
  files: ["src/foo.ts"],
};

const highConfidence: ConfidenceAnnotation = {
  score: 0.85,
  tier: "high",
  basis: [{ signal: "violation_history", weight: 1.0, detail: "violated 10 times" }],
  sample_size: 20,
};

const mockAdapter: ConfidenceAdapter = {
  computeViolationConfidence: () => highConfidence,
};

const tmpDirs: string[] = [];

afterEach(async () => {
  const dirs = tmpDirs.splice(0);
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

// ---- Tests ----

describe("writeReview — backward compatibility (no confidenceAdapter)", () => {
  it("produces violations without confidence field", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);
    const result = await writeReview({ ...baseInput, workspace });
    expect(result.ok).toBe(true);
    // Violations in meta.json should not have confidence
    const meta = JSON.parse(
      await readFile(join(workspace, "reviews", "REVIEW.meta.json"), "utf-8"),
    );
    expect(meta.violations[0].confidence).toBeUndefined();
  });
});

describe("writeReview — with confidenceAdapter", () => {
  it("adds confidence to violations that lack it", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);
    const result = await writeReview({ ...baseInput, workspace }, undefined, mockAdapter);
    expect(result.ok).toBe(true);
    const meta = JSON.parse(
      await readFile(join(workspace, "reviews", "REVIEW.meta.json"), "utf-8"),
    );
    expect(meta.violations[0].confidence).toEqual(highConfidence);
  });

  it("preserves pre-existing confidence on violations (does not overwrite)", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);
    const existingConfidence: ConfidenceAnnotation = {
      score: 0.3,
      tier: "low",
      basis: [{ signal: "pre_existing", weight: 1.0, detail: "already set" }],
      sample_size: 5,
    };
    const input: WriteReviewInput = {
      ...baseInput,
      workspace,
      violations: [
        {
          principle_id: "errors-are-values",
          severity: "rule",
          file_path: "src/foo.ts",
          confidence: existingConfidence,
        },
      ],
    };
    // Even with adapter, pre-existing confidence must be preserved
    const result = await writeReview(input, undefined, mockAdapter);
    expect(result.ok).toBe(true);
    const meta = JSON.parse(
      await readFile(join(workspace, "reviews", "REVIEW.meta.json"), "utf-8"),
    );
    expect(meta.violations[0].confidence).toEqual(existingConfidence);
  });

  it("generated markdown includes Confidence column", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);
    await writeReview({ ...baseInput, workspace }, undefined, mockAdapter);
    const markdown = await readFile(join(workspace, "reviews", "REVIEW.md"), "utf-8");
    expect(markdown).toContain("| Principle | Severity | Location | Confidence |");
    expect(markdown).toContain("HIGH");
  });
});
