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

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DriftStore } from "../drift/store.ts";
import { executeEffects } from "../orchestration/effects.ts";
import { clearStoreCache, getExecutionStore } from "../orchestration/execution-store.ts";
import type {
  RequiredArtifact,
  ResolvedFlow,
  StateDefinition,
} from "../orchestration/flow-schema.ts";
import { RequiredArtifactSchema } from "../orchestration/flow-schema.ts";
import { reportResult, validateRequiredArtifacts } from "../tools/report-result.ts";
import { writeImplementationSummary } from "../tools/write-implementation-summary.ts";
import { writeReview } from "../tools/write-review.ts";
import { writeTestReport } from "../tools/write-test-report.ts";
import { assertOk } from "../utils/tool-result.ts";

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

/** Create a workspace with the execution store initialized. */
function setupWorkspace(workspace: string, flow: ResolvedFlow): void {
  const store = getExecutionStore(workspace);
  const now = new Date().toISOString();
  store.initExecution({
    base_commit: "abc1234",
    branch: "main",
    created: now,
    current_state: flow.entry,
    entry: flow.entry,
    flow: flow.name,
    flow_name: flow.name,
    last_updated: now,
    sanitized: "main",
    slug: "test-slug",
    started: now,
    task: "task",
    tier: "medium",
  });
  for (const [stateId, stateDef] of Object.entries(flow.states)) {
    store.upsertState(stateId, { entries: 0, status: "pending" });
    if ("max_iterations" in stateDef && stateDef.max_iterations !== undefined) {
      store.upsertIteration(stateId, {
        cannot_fix: [],
        count: 0,
        history: [],
        max: stateDef.max_iterations,
      });
    }
  }
}

function makeFlow(requiredArtifacts?: RequiredArtifact[]): ResolvedFlow {
  const stateDef = requiredArtifacts
    ? {
        required_artifacts: requiredArtifacts,
        transitions: { done: "terminal" },
        type: "single" as const,
      }
    : {
        transitions: { done: "terminal" },
        type: "single" as const,
      };
  return {
    description: "ADR-010 integration test flow",
    entry: "implement",
    name: "adr010-integration-flow",
    spawn_instructions: { implement: "Implement." },
    states: {
      implement: stateDef,
      terminal: { type: "terminal" as const },
    },
  };
}

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
      files_changed: [{ action: "added", path: "src/tools/write-implementation-summary.ts" }],
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

// 5. RequiredArtifactSchema — schema validation

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

// 6. writeReview → reportResult with required_artifacts (full flow)

describe("writeReview → reportResult with required_artifacts (end-to-end)", () => {
  it("reportResult succeeds when writeReview produced the required artifact", async () => {
    const workspace = makeTmpDir();
    const flow = makeFlow([{ name: "REVIEW", type: "review" }]);
    setupWorkspace(workspace, flow);

    // Reviewer writes the review via the structured write tool
    const writeResult = await writeReview({
      files: ["src/index.ts"],
      honored: ["errors-are-values"],
      score: {
        conventions: { passed: 2, total: 2 },
        opinions: { passed: 4, total: 4 },
        rules: { passed: 5, total: 5 },
      },
      slug: "my-epic",
      verdict: "approved",
      violations: [],
      workspace,
    });
    assertOk(writeResult);

    // Orchestrator calls reportResult with the artifact path
    const result = await reportResult({
      artifacts: ["reviews/REVIEW.md"],
      flow,
      state_id: "implement",
      status_keyword: "DONE",
      workspace,
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
      artifacts: ["reviews/REVIEW.md"],
      flow,
      state_id: "implement",
      status_keyword: "DONE",
      workspace,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error_code).toBe("INVALID_INPUT");
      expect(result.message).toContain("REVIEW");
    }
  });
});

// 7. Multiple artifact types validated together

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
      failed: 0,
      passed: 50,
      skipped: 0,
      slug: "my-epic",
      summary: "All tests passed.",
      workspace,
    });

    // Reviewer writes REVIEW
    await writeReview({
      files: ["src/index.ts"],
      honored: ["errors-are-values"],
      score: {
        conventions: { passed: 1, total: 1 },
        opinions: { passed: 3, total: 3 },
        rules: { passed: 5, total: 5 },
      },
      slug: "my-epic",
      verdict: "approved",
      violations: [],
      workspace,
    });

    const result = await reportResult({
      artifacts: ["plans/my-epic/TEST-REPORT.md", "reviews/REVIEW.md"],
      flow,
      state_id: "implement",
      status_keyword: "DONE",
      workspace,
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
      failed: 0,
      passed: 10,
      skipped: 0,
      slug: "my-epic",
      summary: "Tests passed.",
      workspace,
    });

    const result = await reportResult({
      artifacts: ["plans/my-epic/TEST-REPORT.md"],
      flow,
      state_id: "implement",
      status_keyword: "DONE",
      workspace,
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
      failed: 0,
      passed: 20,
      skipped: 1,
      slug: "full-epic",
      summary: "All tests passed.",
      workspace,
    });

    await writeReview({
      files: [],
      honored: ["errors-are-values"],
      score: {
        conventions: { passed: 1, total: 1 },
        opinions: { passed: 2, total: 2 },
        rules: { passed: 3, total: 3 },
      },
      slug: "full-epic",
      verdict: "approved",
      violations: [],
      workspace,
    });

    await writeImplementationSummary({
      files_changed: [{ action: "modified", path: "src/index.ts" }],
      slug: "full-epic",
      task_id: "task-01",
      workspace,
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

// 8. write-review meta.json is readable after writeReview (content verification)

describe("writeReview meta.json content structure", () => {
  it("meta.json contains verdict_original alongside mapped verdict", async () => {
    const workspace = makeTmpDir();

    const result = await writeReview({
      files: [],
      honored: [],
      score: {
        conventions: { passed: 1, total: 1 },
        opinions: { passed: 1, total: 1 },
        rules: { passed: 1, total: 1 },
      },
      slug: "verify-meta",
      verdict: "approved_with_concerns",
      violations: [],
      workspace,
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
      files: ["src/api.ts"],
      honored: [],
      score: {
        conventions: { passed: 1, total: 1 },
        opinions: { passed: 1, total: 1 },
        rules: { passed: 0, total: 1 },
      },
      slug: "violation-meta",
      verdict: "changes_required",
      violations: [
        {
          description: "Input not validated",
          file_path: "src/api.ts",
          fix: "Add zod schema at handler entry",
          principle_id: "validate-at-boundaries",
          severity: "rule",
        },
      ],
      workspace,
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
