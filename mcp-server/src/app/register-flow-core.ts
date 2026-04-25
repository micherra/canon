import { loadFlow } from "@features/orchestration/tools/load-flow.ts";
import { simulateFlowTool } from "@features/orchestration/tools/simulate-flow.ts";
import { z } from "zod";
import { gatedWrapHandler, pluginDir, projectDir, server } from "./server-state.ts";

export function registerFlowCoreTools(): void {
  server.registerTool(
    "load_flow",
    {
      description:
        "Load and resolve a Canon flow definition. Returns the resolved flow with fragment resolution, spawn instructions, and a state adjacency graph.",
      inputSchema: {
        flow_name: z.string().describe("Name of the flow file (without .md extension)"),
      },
    },
    gatedWrapHandler(async (input) => loadFlow(input, pluginDir, projectDir)),
  );

  server.registerTool(
    "simulate_flow",
    {
      description:
        "Simulate a Canon flow execution with mocked agent results. Returns execution path, terminal/stuck/dead-end detection, and iteration tracking.",
      inputSchema: {
        flow: z.string().describe("Name of the flow file (without .md extension)"),
        max_steps: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Maximum simulation steps (default 50, max 1000)"),
        scenario: z
          .array(
            z.object({
              state_id: z.string().describe("State ID to provide a result for"),
              status: z.string().describe("Status keyword (e.g. done, blocked, has_failures)"),
            }),
          )
          .max(1000)
          .describe("Sequence of mocked agent results (max 1000 entries)"),
      },
    },
    gatedWrapHandler(async (input) => simulateFlowTool(input, pluginDir, projectDir)),
  );
}
