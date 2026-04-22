/**
 * ADR-010 Effects Tests
 *
 * Schema, required_artifacts, multi-artifact, and meta.json tests for the structured
 * agent output contract system introduced in ADR-010.
 *
 * Split from adr010-integration.test.ts. Covers:
 * 5. RequiredArtifactSchema — Zod schema validation
 * 6. writeReview → reportResult with required_artifacts (end-to-end)
 * 7. Multiple required artifact types in a single state
 * 8. writeReview meta.json content structure
 */

import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RequiredArtifact, ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { RequiredArtifactSchema } from "@domains/flows/flow-definition-schemas.ts";
import { clearStoreCache, getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, describe, expect, it } from "vitest";
import { reportResult, validateRequiredArtifacts } from "../tools/report-result.ts";
import { writeImplementationSummary } from "../tools/write-implementation-summary.ts";
import { writeReview } from "../tools/write-review.ts";
import { writeTestReport } from "../tools/write-test-report.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "adr010-effects-"));
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
    description: "ADR-010 effects test flow",
    entry: "implement",
    name: "adr010-effects-flow",
    spawn_instructions: { implement: "Implement." },
    states: {
      implement: stateDef,
      terminal: { type: "terminal" as const },
    },
  };
}

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
