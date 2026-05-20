/** Progressive disclosure helpers for the resolve_agent_skills tool. */

import { join } from "node:path";
import { CANON_DIR } from "@shared/constants.ts";
import { applyDisclosure } from "@shared/lib/progressive-disclosure.ts";
import type { ResolveAgentSkillsResult } from "./resolve-agent-skills.ts";

/** Produce a compact summary of ResolveAgentSkillsResult for progressive disclosure. */
export function summarizeAgentSkills(data: ResolveAgentSkillsResult): string {
  const kindCounts: Record<string, number> = { primer: 0, ref: 0, rule: 0, template: 0 };
  for (const skill of data.skills) {
    kindCounts[skill.kind] = (kindCounts[skill.kind] ?? 0) + 1;
  }
  const countLine = [
    `Rules: ${kindCounts.rule}`,
    `References: ${kindCounts.ref}`,
    `Primers: ${kindCounts.primer}`,
    `Templates: ${kindCounts.template}`,
  ].join(", ");

  const skillLines = data.skills.map((s) => `- ${s.kind}: ${s.id}`);
  const unresolvedLines =
    data.unresolved.length > 0 ? ["", "Unresolved:", ...data.unresolved.map((u) => `- ${u}`)] : [];

  return [`Agent: ${data.agent_name}`, countLine, ...skillLines, ...unresolvedLines]
    .filter((line) => line !== undefined)
    .join("\n");
}

/**
 * Apply progressive disclosure to a ResolveAgentSkillsResult.
 *
 * If the serialized payload is under threshold, returns the result unchanged.
 * If over threshold, writes full JSON to .canon/artifacts/ and returns a
 * slimmed result with a file pointer and summary-only preload_prompt.
 */
export async function applyAgentSkillsDisclosure(
  result: ResolveAgentSkillsResult,
  projectDir: string,
): Promise<ResolveAgentSkillsResult> {
  const disclosure = await applyDisclosure(result, {
    filePrefix: "agent-skills",
    outputDir: join(projectDir, CANON_DIR, "artifacts"),
    summarize: summarizeAgentSkills,
  });

  if (!disclosure.truncated) return result;

  const slimSkills = result.skills.map((s) => ({ ...s, content: "" }));
  const slimPreload = [
    disclosure.summary,
    `\n\nFull preload content at: ${disclosure.full_data_path}\nInstruct the agent to Read this file path for the complete rules, references, primers, and templates.`,
  ].join("");

  return {
    agent_name: result.agent_name,
    full_data_path: disclosure.full_data_path,
    preload_prompt: slimPreload,
    skills: slimSkills,
    unresolved: result.unresolved,
  };
}
