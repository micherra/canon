import type { FailureEntry } from "@features/diagnostics/tools/categorize-failures.ts";
import { categorizeFailures } from "@features/diagnostics/tools/categorize-failures.ts";
import { z } from "zod";
import { gatedWrapHandler, server } from "./server-state.ts";

const FailureEntrySchema = z.object({
  error_message: z.string().describe("Error message from the failure"),
  error_type: z
    .string()
    .optional()
    .describe("Error type or class (e.g. TypeError, AssertionError)"),
  file: z.string().describe("Test file path"),
  test_name: z.string().optional().describe("Test name"),
});

export function registerCategorizeTool(): void {
  server.registerTool(
    "categorize_failures",
    {
      description:
        "Group test failures by root cause using pattern matching with confidence scoring. Returns categorized failures and a needs_refinement flag indicating whether LLM review is needed for low-confidence groupings.",
      inputSchema: {
        failures: z
          .array(FailureEntrySchema)
          .min(1)
          .describe("Array of test failure entries to categorize"),
        refined_categories: z
          .array(
            z.object({
              category: z.string().describe("Category label"),
              description: z.string().describe("Category description"),
              files: z.array(z.string()).describe("File paths in this category"),
            }),
          )
          .optional()
          .describe(
            "LLM-provided refined categories. When present, skips pattern matching and applies these groupings directly (confidence 1.0).",
          ),
        workspace: z.string().describe("Workspace directory path"),
      },
    },
    gatedWrapHandler(async (input) =>
      categorizeFailures(
        input as {
          failures: FailureEntry[];
          refined_categories?: Array<{ category: string; description: string; files: string[] }>;
          workspace: string;
        },
      ),
    ),
  );
}
