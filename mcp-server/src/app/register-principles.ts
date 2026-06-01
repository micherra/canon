import { report } from "@features/orchestration/tools/report.ts";
import { presentReview } from "@features/pr-review/tools/present-review.ts";
import { reviewCode } from "@features/pr-review/tools/review-code.ts";
import { showPrImpact } from "@features/pr-review/tools/show-pr-impact.ts";
import { storePrReview } from "@features/pr-review/tools/store-pr-review.ts";
import { getCompliance } from "@features/principles/tools/get-compliance.ts";
import { getPrinciples } from "@features/principles/tools/get-principles.ts";
import { listPrinciples } from "@features/principles/tools/list-principles.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db.ts";
import { reportInputSchema } from "@shared/schema.ts";
import { z } from "zod";
import {
  gatedWrapHandler,
  pluginDir,
  registerToolWithUi,
  resolveScope,
  server,
} from "./server-state.ts";

function registerPrImpactTool(): void {
  registerToolWithUi("show_pr_impact", {
    description:
      "Opens the PR Review view — change analysis, impact assessment, and review violations for a pull request or branch.",
    handler: gatedWrapHandler(async (input, extra) => {
      return showPrImpact(resolveScope(extra), {
        branch: input.branch,
        diff_base: input.diff_base,
        incremental: input.incremental,
        pr_number: input.pr_number,
      });
    }),
    htmlFile: "pr-review.html",
    inputSchema: {
      branch: z.string().optional().describe("Filter to reviews for this branch"),
      diff_base: z.string().optional().describe("Base ref for the diff (default: main)"),
      incremental: z
        .boolean()
        .optional()
        .describe("Only review new commits since last Canon review"),
      pr_number: z.number().optional().describe("Filter to reviews for this PR number"),
    },
    resourceUri: "ui://canon/pr-review",
    title: "PR Review",
  });
}

function registerPrincipleQueryTools(): void {
  server.registerTool(
    "get_principles",
    {
      description:
        "Returns Canon principles relevant to the current coding context. Call before generating code.",
      inputSchema: {
        file_path: z.string().optional().describe("Path of the file being worked on"),
        layers: z
          .array(z.string())
          .optional()
          .describe("Architectural layers (e.g., api, domain, data)"),
        sections: z
          .array(z.string())
          .optional()
          .describe(
            "Filter principle body to include only these sections (e.g., 'anti_rationalization', 'verification')",
          ),
        summary_only: z
          .boolean()
          .optional()
          .describe(
            "Return only the summary paragraph instead of full body — reduces context usage by ~60%",
          ),
        task_description: z.string().optional().describe("Brief description of the task"),
      },
    },
    gatedWrapHandler(async (input, extra) => getPrinciples(input, resolveScope(extra), pluginDir)),
  );

  server.registerTool(
    "list_principles",
    {
      description:
        "Browse the full Canon principle index. Returns metadata only (no full body) for efficient browsing.",
      inputSchema: {
        filter_layers: z.array(z.string()).optional().describe("Filter by architectural layers"),
        filter_severity: z
          .enum(["rule", "strong-opinion", "convention"])
          .optional()
          .describe("Filter by severity level"),
        filter_tags: z.array(z.string()).optional().describe("Filter by tags"),
        include_archived: z
          .boolean()
          .optional()
          .describe("Include archived principles in results (default: false)"),
      },
    },
    gatedWrapHandler(async (input, extra) => listPrinciples(input, resolveScope(extra), pluginDir)),
  );
}

