import { resolveAgentSkills } from "@features/orchestration/tools/resolve-agent-skills.ts";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { wrapHandler } from "@shared/lib/wrap-handler.ts";
import { z } from "zod";
import { pluginDir, resolveScope } from "./server-state.ts";

/**
 * Agent-teams tool registrations.
 *
 * Moved out of register-orchestration.ts to keep that file under biome's
 * noExcessiveLinesPerFile ceiling.
 */
export function registerAgentTeamsTools(server: McpServer): void {
  server.registerTool(
    "resolve_agent_skills",
    {
      description:
        "Resolve an agent's preload fields into injectable content. Reads `agents/<name>.md` and loads each bare-name entry from three dedicated frontmatter fields: `rules:` → `rules/<name>.md`, `references:` → `references/<name>.md`, `primers:` → `primers/<name>.md`. Returns a structured list plus a `preload_prompt` string ready to inject at the top of a spawn prompt. Canon's custom preloader — substitutes for Claude Code's native `skills:` mechanism, which expects per-skill `SKILL.md` directories. Missing files are skipped silently (returned in `unresolved` as `<kind>:<name>`). The native `skills:` field is untouched and remains available for real Claude Code native skills.",
      inputSchema: {
        agent_name: z
          .string()
          .describe("Agent name (with or without `canon:` prefix). Matches `agents/<name>.md`."),
        file_paths: z
          .array(z.string())
          .optional()
          .describe(
            "File paths to query for historical pitfalls. When provided, appends a Known Pitfalls section to preload_prompt.",
          ),
        workspace: z
          .string()
          .optional()
          .describe(
            "Workspace path for audit logging. When provided with file_paths, logs a pitfall_injected event.",
          ),
      },
    },
    wrapHandler(async (input, extra) =>
      resolveAgentSkills({ agent_name: input.agent_name }, pluginDir, resolveScope(extra), {
        filePaths: input.file_paths,
        workspace: input.workspace,
      }),
    ),
  );
}
