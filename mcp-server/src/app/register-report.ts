import { recordAgentMetrics } from "@features/diagnostics/tools/record-agent-metrics.ts";
import { captureTranscript } from "@features/orchestration/tools/capture-transcript.ts";
import { getTranscript } from "@features/orchestration/tools/get-transcript.ts";
import { z } from "zod";
import { gatedWrapHandler, resolveScope, server } from "./server-state.ts";

function registerCaptureTranscriptTool(): void {
  server.registerTool(
    "capture_transcript",
    {
      description:
        "Capture a Claude Code agent transcript and write it to the workspace transcripts directory in Canon format. Best-effort: returns a warning (never an error) when the source transcript cannot be found.",
      inputSchema: {
        agent_id: z
          .string()
          .describe(
            "Agent ID from the Agent tool result (e.g. 'a10bf0a3a2543f7b5'). Used to locate the source JSONL file.",
          ),
        agent_type: z
          .string()
          .describe("Agent type label (e.g. 'engineer'). Used in the output filename."),
        step_id: z.string().describe("Workflow step ID. Used in the output filename."),
        workspace: z.string().describe("Workspace path for this flow execution."),
      },
    },
    gatedWrapHandler(async (input, extra) =>
      captureTranscript({ ...input, projectDir: resolveScope(extra) }),
    ),
  );
}

export function registerReportTools(): void {
  server.registerTool(
    "record_agent_metrics",
    {
      description:
        "Record agent performance metrics (tool_calls, orientation_calls, turns) to the execution store. Merges with existing metrics without overwriting orchestrator-tracked fields.",
      inputSchema: {
        orientation_calls: z
          .number()
          .optional()
          .describe("Read/Glob/Grep calls made for orientation before writing"),
        state_id: z.string().describe("Current state ID the agent is working in"),
        tool_calls: z.number().optional().describe("Total tool invocations the agent made"),
        turns: z
          .number()
          .optional()
          .describe("Number of assistant turns in the agent conversation"),
        workspace: z.string().describe("Workspace path"),
      },
    },
    gatedWrapHandler(async (input) => recordAgentMetrics(input)),
  );

  server.registerTool(
    "get_transcript",
    {
      description: "Retrieve a specialist agent's conversation transcript for a state execution.",
      inputSchema: {
        mode: z
          .enum(["full", "summary"])
          .optional()
          .describe(
            "full returns all entries, summary returns only assistant messages (default: full)",
          ),
        state_id: z.string().describe("State ID to retrieve transcript for"),
        workspace: z.string(),
      },
    },
    gatedWrapHandler(async (input) => getTranscript(input)),
  );

  registerCaptureTranscriptTool();
}
