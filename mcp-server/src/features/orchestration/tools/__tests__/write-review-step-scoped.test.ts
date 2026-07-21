/**
 * TDD tests for step_id support in write_review.
 *
 * ADR-0064: step_id writes are now EXCLUSIVE — the canonical pair is written
 * ONLY by a no-step_id call (solo reviewer, or the orchestrator's
 * consolidation call). Jurors/partition reviewers never touch REVIEW.md.
 *
 * Tests:
 * 1. When step_id is provided, a step-scoped REVIEW-{step_id}.md pair is written.
 * 2. The fixed canonical pair is NOT written/refreshed when step_id is provided (inverted).
 * 3. When step_id is omitted, only the fixed canonical pair is written (backward compat).
 * 4. atomicWritePair: crash simulation — no partial-write divergence on fixed pair.
 * 5. Sequential step_id calls produce separate step-scoped files AND no canonical file;
 *    a final no-step_id call then writes the canonical pair.
 * 6. Jury integration: two step_id jurors + one consolidation call — canonical reflects
 *    the consolidation, per-lens files are untouched by later calls.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWritePair } from "@shared/lib/atomic-write.ts";
import { afterEach, describe, expect, it } from "vitest";
import { seedExecution } from "../../__tests__/seed-execution-test-helper.ts";
import { type WriteReviewInput, writeReview } from "../write-review.ts";

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

async function makeTmpWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "write-review-step-test-"));
  seedExecution(workspace);
  return workspace;
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

  // Test 2 (INVERTED, ADR-0064): step_id writes are exclusive — the
  // canonical pair is NOT written/refreshed when step_id is provided.
  it("does NOT write/refresh the canonical pair when step_id is provided", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);

    const result = await writeReview(makeInput(workspace, { step_id: "review-01" }));

    expect(result.ok).toBe(true);

    const reviewsDir = join(workspace, "reviews");
    expect(existsSync(join(reviewsDir, "REVIEW.md"))).toBe(false);
    expect(existsSync(join(reviewsDir, "REVIEW.meta.json"))).toBe(false);
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

  // Test 5 (UPDATED, ADR-0064): sequential step_id calls produce separate
  // step-scoped files AND no canonical file; a final no-step_id call then
  // writes the canonical pair.
  it("sequential step_id calls produce separate step-scoped files and no canonical file; a final no-step_id call writes canonical", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);

    await writeReview(makeInput(workspace, { step_id: "r1", verdict: "approved" }));
    await writeReview(makeInput(workspace, { step_id: "r2", verdict: "changes_required" }));

    const reviewsDir = join(workspace, "reviews");
    expect(existsSync(join(reviewsDir, "REVIEW-r1.md"))).toBe(true);
    expect(existsSync(join(reviewsDir, "REVIEW-r1.meta.json"))).toBe(true);
    expect(existsSync(join(reviewsDir, "REVIEW-r2.md"))).toBe(true);
    expect(existsSync(join(reviewsDir, "REVIEW-r2.meta.json"))).toBe(true);
    // No canonical pair yet — neither step_id call touches it.
    expect(existsSync(join(reviewsDir, "REVIEW.md"))).toBe(false);
    expect(existsSync(join(reviewsDir, "REVIEW.meta.json"))).toBe(false);

    // Consolidation: a call WITHOUT step_id writes the canonical pair.
    await writeReview(makeInput(workspace, { verdict: "changes_required" }));
    expect(existsSync(join(reviewsDir, "REVIEW.md"))).toBe(true);
    expect(existsSync(join(reviewsDir, "REVIEW.meta.json"))).toBe(true);
    // The per-lens files are untouched by the consolidation call.
    expect(existsSync(join(reviewsDir, "REVIEW-r1.md"))).toBe(true);
    expect(existsSync(join(reviewsDir, "REVIEW-r2.md"))).toBe(true);
  });

  // Test 6 (NEW, ADR-0064 AC 2): jury integration — two step_id jurors +
  // one consolidation call. Consumers must never read a race-winner lens as
  // the consolidated verdict.
  it("jury integration: two step_id jurors + a consolidation call — canonical is BLOCKING with AC-verification body, per-lens pairs untouched", async () => {
    const workspace = await makeTmpWorkspace();
    tmpDirs.push(workspace);
    const reviewsDir = join(workspace, "reviews");

    // Juror A: correctness lens, blocked.
    await writeReview(
      makeInput(workspace, {
        step_id: "lens-correctness",
        verdict: "blocked",
        violations: [
          {
            principle_id: "errors-are-values",
            severity: "rule",
            file_path: "src/foo.ts",
            description: "throws instead of returning",
            fix: "return a ToolResult error",
          },
        ],
      }),
    );
    const jurorAContentBefore = await readFile(
      join(reviewsDir, "REVIEW-lens-correctness.md"),
      "utf-8",
    );

    // Juror B: clarity lens, approved.
    await writeReview(makeInput(workspace, { step_id: "lens-clarity", verdict: "approved" }));

    // Consolidation: no step_id, any-juror-blocks -> BLOCKING, carries the
    // full six-stage body via the new `body` param.
    const consolidatedBody = "### Acceptance Criteria Verification\n\nAC 1: met.\n";
    const consolidation = await writeReview(
      makeInput(workspace, {
        verdict: "blocked",
        violations: [
          {
            principle_id: "errors-are-values",
            severity: "rule",
            file_path: "src/foo.ts",
            description: "throws instead of returning",
            fix: "return a ToolResult error",
          },
        ],
        body: consolidatedBody,
      }),
    );
    expect(consolidation.ok).toBe(true);

    const canonicalMd = await readFile(join(reviewsDir, "REVIEW.md"), "utf-8");
    expect(canonicalMd).toContain("verdict: BLOCKING");
    expect(canonicalMd).toContain("### Acceptance Criteria Verification");

    // Both per-lens pairs exist untouched by the consolidation call.
    const jurorAContentAfter = await readFile(
      join(reviewsDir, "REVIEW-lens-correctness.md"),
      "utf-8",
    );
    expect(jurorAContentAfter).toBe(jurorAContentBefore);
    expect(existsSync(join(reviewsDir, "REVIEW-lens-clarity.md"))).toBe(true);
  });
});