function registerCodeReviewTools(): void {
  server.registerTool(
    "review_code",
    {
      description:
        "Returns Canon principles relevant to a file for review. The calling agent evaluates compliance — this tool provides the matched principles and code.",
      inputSchema: {
        code: z.string().describe("The code to review"),
        context: z.string().optional().describe("Brief description of what the code does"),
        file_path: z.string().describe("Path of the file being reviewed"),
        sections: z
          .array(z.string())
          .optional()
          .describe(
            "Filter principle body to include only these sections (e.g., 'anti_rationalization', 'verification')",
          ),
      },
    },
    gatedWrapHandler(async (input, extra) => reviewCode(input, resolveScope(extra), pluginDir)),
  );

  server.registerTool(
    "get_compliance",
    {
      description:
        "Returns compliance stats for a specific Canon principle. Shows violation counts, compliance rate, trend, and weekly history.",
      inputSchema: {
        principle_id: z.string().describe("ID of the principle to check compliance for"),
      },
    },
    gatedWrapHandler(async (input, extra) => getCompliance(input, resolveScope(extra), pluginDir)),
  );

  // Tool: report (unified — decisions, patterns, and reviews)
  server.registerTool(
    "report",
    {
      description:
        "Log a Canon observation: an intentional deviation (decision), an observed codebase pattern, or a code review result. All feed into drift tracking and the learning loop.",
      inputSchema: reportInputSchema,
    },
    gatedWrapHandler(async (input, extra) => {
      const dir = resolveScope(extra);
      const signals = dir ? getDriftDb(dir).getSignals() : undefined;
      return report(input, dir, signals);
    }),
  );
}

function registerStorePrReviewTool(): void {
  server.registerTool(
    "store_pr_review",
    {
      description:
        "Store a PR review result for drift tracking. Server generates review_id and timestamp.",
      inputSchema: {
        branch: z.string().optional().describe("Branch name reviewed"),
        file_priorities: z
          .array(z.object({ path: z.string(), priority_score: z.number() }))
          .optional()
          .describe("Graph-derived file review priorities"),
        files: z.array(z.string()).describe("File paths that were reviewed"),
        honored: z.array(z.string()).describe("IDs of principles honored"),
        last_reviewed_sha: z.string().optional().describe("Last commit SHA that was reviewed"),
        pr_number: z.number().optional().describe("GitHub PR number"),
        recommendations: z
          .array(
            z.object({
              file_path: z.string().optional().describe("File the recommendation applies to"),
              message: z.string().describe("Concrete explanation with suggested fix"),
              source: z
                .enum(["principle", "holistic"])
                .describe("Whether derived from a principle violation or holistic observation"),
              title: z.string().describe("Short label for the recommendation (≤ 60 chars)"),
            }),
          )
          .optional()
          .describe(
            "Top-5 prioritized recommendations mixing principle violations and holistic suggestions",
          ),
        score: z
          .object({
            conventions: z.object({
              passed: z.number().int().min(0),
              total: z.number().int().min(0),
            }),
            opinions: z.object({ passed: z.number().int().min(0), total: z.number().int().min(0) }),
            rules: z.object({ passed: z.number().int().min(0), total: z.number().int().min(0) }),
          })
          .describe("Compliance score breakdown"),
        verdict: z.enum(["BLOCKING", "WARNING", "CLEAN"]).describe("Overall review verdict"),
        violations: z
          .array(
            z.object({
              file_path: z.string().optional().describe("Specific file where violation occurred"),
              impact_score: z.number().optional().describe("Graph-derived impact score"),
              message: z.string().optional().describe("Human-readable violation reason"),
              principle_id: z.string(),
              severity: z.string(),
            }),
          )
          .describe("Principle violations found"),
      },
    },
    gatedWrapHandler(async (input, extra) => storePrReview(input, resolveScope(extra))),
  );
}

function registerPresentReviewTool(): void {
  server.registerTool(
    "present_review",
    {
      description:
        "Render a stored Canon review as an interactive HTML dashboard, serve it via the Canon HTTP server, and open it in the default browser. Blocks until the user approves or requests changes in the browser. Requires a review already stored via store_pr_review.",
      inputSchema: {
        branch: z.string().optional().describe("Filter to reviews for this branch"),
        pr_number: z.number().optional().describe("Filter to reviews for this PR number"),
        slug: z.string().describe("Unique identifier for this artifact instance"),
        workspace: z.string().describe("Workspace directory path"),
      },
    },
    gatedWrapHandler(async (input, extra) =>
      presentReview(
        {
          branch: input.branch,
          pr_number: input.pr_number,
          slug: input.slug,
          workspace: input.workspace,
        },
        resolveScope(extra),
      ),
    ),
  );
}

export function registerPrincipleTools(): void {
  registerPrImpactTool();
  registerPrincipleQueryTools();
  registerCodeReviewTools();
  registerStorePrReviewTool();
  registerPresentReviewTool();
}
