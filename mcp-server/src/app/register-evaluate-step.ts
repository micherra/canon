import { evaluateStep } from "@features/orchestration/tools/evaluate-step.ts";
import { z } from "zod";
import { gatedWrapHandler, server } from "./server-state.ts";

export function registerEvaluateStepTool(): void {
  server.registerTool(
    "evaluate_step",
    {
      description:
        "Extract structural signals from a git diff for step-transition evaluation. Returns pattern findings (lazy/hacky code markers), file-scope overlap, and diff statistics. No LLM calls — pure structural analysis.",
      inputSchema: {
        base_commit: z.string().describe("Git ref to diff against (e.g., base commit SHA)"),
        declared_files: z.array(z.string()).describe("Files the task plan declared as in-scope"),
        slug: z.string().describe("Flow slug identifier"),
        workspace: z.string().describe("Workspace path for this flow execution"),
        worktree_path: z.string().describe("Path to the git worktree to analyze"),
      },
    },
    gatedWrapHandler(async (input) => evaluateStep(input)),
  );
}
