/**
 * ADR-010 Integration Tests
 *
 * Cross-tool integration and coverage-gap tests for the structured agent output
 * contract system introduced in ADR-010.
 *
 * Focus areas:
 * 1. writeReview → executeEffects (persistReview) end-to-end round-trip
 * 2. writeTestReport / writeImplementationSummary → validateRequiredArtifacts
 * 3. validateRequiredArtifacts with .md artifact path (not .meta.json)
 * 4. write-review with empty honored list (declared Known Gap)
 *
 * Schema, required_artifacts, multi-artifact, and meta.json tests moved to adr010-effects.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StateDefinition } from "@domains/flows/flow-definition-schemas.ts";
import { clearStoreCache } from "@domains/workspaces/execution-store.ts";
import { DriftStore } from "@platform/storage/drift/store.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { executeEffects } from "../engine/effects.ts";
import { validateRequiredArtifacts } from "../tools/report-result.ts";
import { writeImplementationSummary } from "../tools/write-implementation-summary.ts";
import { writeReview } from "../tools/write-review.ts";
import { writeTestReport } from "../tools/write-test-report.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "adr010-integration-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

// 1. writeReview → executeEffects end-to-end round-trip

describe("writeReview → executeEffects (persistReview) end-to-end", () => {
  it("structured .meta.json written by writeReview is consumed correctly by executeEffects", async () => {
    const workspace = makeTmpDir();
    const projectDir = makeTmpDir();
    await mkdir(join(projectDir, ".canon"), { recursive: true });

    // Call writeReview as a real agent would
    const reviewResult = await writeReview({
      files: ["src/api.ts", "src/service.ts"],
      honored: ["errors-are-values", "thin-handlers"],
      score: {
        conventions: { passed: 2, total: 2 },
        opinions: { passed: 3, total: 4 },
        rules: { passed: 4, total: 5 },
      },
      slug: "my-task",
      verdict: "approved_with_concerns",
      violations: [
        {
          file_path: "src/api.ts",
          principle_id: "validate-at-boundaries",
          severity: "strong-opinion",
        },
      ],
      workspace,
    });

    assertOk(reviewResult);
    // reviewResult.meta_path is the .meta.json sidecar

    // Now run executeEffects as reportResult would after a review state
    const stateDef: StateDefinition = {
      effects: [{ artifact: "REVIEW.md", type: "persist_review" }],
      type: "single",
    };

    const effectResults = await executeEffects(stateDef, { artifacts: [], projectDir, workspace });

    expect(effectResults).toHaveLength(1);
    expect(effectResults[0].type).toBe("persist_review");
    expect(effectResults[0].recorded).toBe(1);
    expect(effectResults[0].errors).toHaveLength(0);

    // Verify the entry landed in DriftStore with correct mapped verdict
    const entries = await new DriftStore(projectDir).getReviews();
    expect(entries).toHaveLength(1);
    expect(entries[0].verdict).toBe("WARNING"); // approved_with_concerns → WARNING
    expect(entries[0].violations).toHaveLength(1);
    expect(entries[0].violations[0].principle_id).toBe("validate-at-boundaries");
    expect(entries[0].honored).toEqual(["errors-are-values", "thin-handlers"]);
  });

  it("BLOCKING verdict from writeReview lands correctly in DriftStore", async () => {
    const workspace = makeTmpDir();
    const projectDir = makeTmpDir();
    await mkdir(join(projectDir, ".canon"), { recursive: true });

    const reviewResult = await writeReview({
      files: ["src/secrets.ts"],
      honored: [],
      score: {
        conventions: { passed: 2, total: 2 },
        opinions: { passed: 1, total: 3 },
        rules: { passed: 0, total: 2 },
      },
      slug: "review-task",
      verdict: "blocked",
      violations: [
        { principle_id: "secrets-never-in-code", severity: "rule" },
        { principle_id: "no-silent-failures", severity: "strong-opinion" },
      ],
      workspace,
    });

    assertOk(reviewResult);

    const stateDef: StateDefinition = {
      effects: [{ artifact: "REVIEW.md", type: "persist_review" }],
      type: "single",
    };

    const effectResults = await executeEffects(stateDef, { artifacts: [], projectDir, workspace });

    expect(effectResults[0].recorded).toBe(1);
    const entries = await new DriftStore(projectDir).getReviews();
    expect(entries[0].verdict).toBe("BLOCKING"); // blocked → BLOCKING
    expect(entries[0].violations).toHaveLength(2);
    expect(entries[0].honored).toEqual([]);
  });

  it("writeReview with empty honored list produces parseable meta.json for executeEffects", async () => {
    // Declared Known Gap in adr010-02: no test for empty honored list
    const workspace = makeTmpDir();
    const projectDir = makeTmpDir();
    await mkdir(join(projectDir, ".canon"), { recursive: true });

    const reviewResult = await writeReview({
      files: [],
      honored: [], // explicitly empty
      score: {
        conventions: { passed: 1, total: 1 },
        opinions: { passed: 1, total: 2 },
        rules: { passed: 2, total: 3 },
      },
      slug: "no-honored",
      verdict: "changes_required",
      violations: [{ principle_id: "validate-at-boundaries", severity: "rule" }],
      workspace,
    });

    assertOk(reviewResult);
    expect(reviewResult.violation_count).toBe(1);

    const stateDef: StateDefinition = {
      effects: [{ artifact: "REVIEW.md", type: "persist_review" }],
      type: "single",
    };

    const effectResults = await executeEffects(stateDef, { artifacts: [], projectDir, workspace });

    expect(effectResults[0].recorded).toBe(1);
    const entries = await new DriftStore(projectDir).getReviews();
    expect(entries[0].verdict).toBe("WARNING"); // changes_required → WARNING
    expect(entries[0].honored).toEqual([]);
  });
});

// 2. writeTestReport → validateRequiredArtifacts (cross-tool)

describe("writeTestReport → validateRequiredArtifacts (cross-tool)", () => {
  it("meta.json written by writeTestReport satisfies validateRequiredArtifacts", async () => {
    const workspace = makeTmpDir();

    // Agent calls writeTestReport
    const writeResult = await writeTestReport({
      failed: 0,
      passed: 42,
      skipped: 2,
      slug: "my-epic",
      summary: "All tests passed.",
      workspace,
    });

    assertOk(writeResult);

    // validateRequiredArtifacts should find the .meta.json via plans/ search
    const validationError = await validateRequiredArtifacts(
      workspace,
      [],
      [{ name: "TEST-REPORT", type: "test_report" }],
    );

    expect(validationError).toBeNull();
  });

  it("meta.json written to plans/slug/ is found by validateRequiredArtifacts subdirectory search", async () => {
    const workspace = makeTmpDir();

    await writeTestReport({
      failed: 1,
      issues: [{ error: "assertion failed", test: "failing-test" }],
      passed: 10,
      skipped: 0,
      slug: "specific-task",
      summary: "Tests ran.",
      workspace,
    });

    const validationError = await validateRequiredArtifacts(
      workspace,
      [],
      [{ name: "TEST-REPORT", type: "test_report" }],
    );

    expect(validationError).toBeNull();
  });

  it("validateRequiredArtifacts fails when test_report artifact is not present", async () => {
    const workspace = makeTmpDir();

    // No writeTestReport call — no .meta.json files exist
    const validationError = await validateRequiredArtifacts(
      workspace,
      [],
      [{ name: "TEST-REPORT", type: "test_report" }],
    );

    expect(validationError).not.toBeNull();
    expect(validationError?.ok).toBe(false);
    expect(validationError?.error_code).toBe("INVALID_INPUT");
  });
});

// 3. writeImplementationSummary → validateRequiredArtifacts (cross-tool)

describe("writeImplementationSummary → validateRequiredArtifacts (cross-tool)", () => {
  it("meta.json written by writeImplementationSummary satisfies validateRequiredArtifacts", async () => {
    const workspace = makeTmpDir();

    const writeResult = await writeImplementationSummary({
      decisions_applied: ["dec-03"],
      files_changed: [
        {
          action: "added",
          path: "src/features/orchestration/tools/write-implementation-summary.ts",
        },
      ],
      slug: "my-epic",
      task_id: "adr010-03",
      workspace,
    });

    assertOk(writeResult);

    const validationError = await validateRequiredArtifacts(
      workspace,
      [],
      [{ name: "IMPLEMENTATION-SUMMARY", type: "implementation_summary" }],
    );

    expect(validationError).toBeNull();
  });

  it("validateRequiredArtifacts rejects implementation_summary type when test_report was written instead", async () => {
    const workspace = makeTmpDir();

    // Write a TEST-REPORT, then require an IMPLEMENTATION-SUMMARY
    await writeTestReport({
      failed: 0,
      passed: 5,
      skipped: 0,
      slug: "my-epic",
      summary: "Tests passed.",
      workspace,
    });

    const validationError = await validateRequiredArtifacts(
      workspace,
      [],
      [{ name: "IMPLEMENTATION-SUMMARY", type: "implementation_summary" }],
    );

    // IMPLEMENTATION-SUMMARY.meta.json doesn't exist — should be not found
    expect(validationError).not.toBeNull();
    expect(validationError?.ok).toBe(false);
    expect(validationError?.error_code).toBe("INVALID_INPUT");
  });
});

// 4. validateRequiredArtifacts with .meta.json path in artifacts list

describe("validateRequiredArtifacts — explicit .meta.json in artifacts list", () => {
  it("finds artifact when absolute .meta.json path is in artifacts list", async () => {
    const workspace = makeTmpDir();

    // Write the sidecar via writeReview
    const reviewResult = await writeReview({
      files: [],
      honored: ["errors-are-values"],
      score: {
        conventions: { passed: 1, total: 1 },
        opinions: { passed: 2, total: 2 },
        rules: { passed: 3, total: 3 },
      },
      slug: "my-review-task",
      verdict: "approved",
      violations: [],
      workspace,
    });
    assertOk(reviewResult);

    // Agent reports the absolute .meta.json path in artifacts list
    const validationError = await validateRequiredArtifacts(
      workspace,
      [reviewResult.meta_path], // absolute .meta.json path
      [{ name: "REVIEW", type: "review" }],
    );

    // Found directly in the reported artifacts list
    expect(validationError).toBeNull();
  });

  it("falls through to location search when artifact reported as .md (not .meta.json)", async () => {
    // When agent reports "reviews/REVIEW.md" (not "REVIEW.meta.json"), the path does not
    // match metaName in the artifacts list, so validateRequiredArtifacts falls through to the
    // location search (reviews/ and plans/). Since writeReview placed the .meta.json in
    // reviews/, the search succeeds.
    const workspace = makeTmpDir();

    await writeReview({
      files: [],
      honored: [],
      score: {
        conventions: { passed: 1, total: 1 },
        opinions: { passed: 1, total: 1 },
        rules: { passed: 1, total: 1 },
      },
      slug: "md-path-task",
      verdict: "approved",
      violations: [],
      workspace,
    });

    // Agent reports the .md path — does NOT match REVIEW.meta.json in basename check
    // Falls through to reviews/ location search which finds the .meta.json
    const validationError = await validateRequiredArtifacts(
      workspace,
      ["reviews/REVIEW.md"], // .md path, not .meta.json
      [{ name: "REVIEW", type: "review" }],
    );

    expect(validationError).toBeNull();
  });

  it("returns INVALID_INPUT when artifact reported as .meta.json path that does not exist", async () => {
    const workspace = makeTmpDir();
    await mkdir(join(workspace, "reviews"), { recursive: true });
    // Write only the .md file, not the .meta.json sidecar
    await writeFile(join(workspace, "reviews", "REVIEW.md"), "# Review\n", "utf-8");

    const missingMetaPath = join(workspace, "reviews", "REVIEW.meta.json");

    const validationError = await validateRequiredArtifacts(
      workspace,
      [missingMetaPath], // explicit absolute .meta.json path that does not exist
      [{ name: "REVIEW", type: "review" }],
    );

    expect(validationError).not.toBeNull();
    expect(validationError?.ok).toBe(false);
    expect(validationError?.error_code).toBe("INVALID_INPUT");
    expect(validationError?.message).toContain("not readable");
  });
});
