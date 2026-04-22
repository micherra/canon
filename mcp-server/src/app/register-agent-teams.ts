import { resolveAgentSkills } from "@features/orchestration/tools/resolve-agent-skills.ts";
import { wrapHandler } from "@shared/lib/wrap-handler.ts";
import { z } from "zod";
import { pluginDir, server } from "./server-state.ts";

/**
 * Agent-teams mode tool registrations.
 *
 * All tools here are gated behind CANON_AGENT_TEAMS_MODE=on so the legacy
 * state-machine path stays byte-identical when the flag is off.
 *
 * Moved out of register-orchestration.ts to keep that file under biome's
 * noExcessiveLinesPerFile ceiling.
 */
export function registerAgentTeamsTools(): void {
  if (process.env.CANON_AGENT_TEAMS_MODE !== "on") return;

  server.registerTool(
    "resolve_agent_skills",
    {
      description:
        "Resolve an agent's `skills:` frontmatter into preloaded content. Reads `agents/<name>.md`, parses skills (`rule:<x>`, `ref:<x>`, `primer:<x>`, or bare names), loads each matching file from `rules/`, `references/`, `primers/`, and returns both a structured list and a concatenated `preload_prompt` string ready to inject into a spawn prompt. Canon's custom preloader — substitutes for Claude Code's native `skills:` mechanism, which requires per-skill `SKILL.md` directories that Canon does not use. Missing skills are skipped silently (returned in `unresolved`).",
      inputSchema: {
        agent_name: z
          .string()
          .describe("Agent name (with or without `canon:` prefix). Matches `agents/<name>.md`."),
      },
    },
    wrapHandler(async (input) => resolveAgentSkills(input, pluginDir)),
  );
}
