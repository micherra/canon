import { resolveAgentSkills } from "@features/orchestration/tools/resolve-agent-skills.ts";
import { wrapHandler } from "@shared/lib/wrap-handler.ts";
import { z } from "zod";
import { pluginDir, server } from "./server-state.ts";

/**
 * Agent-teams tool registrations.
 *
 * Moved out of register-orchestration.ts to keep that file under biome's
 * noExcessiveLinesPerFile ceiling.
 */
export function registerAgentTeamsTools(): void {
  server.registerTool(
    "resolve_agent_skills",
    {
      description:
        "Resolve an agent's preload fields into injectable content. Reads `agents/<name>.md` and loads each bare-name entry from three dedicated frontmatter fields: `rules:` → `rules/<name>.md`, `references:` → `references/<name>.md`, `primers:` → `primers/<name>.md`. Returns a structured list plus a `preload_prompt` string ready to inject at the top of a spawn prompt. Canon's custom preloader — substitutes for Claude Code's native `skills:` mechanism, which expects per-skill `SKILL.md` directories. Missing files are skipped silently (returned in `unresolved` as `<kind>:<name>`). The native `skills:` field is untouched and remains available for real Claude Code native skills.",
      inputSchema: {
        agent_name: z
          .string()
          .describe("Agent name (with or without `canon:` prefix). Matches `agents/<name>.md`."),
      },
    },
    wrapHandler(async (input) => resolveAgentSkills(input, pluginDir)),
  );
}
