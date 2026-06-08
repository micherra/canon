/**
 * Loop framework MCP tool registration.
 *
 * Registers list_loops and get_loop_definition as text-only MCP tools.
 * Modelled on register-principles.ts — uses gatedWrapHandler + resolveScope + pluginDir.
 *
 * These are pure query tools (command-query-separation) — no side effects.
 * Text-only (no UI) — uses server.registerTool, not registerToolWithUi.
 */

import { getLoopDefinitionHandler } from "@features/loops/tools/get-loop-definition.ts";
import { listLoopsHandler } from "@features/loops/tools/list-loops.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { join } from "node:path";
import { z } from "zod";
import { gatedWrapHandler, pluginDir } from "./server-state.ts";

export function registerLoopTools(server: McpServer): void {
  // list_loops — returns all active loop definitions from the loops/ registry.
  server.registerTool(
    "list_loops",
    {
      description:
        "List all active loop definitions from the loops/ registry. " +
        "Optionally filter by lifecycle_hook and annotate firing_posture for a tier. " +
        "Always returns an invalid[] channel so calformed definitions are surfaced.",
      inputSchema: {
        lifecycle_hook: z
          .enum(["post-ship", "on-long-dispatch", "session-start"])
          .optional()
          .describe("Filter to loops with this lifecycle hook"),
        tier: z
          .enum(["autonomous", "light-touch", "supervised"])
          .optional()
          .describe("Annotate each loop's firing_posture for this tier"),
      },
    },
    gatedWrapHandler(async (input) => {
      return listLoopsHandler(join(pluginDir, "loops"), {
        lifecycle_hook: input.lifecycle_hook,
        tier: input.tier,
      });
    }),
  );

  // get_loop_definition — returns one parsed definition + body by id.
  server.registerTool(
    "get_loop_definition",
    {
      description:
        "Return the parsed loop definition and action-prompt body for a single loop id. " +
        "Used by /canon:loop-tick to load the definition before executing a tick. " +
        "Returns INVALID_INPUT when the id is not found.",
      inputSchema: {
        id: z.string().describe("The loop id (must match loops/<id>.md filename stem)"),
      },
    },
    gatedWrapHandler(async (input) => {
      return getLoopDefinitionHandler(join(pluginDir, "loops"), { id: input.id });
    }),
  );
}
