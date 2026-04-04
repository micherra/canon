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
 * 5. RequiredArtifactSchema YAML round-trip via flow-schema
 * 6. write-review → reportResult with required_artifacts end-to-end
 * 7. Multiple artifact types validated together in a single reportResult call
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeReview } from "../tools/write-review.ts";
import { writeTestReport } from "../tools/write-test-report.ts";
import { writeImplementationSummary } from "../tools/write-implementation-summary.ts";
import { validateRequiredArtifacts } from "../tools/report-result.ts";
import { reportResult } from "../tools/report-result.ts";
import { executeEffects } from "../orchestration/effects.ts";
import { DriftStore } from "../drift/store.ts";
import { getExecutionStore, clearStoreCache } from "../orchestration/execution-store.ts";
import { assertOk } from "../utils/tool-result.ts";
import type { ResolvedFlow, RequiredArtifact, StateDefinition } from "../orchestration/flow-schema.ts";
import { RequiredArtifactSchema } from "../orchestration/flow-schema.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "adr010-integration-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearStoreCache();
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

/** Create a workspace with the execution store initialized. */
function setupWorkspace(workspace: string, flow: ResolvedFlow): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    flow: flow.name,
    task: "task",
    entry: flow.entry,
    current_state: flow.entry,
    base_commit: "abc1234",
    started: now,
    last_updated: now,
    branch: "main",
    sanitized: "main",
    created: now,
    tier: "medium",
    flow_name: flow.name,
    slug: "test-slug",
  });
  for (const [stateId, stateDef] of Object.entries(flow.states)) {
    store.upsertState(stateId, { status: "pending", entries: 0 });
    if ("max_iterations" in stateDef && stateDef.max_iterations !== undefined) {
      store.upsertIteration(stateId, {
        count: 0,
        max: stateDef.max_iterations,
        history: [],
        cannot_fix: [],
      });
    }
  }
}

function makeFlow(requiredArtifacts?: RequiredArtifact[]): ResolvedFlow {
  const stateDef = requiredArtifacts
    ? {
        type: "single" as const,
        transitions: { done: "terminal" },
        required_artifacts: requiredArtifacts,
      }
    : {
        type: "single" as const,
        transitions: { done: "terminal" },
      };
  return {
    name: "adr010-integration-flow",
    description: "ADR-010 integration test flow",
    entry: "implement",
    spawn_instructions: { implement: "Implement." },
    states: {
      implement: stateDef,
      terminal: { type: "terminal" as const },
    },
  };
}

// ---------------------------------------------------------------------------
// 1. writeReview → executeEffects end-to-end round-trip
// ---------------------------------------------------------------------------

describe("writeReview → executeEffects (persistReview) end-to-end", () => {
  it("structured .meta.json written by writeReview is consumed correctly by executeEffects", async () => {
    const workspace = makeTmpDir();
    const projectDir = makeTmpDir();
    await mkdir(join(projectDir, ".canon"), { recursive: true });

    // Call writeReview as a real agent would
    const reviewResult = await writeReview({
      workspace,
      slug: "my-task",
      verdict: "approved_with_concerns",
      violations: [
        {
          principle_id: "validate-at-boundaries",
          severity: "strong-opinion",
          file_path: "src/api.ts",
        },
      ],
      honored: ["errors-are-values", "thin-handlers"],
      score: {
        rules: { passed: 4, total: 5 },
        opinions: { passed: 3, total: 4 },
        conventions: { passed: 2, total: 2 },
      },
      files: ["src/api.ts", "src/service.ts"],
    });

    assertOk(reviewResult);
    // reviewResult.meta_path is the .meta.json sidecar

    // Now run executeEffects as reportResult would after a review state
    const stateDef: StateDefinition = {
      type: "single",
      effects: [{ type: "persist_review", artifact: "REVIEW.md" }],
    };

    const effectResults = await executeEffects(stateDef, workspace, [], projectDir);

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
      workspace,
      slug: "review-task",
      verdict: "blocked",
      violations: [
        { principle_id: "secrets-never-in-code", severity: "rule" },
        { principle_id: "no-silent-failures", severity: "strong-opinion" },
      ],
      honored: [],
      score: {
        rules: { passed: 0, total: 2 },
        opinions: { passed: 1, total: 3 },
        conventions: { passed: 2, total: 2 },
      },
      files: ["src/secrets.ts"],
    });

    assertOk(reviewResult);

    const stateDef: StateDefinition = {
      type: "single",
      effects: [{ type: "persist_review", artifact: "REVIEW.md" }],
    };

    const effectResults = await executeEffects(stateDef, workspace, [], projectDir);

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
      workspace,
      slug: "no-honored",
      verdict: "changes_required",
      violations: [{ principle_id: "validate-at-boundaries", severity: "rule" }],
      honored: [], // explicitly empty
      score: {
        rules: { passed: 2, total: 3 },
        opinions: { passed: 1, total: 2 },
        conventions: { passed: 1, total: 1 },
      },
      files: [],
    });

    assertOk(reviewResult);
    expect(reviewResult.violation_count).toBe(1);

    const stateDef: StateDefinition = {
      type: "single",
      effects: [{ type: "persist_review", artifact: "REVIEW.md" }],
    };

    const effectResults = await executeEffects(stateDef, workspace, [], projectDir);

    expect(effectResults[0].recorded).toBe(1);
    const entries = await new DriftStore(projectDir).getReviews();
    expect(entries[0].verdict).toBe("WARNING"); // changes_required → WARNING
    expect(entries[0].honored).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. writeTestReport → validateRequiredArtifacts (cross-tool)
