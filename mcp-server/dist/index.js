#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getPrinciples } from "./tools/get-principles.js";
import { listPrinciples } from "./tools/list-principles.js";
import { reviewCode } from "./tools/review-code.js";
import { reportDecision } from "./tools/report-decision.js";
import { getCompliance } from "./tools/get-compliance.js";
import { reportPattern } from "./tools/report-pattern.js";
import { reportReview } from "./tools/report-review.js";
const projectDir = process.env.CANON_PROJECT_DIR || process.cwd();
const pluginDir = process.env.CANON_PLUGIN_DIR || new URL("../..", import.meta.url).pathname;
const server = new McpServer({
    name: "canon",
    version: "0.1.0",
});
// Tool: get_principles
server.tool("get_principles", "Returns Canon principles relevant to the current coding context. Call before generating code.", {
    file_path: z.string().optional().describe("Path of the file being worked on"),
    layers: z.array(z.string()).optional().describe("Architectural layers (e.g., api, domain, data)"),
    task_description: z.string().optional().describe("Brief description of the task"),
}, async (input) => {
    const result = await getPrinciples(input, projectDir, pluginDir);
    return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
});
// Tool: list_principles
server.tool("list_principles", "Browse the full Canon principle index. Returns metadata only (no full body) for efficient browsing.", {
    filter_severity: z
        .enum(["rule", "strong-opinion", "convention"])
        .optional()
        .describe("Filter by severity level"),
    filter_tags: z.array(z.string()).optional().describe("Filter by tags"),
    filter_layers: z.array(z.string()).optional().describe("Filter by architectural layers"),
}, async (input) => {
    const result = await listPrinciples(input, projectDir, pluginDir);
    return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
});
// Tool: review_code
server.tool("review_code", "Returns Canon principles relevant to a file for review. The calling agent evaluates compliance — this tool provides the matched principles and code.", {
    code: z.string().describe("The code to review"),
    file_path: z.string().describe("Path of the file being reviewed"),
    context: z.string().optional().describe("Brief description of what the code does"),
}, async (input) => {
    const result = await reviewCode(input, projectDir, pluginDir);
    return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
});
// Tool: report_decision
server.tool("report_decision", "Logs an intentional deviation from a Canon principle. Creates a decision trail for drift analytics.", {
    principle_id: z.string().describe("ID of the principle being deviated from"),
    file_path: z.string().describe("Path of the file where the deviation occurs"),
    justification: z.string().describe("Why the deviation is intentional and justified"),
    category: z
        .enum(["performance", "legacy-constraint", "scope-mismatch", "intentional-tradeoff", "external-requirement", "other"])
        .optional()
        .describe("Deviation category for clustering in learning reports"),
}, async (input) => {
    const result = await reportDecision(input, projectDir);
    return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
});
// Tool: get_compliance
server.tool("get_compliance", "Returns compliance stats for a specific Canon principle. Shows violation counts, compliance rate, and trend.", {
    principle_id: z.string().describe("ID of the principle to check compliance for"),
}, async (input) => {
    const result = await getCompliance(input, projectDir, pluginDir);
    return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
});
// Tool: report_pattern
server.tool("report_pattern", "Logs an observed codebase pattern for the learner to validate. Patterns are stored and analyzed during /canon:learn runs.", {
    pattern: z.string().describe("Description of the observed pattern"),
    file_paths: z.array(z.string()).min(1).describe("File paths where the pattern was observed (at least one required)"),
    context: z.string().optional().describe("Additional context about the pattern"),
}, async (input) => {
    const result = await reportPattern(input, projectDir);
    return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
});
// Tool: report_review
server.tool("report_review", "Logs a code review result for drift tracking. Call after completing a Canon review to feed the learning loop.", {
    files: z.array(z.string()).describe("File paths that were reviewed"),
    violations: z
        .array(z.object({
        principle_id: z.string().describe("ID of the violated principle"),
        severity: z.string().describe("Severity: rule, strong-opinion, or convention"),
    }))
        .describe("Principle violations found during review"),
    honored: z.array(z.string()).describe("IDs of principles that were honored"),
    score: z
        .object({
        rules: z.object({ passed: z.number(), total: z.number() }),
        opinions: z.object({ passed: z.number(), total: z.number() }),
        conventions: z.object({ passed: z.number(), total: z.number() }),
    })
        .describe("Pass/total counts by severity tier"),
    verdict: z
        .enum(["BLOCKING", "WARNING", "CLEAN"])
        .optional()
        .describe("Review verdict. Auto-derived from violations if not provided."),
}, async (input) => {
    const result = await reportReview(input, projectDir);
    return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
});
// Start the server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((error) => {
    console.error("Canon MCP server error:", error);
    process.exit(1);
});
