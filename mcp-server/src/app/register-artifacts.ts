import { writeDesignBrief } from "@features/orchestration/tools/write-design-brief.ts";
import { writeImplementationSummary } from "@features/orchestration/tools/write-implementation-summary.ts";
import { writePlanIndex } from "@features/orchestration/tools/write-plan-index.ts";
import { writeReview } from "@features/orchestration/tools/write-review.ts";
import { writeTestReport } from "@features/orchestration/tools/write-test-report.ts";
import { z } from "zod";
import { gatedWrapHandler, server } from "./server-state.ts";

function registerPlanTools(): void {
  server.registerTool(
    "write_plan_index",
    {
      description:
        "Write a structured plan index (INDEX.md) for wave execution. Accepts typed task entries and produces normalized markdown for reliable downstream parsing.",
      inputSchema: {
        slug: z.string(),
        tasks: z.array(
          z.object({
            depends_on: z.array(z.string()).optional(),
            files: z.array(z.string()).optional(),
            principles: z.array(z.string()).optional(),
            task_id: z
              .string()
              .describe("Task identifier — alphanumeric, hyphens, underscores only"),
            wave: z.number().min(1).describe("Wave number (1-based)"),
          }),
        ),
        workspace: z.string(),
      },
    },
    gatedWrapHandler(async (input) => writePlanIndex(input)),
  );

  server.registerTool(
    "write_test_report",
    {
      description:
        "Write a structured test report. Accepts typed test results and produces normalized TEST-REPORT.md with a companion .meta.json sidecar for machine reading.",
      inputSchema: {
        failed: z.number().int().min(0),
        issues: z
          .array(
            z.object({
              category: z.string().optional().describe("Error category"),
              error: z.string().describe("Error message"),
              file: z.string().optional().describe("Test file path"),
              test: z.string().describe("Test name or identifier"),
            }),
          )
          .optional(),
        passed: z.number().int().min(0),
        skipped: z.number().int().min(0),
        slug: z.string(),
        summary: z.string().describe("Human-readable summary of test results"),
        workspace: z.string(),
      },
    },
    gatedWrapHandler(async (input) => writeTestReport(input)),
  );
}

function registerReviewArtifactTools(): void {
  server.registerTool(
    "write_review",
    {
      description:
        "Write a structured code review. Accepts typed review data with verdict, violations, and scores. Maps ADR-010 verdict vocabulary to DriftStore vocabulary. Produces REVIEW.md + .meta.json sidecar.",
      inputSchema: {
        files: z.array(z.string()),
        honored: z.array(z.string()),
        score: z.object({
          conventions: z.object({
            passed: z.number().int().min(0),
            total: z.number().int().min(0),
          }),
          opinions: z.object({ passed: z.number().int().min(0), total: z.number().int().min(0) }),
          rules: z.object({ passed: z.number().int().min(0), total: z.number().int().min(0) }),
        }),
        slug: z.string(),
        verdict: z.enum(["approved", "approved_with_concerns", "changes_required", "blocked"]),
        violations: z.array(
          z.object({
            description: z.string().optional(),
            file_path: z.string().optional(),
            fix: z.string().optional(),
            principle_id: z.string(),
            severity: z.string(),
          }),
        ),
        workspace: z.string(),
      },
    },
    gatedWrapHandler(async (input) => writeReview(input)),
  );

  server.registerTool(
    "write_implementation_summary",
    {
      description:
        "Write a structured implementation summary. Accepts typed file changes, decisions applied, deviations, and tests. Produces IMPLEMENTATION-SUMMARY.md + .meta.json sidecar.",
      inputSchema: {
        decisions_applied: z.array(z.string()).optional(),
        deviations: z.array(z.object({ decision_id: z.string(), reason: z.string() })).optional(),
        files_changed: z.array(
          z.object({ action: z.enum(["added", "modified", "deleted"]), path: z.string() }),
        ),
        slug: z.string(),
        task_id: z.string(),
        tests_added: z.array(z.string()).optional(),
        workspace: z.string(),
      },
    },
    gatedWrapHandler(async (input) => writeImplementationSummary(input)),
  );
}

function registerHandoffArtifactTools(): void {
  server.registerTool(
    "write_design_brief",
    {
      description:
        "Write a structured design brief for architect-to-implementor handoff. Produces DESIGN-BRIEF.md + .meta.json sidecar in workspace handoffs/ directory.",
      inputSchema: {
        constraints: z.array(z.string()),
        decisions_referenced: z.array(z.string()).optional(),
        dependencies: z.array(z.string()).optional(),
        file_targets: z.array(
          z.object({
            action: z.enum(["create", "modify", "delete"]),
            description: z.string().optional(),
            path: z.string(),
          }),
        ),
        slug: z.string(),
        task_id: z.string(),
        test_expectations: z.array(
          z.object({ description: z.string(), file: z.string().optional() }),
        ),
        workspace: z.string(),
      },
    },
    gatedWrapHandler(async (input) => writeDesignBrief(input)),
  );
}

export function registerArtifactTools(): void {
  registerPlanTools();
  registerReviewArtifactTools();
  registerHandoffArtifactTools();
}
