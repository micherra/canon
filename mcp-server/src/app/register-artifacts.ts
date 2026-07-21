import { reconcilePredictions } from "@features/diagnostics/services/prediction-tracker.ts";
import { computeViolationConfidence } from "@features/orchestration/services/review-confidence-adapter.ts";
import { writeContextSync } from "@features/orchestration/tools/write-context-sync.ts";
import { writeDesign } from "@features/orchestration/tools/write-design.ts";
import { writeImplementationSummary } from "@features/orchestration/tools/write-implementation-summary.ts";
import { writePlanIndex } from "@features/orchestration/tools/write-plan-index.ts";
import {
  type ConfidenceAdapter,
  type WriteReviewInput,
  writeReview,
} from "@features/orchestration/tools/write-review.ts";
import { writeSecurityAssessment } from "@features/orchestration/tools/write-security-assessment.ts";
import { writeTestReport } from "@features/orchestration/tools/write-test-report.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { ConfidenceAnnotationSchema } from "@shared/lib/confidence.ts";
import { z } from "zod";
import { gatedWrapHandler, resolveScope } from "./server-state.ts";

/** Decision record schema for write_implementation_summary */
const DecisionRecordSchema = z.object({
  alternatives_considered: z.array(z.string()).optional(),
  choice: z.string().describe("What was decided"),
  informed_by: z
    .array(
      z.object({
        ref: z.string().describe("Identifier — principle ID, pitfall text, observation ID, etc."),
        type: z.enum(["area_memory", "pitfall", "principle", "task_plan", "codebase_pattern"]),
      }),
    )
    .optional()
    .describe("Context inputs that influenced this decision"),
  rationale: z.string().describe("Why this approach was chosen"),
});

