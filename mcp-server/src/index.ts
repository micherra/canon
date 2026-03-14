#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getPrinciples } from "./tools/get-principles.js";
import { listPrinciples } from "./tools/list-principles.js";
import { reviewCode } from "./tools/review-code.js";
import { getCompliance } from "./tools/get-compliance.js";
import { report } from "./tools/report.js";

const projectDir = process.env.CANON_PROJECT_DIR || process.cwd();
const pluginDir = process.env.CANON_PLUGIN_DIR || new URL("../..", import.meta.url).pathname;

const server = new McpServer({
  name: "canon",
  version: "0.1.0",
});

// Tool: get_principles
server.tool(
  "get_principles",
  "Returns Canon principles relevant to the current coding context. Call before generating code.",
  {
    file_path: z.string().optional().describe("Path of the file being worked on"),
    layers: z.array(z.string()).optional().describe("Architectural layers (e.g., api, domain, data)"),
    task_description: z.string().optional().describe("Brief description of the task"),
  },
  async (input) => {
    const result = await getPrinciples(input, projectDir, pluginDir);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool: list_principles
server.tool(
  "list_principles",
  "Browse the full Canon principle index. Returns metadata only (no full body) for efficient browsing.",
  {
    filter_severity: z
      .enum(["rule", "strong-opinion", "convention"])
      .optional()
      .describe("Filter by severity level"),
    filter_tags: z.array(z.string()).optional().describe("Filter by tags"),
    filter_layers: z.array(z.string()).optional().describe("Filter by architectural layers"),
  },
  async (input) => {
    const result = await listPrinciples(input, projectDir, pluginDir);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool: review_code
server.tool(
  "review_code",
  "Returns Canon principles relevant to a file for review. The calling agent evaluates compliance — this tool provides the matched principles and code.",
  {
    code: z.string().describe("The code to review"),
    file_path: z.string().describe("Path of the file being reviewed"),
    context: z.string().optional().describe("Brief description of what the code does"),
  },
  async (input) => {
    const result = await reviewCode(input, projectDir, pluginDir);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool: get_compliance
server.tool(
  "get_compliance",
  "Returns compliance stats for a specific Canon principle. Shows violation counts, compliance rate, and trend.",
  {
    principle_id: z.string().describe("ID of the principle to check compliance for"),
  },
  async (input) => {
    const result = await getCompliance(input, projectDir, pluginDir);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Tool: report (unified — decisions, patterns, and reviews)
server.tool(
  "report",
  "Log a Canon observation: an intentional deviation (decision), an observed codebase pattern, or a code review result. All feed into drift tracking and the learning loop.",
  {
    type: z.enum(["decision", "pattern", "review"]).describe("Type of report"),
    decision: z
      .object({
        principle_id: z.string().describe("ID of the principle being deviated from"),
        file_path: z.string().describe("Path of the file where the deviation occurs"),
        justification: z.string().describe("Why the deviation is intentional and justified"),
        category: z
          .enum(["performance", "legacy-constraint", "scope-mismatch", "intentional-tradeoff", "external-requirement", "other"])
          .optional()
          .describe("Deviation category for clustering"),
      })
      .optional()
      .describe("Required when type=decision"),
    pattern: z
      .object({
        pattern: z.string().describe("Description of the observed pattern"),
        file_paths: z.array(z.string()).min(1).describe("File paths where the pattern was observed"),
        context: z.string().optional().describe("Additional context"),
      })
      .optional()
      .describe("Required when type=pattern"),
    review: z
      .object({
        files: z.array(z.string()).describe("File paths that were reviewed"),
        violations: z
          .array(
            z.object({
              principle_id: z.string(),
              severity: z.string(),
            })
          )
          .describe("Principle violations found"),
        honored: z.array(z.string()).describe("IDs of principles honored"),
        score: z.object({
          rules: z.object({ passed: z.number(), total: z.number() }),
          opinions: z.object({ passed: z.number(), total: z.number() }),
          conventions: z.object({ passed: z.number(), total: z.number() }),
        }),
        verdict: z.enum(["BLOCKING", "WARNING", "CLEAN"]).optional(),
      })
      .optional()
      .describe("Required when type=review"),
  },
  async (input) => {
    const { type } = input;
    let reportInput;
    if (type === "decision") {
      if (!input.decision) throw new Error("decision field required when type=decision");
      reportInput = { type: "decision" as const, data: input.decision };
    } else if (type === "pattern") {
      if (!input.pattern) throw new Error("pattern field required when type=pattern");
      reportInput = { type: "pattern" as const, data: input.pattern };
    } else {
      if (!input.review) throw new Error("review field required when type=review");
      reportInput = { type: "review" as const, data: input.review };
    }
    const result = await report(reportInput, projectDir);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("Canon MCP server error:", error);
  process.exit(1);
});
