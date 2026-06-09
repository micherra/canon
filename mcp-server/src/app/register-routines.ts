import os from "node:os";
import { getRoutine } from "@features/routines/tools/get-routine.ts";
import { listRoutines } from "@features/routines/tools/list-routines.ts";
import { syncRoutines } from "@features/routines/tools/sync-routines.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gatedWrapHandler, pluginDir, resolveScope } from "./server-state.ts";

/**
 * Register the routine query tools on the given McpServer.
 *
 * Thin registration only — all logic lives in features/routines/services/ and
 * features/routines/tools/. Mirrors registerPrincipleQueryTools in register-principles.ts.
 */
export function registerRoutineTools(server: McpServer): void {
  const env = { homeDir: os.homedir() };

  server.registerTool(
    "list_routines",
    {
      description:
        "Browse all Canon routines. Returns each routine's name, title, status, resolved binding target, drift state, and last run time.",
      inputSchema: {
        filter_status: z
          .enum(["enabled", "disabled", "draft"])
          .optional()
          .describe("Filter routines by status"),
      },
    },
    gatedWrapHandler(async (input, extra) =>
      listRoutines(input, resolveScope(extra), pluginDir, env),
    ),
  );

  server.registerTool(
    "get_routine",
    {
      description:
        "Get full details for a single Canon routine by name, including frontmatter, body, resolved binding, drift state, and run history.",
      inputSchema: {
        name: z.string().describe("The routine name (kebab-case identifier)"),
      },
    },
    gatedWrapHandler(async (input, extra) =>
      getRoutine(input, resolveScope(extra), pluginDir, env),
    ),
  );

  server.registerTool(
    "sync_routines",
    {
      description:
        "Sync Canon routines to their binding targets. Desktop routines → writes SKILL.md to ~/.claude/scheduled-tasks/<name>/SKILL.md. Cloud routines → returns a /schedule recipe string. When name is provided, syncs only that routine; when absent, syncs all enabled routines. This is the ONLY runtime write path for SKILL.md files and cloud recipes.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Routine name to sync (kebab-case). Omit to sync all enabled routines."),
      },
    },
    gatedWrapHandler(async (input, extra) =>
      syncRoutines(input, resolveScope(extra), pluginDir, env),
    ),
  );
}