function registerPlanTools(server: McpServer): void {
  server.registerTool(
    "write_plan_index",
    {
      description:
        "Write a structured plan index (INDEX.md) for task execution. Accepts typed task entries and produces normalized markdown that parseTaskIds can reliably parse.",
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
        manual_verification: z
          .array(
            z.object({
              criterion: z.string().describe("Acceptance criterion requiring manual verification"),
              status: z.string().describe("Verification status"),
              verification_method: z.string().describe("How to verify manually"),
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

/** `write_review` inputSchema — extracted so registerWriteReviewTool stays under the line-count limit. */
const WRITE_REVIEW_INPUT_SCHEMA = {
  body: z
    .string()
    .optional()
    .describe(
      "Full review prose body (stages beyond Principle Compliance, per " +
        "templates/review.md) rendered verbatim after the Score section and " +
        "persisted to the sidecar. Reviewers: author your six-stage body here — " +
        "never Bash-append to REVIEW.md.",
    ),
  files: z.array(z.string()),
  honored: z.array(z.string()),
  score: z.object({
    conventions: z.object({ passed: z.number().int().min(0), total: z.number().int().min(0) }),
    opinions: z.object({ passed: z.number().int().min(0), total: z.number().int().min(0) }),
    rules: z.object({ passed: z.number().int().min(0), total: z.number().int().min(0) }),
  }),
  slug: z.string(),
  step_id: z
    .string()
    .optional()
    .describe(
      "Step identifier for multi-reviewer flows. When provided, the tool writes ONLY a " +
        "step-scoped pair (REVIEW-{step_id}.md + REVIEW-{step_id}.meta.json) — it does " +
        "NOT touch the canonical REVIEW.md. Jurors and partition reviewers MUST pass it " +
        "(e.g. the lens name or 'r{N}'); solo reviewers and the orchestrator's " +
        "consolidation call MUST omit it (the no-step_id call is what produces the " +
        "canonical REVIEW.md consumers read).",
    ),
  verdict: z.enum(["approved", "approved_with_concerns", "changes_required", "blocked", "pending"]),
  violations: z.array(
    z.object({
      confidence: ConfidenceAnnotationSchema.optional(),
      description: z.string().optional(),
      file_path: z.string().optional(),
      fix: z.string().optional(),
      principle_id: z.string(),
      severity: z.string(),
    }),
  ),
  workspace: z.string(),
};

async function handleWriteReviewCall(
  input: WriteReviewInput,
  extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
) {
  const dir = resolveScope(extra);
  const driftDb = dir ? getDriftDb(dir) : undefined;
  const signals = driftDb?.getSignals();
  const adapter: ConfidenceAdapter | undefined = signals
    ? { computeViolationConfidence: (v) => computeViolationConfidence(v, signals) }
    : undefined;
  const areaMemoryWriter = (() => {
    try {
      return driftDb?.getAreaMemory();
    } catch {
      return undefined;
    }
  })();
  const result = await writeReview(input, signals, adapter, areaMemoryWriter);
  // Reconcile predictions after review is persisted (non-blocking; app layer owns this)
  if (result.ok && signals) {
    reconcilePredictions({ reviewedFiles: input.files, violations: input.violations }, signals);
  }
  return result;
}

function registerWriteReviewTool(server: McpServer): void {
  server.registerTool(
    "write_review",
    {
      description:
        "Write a structured code review. Accepts typed review data with verdict, violations, and scores. Maps ADR-010 verdict vocabulary to DriftStore vocabulary. Produces REVIEW.md + .meta.json sidecar. When step_id is provided, writes ONLY a step-scoped pair (REVIEW-{step_id}.md + REVIEW-{step_id}.meta.json) — the canonical pair is written exclusively by a call without step_id (ADR-0064).",
      inputSchema: WRITE_REVIEW_INPUT_SCHEMA,
    },
    gatedWrapHandler(handleWriteReviewCall),
  );
}

function registerWriteImplementationSummaryTool(server: McpServer): void {
  server.registerTool(
    "write_implementation_summary",
    {
      description:
        "Write a structured implementation summary. Accepts typed file changes, decisions applied, deviations, and tests. Produces {task_id}-SUMMARY.md + .meta.json sidecar.",
      inputSchema: {
        decisions: z
          .array(DecisionRecordSchema)
          .optional()
          .describe(
            "Structured decision records — what was chosen, why, and what influenced the choice",
          ),
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
    gatedWrapHandler(async (input, extra) => {
      const dir = resolveScope(extra);
      const areaMemoryWriter = (() => {
        try {
          return dir ? getDriftDb(dir).getAreaMemory() : undefined;
        } catch {
          return undefined;
        }
      })();
      return writeImplementationSummary(input, areaMemoryWriter);
    }),
  );
}

/**
 * Registers the three write-receipt-gate dedicated write tools (ADR-0043):
 * write_design, write_context_sync, write_security_assessment. Each is a thin
 * persist-and-receipt wrapper — the agent still authors the markdown; these
 * tools own the canonical path and emit the artifact's `write_receipt` event.
 */
function registerWriteReceiptTools(server: McpServer): void {
  server.registerTool(
    "write_design",
    {
      description:
        "Persist the architect's DESIGN.md to its canonical path and emit a write receipt. The architect authors the markdown content; this tool owns the path and the receipt.",
      inputSchema: {
        content: z.string().describe("Full DESIGN.md markdown content, already authored"),
        slug: z.string(),
        workspace: z.string(),
      },
    },
    gatedWrapHandler(async (input) => writeDesign(input)),
  );

  server.registerTool(
    "write_context_sync",
    {
      description:
        "Persist the scribe's CONTEXT-SYNC.md to its canonical path and emit a write receipt. Emits on both UPDATED and NO_UPDATES status — a NO_UPDATES sync still produces the file.",
      inputSchema: {
        content: z.string().describe("Full CONTEXT-SYNC.md markdown content, already authored"),
        slug: z.string(),
        status: z.enum(["UPDATED", "NO_UPDATES"]),
        workspace: z.string(),
      },
    },
    gatedWrapHandler(async (input) => writeContextSync(input)),
  );

  server.registerTool(
    "write_security_assessment",
    {
      description:
        "Persist the security agent's SECURITY.md to its canonical path and emit a write receipt. The security agent authors the markdown content; this tool owns the path and the receipt.",
      inputSchema: {
        content: z.string().describe("Full SECURITY.md markdown content, already authored"),
        slug: z.string(),
        workspace: z.string(),
      },
    },
    gatedWrapHandler(async (input) => writeSecurityAssessment(input)),
  );
}

export function registerArtifactTools(server: McpServer): void {
  registerPlanTools(server);
  registerWriteReviewTool(server);
  registerWriteImplementationSummaryTool(server);
  registerWriteReceiptTools(server);
}
