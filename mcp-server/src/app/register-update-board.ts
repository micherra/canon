import { updateBoard } from "@features/orchestration/tools/update-board.ts";
import { z } from "zod";
import { gatedWrapHandler, server } from "./server-state.ts";

export function registerUpdateBoardTool(): void {
  server.registerTool(
    "update_board",
    {
      description: "Perform board state mutations (enter, skip, block, complete, etc).",
      inputSchema: {
        action: z.enum([
          "enter_state",
          "skip_state",
          "block",
          "unblock",
          "complete_flow",
          "set_wave_progress",
          "set_metadata",
        ]),
        artifacts: z.array(z.string()).optional(),
        blocked_reason: z.string().optional(),
        metadata: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Key-value metadata to merge into board (used with set_metadata)"),
        next_state_id: z
          .string()
          .optional()
          .describe("Next state to advance to (used with skip_state)"),
        result: z.string().optional(),
        state_id: z
          .string()
          .optional()
          .describe("Required for enter_state, skip_state, block, unblock, set_wave_progress"),
        wave_data: z
          .object({ tasks: z.array(z.string()), wave: z.number(), wave_total: z.number() })
          .optional(),
        workspace: z.string(),
      },
    },
    gatedWrapHandler(async (input) => updateBoard(input)),
  );
}
