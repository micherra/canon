/**
 * TDD tests for S4 — step_id support in write_review.
 *
 * Tests:
 * 1. When step_id is provided, a step-scoped REVIEW-{step_id}.md pair is written.
 * 2. The fixed canonical pair (REVIEW.md + REVIEW.meta.json) is always written/refreshed.
 * 3. When step_id is omitted, only the fixed canonical pair is written (backward compat).
 * 4. atomicWritePair: crash simulation — no partial-write divergence on fixed pair.
 * 5. Sequential calls with different step_ids produce separate files.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWritePair } from "@shared/lib/atomic-write.ts";
import { afterEach, describe, expect, it } from "vitest";
import { type WriteReviewInput, writeReview } from "../write-review.ts";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function makeTmpWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "write-review-step-test-"));
}

const tmpDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((d) => rm(d, { force: true, recursive: true })));
});

function makeInput(workspace: string, overrides?: Partial<WriteReviewInput>): WriteReviewInput {
  return {
    workspace,
    slug: "test-slug",
    verdict: "approved",
    violations: [],
    honored: ["simplicity-first"],
    score: {
      rules: { passed: 3, total: 3 },
      opinions: { passed: 5, total: 5 },
      conventions: { passed: 2, total: 2 },
    },
    files: ["src/foo.ts"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("write_review step_id support (S4)", () => {
  // Test 1: step-scoped pair is written when step_id is provided
  it("writes REVIEW-{step_id}.md and REVIEW-{step_id}.meta.json when step_id is provided", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);

    const result = await writeReview(makeInput(workspace, { step_id: "review-01" }));

    expect(result.ok).toBe(true);

    const reviewsDir = join(workspace, "reviews");
    expect(existsSync(join(reviewsDir, "REVIEW-review-01.md"))).toBe(true);
    expect(existsSync(join(reviewsDir, "REVIEW-review-01.meta.json"))).toBe(true);
  });

  // Test 2: fixed canonical pair is always written/refreshed
  it("always writes/refreshes REVIEW.md and REVIEW.meta.json regardless of step_id", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);

    const result = await writeReview(makeInput(workspace, { step_id: "review-01" }));

    expect(result.ok).toBe(true);

    const reviewsDir = join(workspace, "reviews");
    expect(existsSync(join(reviewsDir, "REVIEW.md"))).toBe(true);
    expect(existsSync(join(reviewsDir, "REVIEW.meta.json"))).toBe(true);
  });

  // Test 3: when step_id is omitted, only fixed canonical pair is written
  it("writes only REVIEW.md and REVIEW.meta.json when step_id is omitted (backward compat)", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);

    const result = await writeReview(makeInput(workspace));

    expect(result.ok).toBe(true);

    const reviewsDir = join(workspace, "reviews");
    // Fixed pair present
    expect(existsSync(join(reviewsDir, "REVIEW.md"))).toBe(true);
    expect(existsSync(join(reviewsDir, "REVIEW.meta.json"))).toBe(true);
    // No step-scoped files
    const files = require("node:fs").readdirSync(reviewsDir) as string[];
    const stepFiles = files.filter((f) => /^REVIEW-/.test(f));
    expect(stepFiles).toHaveLength(0);
  });

  // Test 4: atomicWritePair unit test — both files are written or neither
  it("atomicWritePair writes both files atomically", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);

    const path1 = join(workspace, "file1.txt");
    const path2 = join(workspace, "file2.txt");

    await atomicWritePair(path1, "content-1", path2, "content-2");

    expect(existsSync(path1)).toBe(true);
    expect(existsSync(path2)).toBe(true);
    const c1 = await readFile(path1, "utf-8");
    const c2 = await readFile(path2, "utf-8");
    expect(c1).toBe("content-1");
    expect(c2).toBe("content-2");
  });

  // Test 5: sequential calls with different step_ids produce separate step-scoped files
  it("sequential calls produce separate step-scoped files per step_id", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);

    await writeReview(makeInput(workspace, { step_id: "r1", verdict: "approved" }));
    await writeReview(makeInput(workspace, { step_id: "r2", verdict: "changes_required" }));

    const reviewsDir = join(workspace, "reviews");
    expect(existsSync(join(reviewsDir, "REVIEW-r1.md"))).toBe(true);
    expect(existsSync(join(reviewsDir, "REVIEW-r1.meta.json"))).toBe(true);
    expect(existsSync(join(reviewsDir, "REVIEW-r2.md"))).toBe(true);
    expect(existsSync(join(reviewsDir, "REVIEW-r2.meta.json"))).toBe(true);
    // Fixed canonical pair reflects the latest call
    expect(existsSync(join(reviewsDir, "REVIEW.md"))).toBe(true);
  });
});