// ---------------------------------------------------------------------------

describe("writeTestReport → validateRequiredArtifacts (cross-tool)", () => {
  it("meta.json written by writeTestReport satisfies validateRequiredArtifacts", async () => {
    const workspace = makeTmpDir();

    // Agent calls writeTestReport
    const writeResult = await writeTestReport({
      workspace,
      slug: "my-epic",
      summary: "All tests passed.",
      passed: 42,
      failed: 0,
      skipped: 2,
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
      workspace,
      slug: "specific-task",
      summary: "Tests ran.",
      passed: 10,
      failed: 1,
      skipped: 0,
      issues: [{ test: "failing-test", error: "assertion failed" }],
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

// ---------------------------------------------------------------------------
// 3. writeImplementationSummary → validateRequiredArtifacts (cross-tool)
// ---------------------------------------------------------------------------

describe("writeImplementationSummary → validateRequiredArtifacts (cross-tool)", () => {
  it("meta.json written by writeImplementationSummary satisfies validateRequiredArtifacts", async () => {
    const workspace = makeTmpDir();

    const writeResult = await writeImplementationSummary({
      workspace,
      slug: "my-epic",
      task_id: "adr010-03",
      files_changed: [
        { path: "src/tools/write-implementation-summary.ts", action: "added" },
      ],
      decisions_applied: ["dec-03"],
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
      workspace,
      slug: "my-epic",
      summary: "Tests passed.",
      passed: 5,
      failed: 0,
      skipped: 0,
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

// ---------------------------------------------------------------------------
// 4. validateRequiredArtifacts with .meta.json path in artifacts list
// ---------------------------------------------------------------------------

describe("validateRequiredArtifacts — explicit .meta.json in artifacts list", () => {
  it("finds artifact when absolute .meta.json path is in artifacts list", async () => {
    const workspace = makeTmpDir();

    // Write the sidecar via writeReview
    const reviewResult = await writeReview({
      workspace,
      slug: "my-review-task",
      verdict: "approved",
      violations: [],
      honored: ["errors-are-values"],
      score: {
        rules: { passed: 3, total: 3 },
        opinions: { passed: 2, total: 2 },
        conventions: { passed: 1, total: 1 },
      },
      files: [],
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
      workspace,
      slug: "md-path-task",
      verdict: "approved",
      violations: [],
      honored: [],
      score: {
        rules: { passed: 1, total: 1 },
        opinions: { passed: 1, total: 1 },
        conventions: { passed: 1, total: 1 },
      },
      files: [],
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

// ---------------------------------------------------------------------------
// 5. RequiredArtifactSchema — schema validation
// ---------------------------------------------------------------------------

describe("RequiredArtifactSchema — Zod schema validation", () => {
  it("accepts valid required artifact declaration", () => {
    const parsed = RequiredArtifactSchema.safeParse({
      name: "REVIEW",
      type: "review",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.name).toBe("REVIEW");
      expect(parsed.data.type).toBe("review");
    }
  });

  it("accepts all three ADR-010 artifact types", () => {
    const types = ["test_report", "review", "implementation_summary"];
    for (const type of types) {
      const parsed = RequiredArtifactSchema.safeParse({
        name: "ARTIFACT",
        type,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("rejects required artifact missing name field", () => {
    const parsed = RequiredArtifactSchema.safeParse({ type: "review" });
    expect(parsed.success).toBe(false);
  });

  it("rejects required artifact missing type field", () => {
    const parsed = RequiredArtifactSchema.safeParse({ name: "REVIEW" });
    expect(parsed.success).toBe(false);
  });

  it("accepts arbitrary type strings (schema uses z.string() not enum)", () => {
    // The schema uses z.string() not a restricted enum for forward compat
    const parsed = RequiredArtifactSchema.safeParse({
      name: "FUTURE-ARTIFACT",
      type: "future_type",
    });
    expect(parsed.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. writeReview → reportResult with required_artifacts (full flow)
// ---------------------------------------------------------------------------

describe("writeReview → reportResult with required_artifacts (end-to-end)", () => {
  it("reportResult succeeds when writeReview produced the required artifact", async () => {
    const workspace = makeTmpDir();
    const flow = makeFlow([{ name: "REVIEW", type: "review" }]);
    setupWorkspace(workspace, flow);

    // Reviewer writes the review via the structured write tool
    const writeResult = await writeReview({
      workspace,
      slug: "my-epic",
      verdict: "approved",
      violations: [],
      honored: ["errors-are-values"],
      score: {
        rules: { passed: 5, total: 5 },
        opinions: { passed: 4, total: 4 },
        conventions: { passed: 2, total: 2 },
      },
      files: ["src/index.ts"],
    });
    assertOk(writeResult);

    // Orchestrator calls reportResult with the artifact path
    const result = await reportResult({
      workspace,
      state_id: "implement",
      status_keyword: "DONE",
      flow,
      artifacts: ["reviews/REVIEW.md"],
    });

    assertOk(result);
    expect(result.transition_condition).toBe("done");
  });

  it("reportResult fails when writeReview was not called but is required", async () => {
    const workspace = makeTmpDir();
    const flow = makeFlow([{ name: "REVIEW", type: "review" }]);
    setupWorkspace(workspace, flow);

    // No writeReview call — agent only wrote a plain markdown REVIEW.md
    await mkdir(join(workspace, "reviews"), { recursive: true });
    await writeFile(join(workspace, "reviews", "REVIEW.md"), "# Plain Review\n", "utf-8");
    // But no REVIEW.meta.json sidecar

    const result = await reportResult({
      workspace,
      state_id: "implement",
      status_keyword: "DONE",
      flow,
      artifacts: ["reviews/REVIEW.md"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("REVIEW");
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Multiple artifact types validated together
// ---------------------------------------------------------------------------

describe("Multiple required artifact types in a single state", () => {
  it("all artifacts present: test_report + review → reportResult succeeds", async () => {
    const workspace = makeTmpDir();
    const flow = makeFlow([
      { name: "TEST-REPORT", type: "test_report" },
      { name: "REVIEW", type: "review" },
    ]);
    setupWorkspace(workspace, flow);

    // Tester writes TEST-REPORT
    await writeTestReport({
      workspace,
      slug: "my-epic",
      summary: "All tests passed.",
      passed: 50,
      failed: 0,
      skipped: 0,
    });

    // Reviewer writes REVIEW
    await writeReview({
      workspace,
      slug: "my-epic",
      verdict: "approved",
      violations: [],
      honored: ["errors-are-values"],
      score: {
        rules: { passed: 5, total: 5 },
        opinions: { passed: 3, total: 3 },
        conventions: { passed: 1, total: 1 },
      },
      files: ["src/index.ts"],
    });

    const result = await reportResult({
      workspace,
      state_id: "implement",
      status_keyword: "DONE",
      flow,
      artifacts: ["plans/my-epic/TEST-REPORT.md", "reviews/REVIEW.md"],
    });

    assertOk(result);
    expect(result.transition_condition).toBe("done");
  });

  it("fails when only one of two required artifacts is present", async () => {
    const workspace = makeTmpDir();
    const flow = makeFlow([
      { name: "TEST-REPORT", type: "test_report" },
      { name: "REVIEW", type: "review" },
    ]);
    setupWorkspace(workspace, flow);

    // Only writeTestReport — no writeReview
    await writeTestReport({
      workspace,
      slug: "my-epic",
      summary: "Tests passed.",
      passed: 10,
      failed: 0,
      skipped: 0,
    });

    const result = await reportResult({
      workspace,
      state_id: "implement",
      status_keyword: "DONE",
      flow,
      artifacts: ["plans/my-epic/TEST-REPORT.md"],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("REVIEW");
    }
  });

  it("validateRequiredArtifacts succeeds when all three artifact types are present", async () => {
    const workspace = makeTmpDir();

    await writeTestReport({
      workspace,
      slug: "full-epic",
      summary: "All tests passed.",
      passed: 20,
      failed: 0,
      skipped: 1,
    });

    await writeReview({
      workspace,
      slug: "full-epic",
      verdict: "approved",
      violations: [],
      honored: ["errors-are-values"],
      score: {
        rules: { passed: 3, total: 3 },
        opinions: { passed: 2, total: 2 },
        conventions: { passed: 1, total: 1 },
      },
      files: [],
    });

    await writeImplementationSummary({
      workspace,
      slug: "full-epic",
      task_id: "task-01",
      files_changed: [{ path: "src/index.ts", action: "modified" }],
    });

    const required: RequiredArtifact[] = [
      { name: "TEST-REPORT", type: "test_report" },
      { name: "REVIEW", type: "review" },
      { name: "IMPLEMENTATION-SUMMARY", type: "implementation_summary" },
    ];

    const validationError = await validateRequiredArtifacts(workspace, [], required);
    expect(validationError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. write-review meta.json is readable after writeReview (content verification)
// ---------------------------------------------------------------------------

describe("writeReview meta.json content structure", () => {
  it("meta.json contains verdict_original alongside mapped verdict", async () => {
    const workspace = makeTmpDir();

    const result = await writeReview({
      workspace,
      slug: "verify-meta",
      verdict: "approved_with_concerns",
      violations: [],
      honored: [],
      score: {
        rules: { passed: 1, total: 1 },
        opinions: { passed: 1, total: 1 },
        conventions: { passed: 1, total: 1 },
      },
      files: [],
    });

    assertOk(result);
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));

    // Both original and mapped verdicts present
    expect(meta.verdict_original).toBe("approved_with_concerns");
    expect(meta.verdict).toBe("WARNING");
    expect(meta._type).toBe("review");
    expect(meta._version).toBe(1);
  });

  it("write-review with violations stores description and fix in meta.json even though markdown table omits them", async () => {
    // Declared Known Gap in adr010-02: violations with description and fix stored in meta but not rendered in table
    const workspace = makeTmpDir();

    const result = await writeReview({
      workspace,
      slug: "violation-meta",
      verdict: "changes_required",
      violations: [
        {
          principle_id: "validate-at-boundaries",
          severity: "rule",
          file_path: "src/api.ts",
          description: "Input not validated",
          fix: "Add zod schema at handler entry",
        },
      ],
      honored: [],
      score: {
        rules: { passed: 0, total: 1 },
        opinions: { passed: 1, total: 1 },
        conventions: { passed: 1, total: 1 },
      },
      files: ["src/api.ts"],
    });

    assertOk(result);
    const meta = JSON.parse(await readFile(result.meta_path, "utf-8"));

    // Full violation data present in meta.json
    expect(meta.violations).toHaveLength(1);
    expect(meta.violations[0].description).toBe("Input not validated");
    expect(meta.violations[0].fix).toBe("Add zod schema at handler entry");
    expect(meta.violations[0].principle_id).toBe("validate-at-boundaries");
  });
});
