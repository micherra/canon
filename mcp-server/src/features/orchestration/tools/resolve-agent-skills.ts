import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import matter from "gray-matter";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";

/**
 * resolve_agent_skills — Canon's custom skill-preload resolver.
 *
 * Reads an agent's `skills:` frontmatter list, resolves each ID to a file under
 * `rules/`, `references/`, or `primers/`, and returns the concatenated content
 * ready for injection into a spawn prompt.
 *
 * Why this exists: Claude Code's native `skills:` preload requires each skill
 * to be its own `SKILL.md`-wrapped directory (see
 * https://code.claude.com/docs/en/sub-agents). Canon stores rules, protocol
 * fragments, and domain primers as flat .md files at `rules/<name>.md`,
 * `references/<name>.md`, `primers/<name>.md`. Rather than restructure 40+
 * files into per-skill directories, Canon runs its own resolver and the lead
 * injects the result into each spawn prompt.
 *
 * ID syntax:
 *   - `rule:<name>`   → `${pluginDir}/rules/<name>.md`
 *   - `ref:<name>`    → `${pluginDir}/references/<name>.md`
 *   - `primer:<name>` → `${pluginDir}/primers/<name>.md`
 *   - `<name>` (no prefix) → searches rules/, references/, primers/ in that order (backward compat)
 *
 * Missing files are skipped silently (per agent-context-check convention).
 */

export type ResolveAgentSkillsInput = {
  agent_name: string;
};

export type ResolvedSkill = {
  id: string;
  kind: "rule" | "ref" | "primer";
  path: string;
  content: string;
};

export type ResolveAgentSkillsResult = {
  agent_name: string;
  skills: ResolvedSkill[];
  unresolved: string[];
  preload_prompt: string;
};

const KIND_TO_DIR: Record<ResolvedSkill["kind"], string> = {
  rule: "rules",
  ref: "references",
  primer: "primers",
};

const BACKWARD_COMPAT_ORDER: ResolvedSkill["kind"][] = ["rule", "ref", "primer"];

function stripCanonPrefix(name: string): string {
  return name.startsWith("canon:") ? name.slice("canon:".length) : name;
}

function tryReadSkill(
  pluginDir: string,
  kind: ResolvedSkill["kind"],
  name: string,
): { path: string; content: string } | null {
  const path = join(pluginDir, KIND_TO_DIR[kind], `${name}.md`);
  try {
    const content = readFileSync(path, "utf-8");
    return { path, content };
  } catch {
    return null;
  }
}

function resolveOne(
  pluginDir: string,
  id: string,
): ResolvedSkill | { unresolved: string } {
  const colonIdx = id.indexOf(":");
  if (colonIdx > 0) {
    const prefix = id.slice(0, colonIdx);
    const name = id.slice(colonIdx + 1);
    if (prefix === "rule" || prefix === "ref" || prefix === "primer") {
      const hit = tryReadSkill(pluginDir, prefix, name);
      if (hit) {
        return { id, kind: prefix, path: hit.path, content: hit.content };
      }
      return { unresolved: id };
    }
    // Unknown prefix — skip (could be a future namespace)
    return { unresolved: id };
  }
  // Bare name — try each kind in order
  for (const kind of BACKWARD_COMPAT_ORDER) {
    const hit = tryReadSkill(pluginDir, kind, id);
    if (hit) {
      return { id, kind, path: hit.path, content: hit.content };
    }
  }
  return { unresolved: id };
}

function formatPreloadPrompt(skills: ResolvedSkill[]): string {
  if (skills.length === 0) {
    return "";
  }
  const sections = skills.map((s) => {
    const label = s.kind === "rule" ? "Rule" : s.kind === "ref" ? "Reference" : "Domain primer";
    return `### ${label}: ${s.id}\n\n${s.content.trim()}`;
  });
  return [
    "## Preloaded Skills",
    "",
    "The following rules, references, and primers have been preloaded from the agent's `skills:` frontmatter. Apply them as governing context throughout this task; do not re-read them.",
    "",
    sections.join("\n\n---\n\n"),
  ].join("\n");
}

export function resolveAgentSkills(
  input: ResolveAgentSkillsInput,
  pluginDir: string,
): ToolResult<ResolveAgentSkillsResult> {
  const agentName = stripCanonPrefix(input.agent_name).trim();
  if (!agentName || !/^[a-zA-Z0-9_-]+$/.test(agentName)) {
    return toolError(
      "INVALID_INPUT",
      `Invalid agent_name "${input.agent_name}": must match /^[a-zA-Z0-9_-]+$/ after stripping optional canon: prefix`,
    );
  }
  const agentPath = resolve(pluginDir, "agents", `${agentName}.md`);
  let agentFile: string;
  try {
    agentFile = readFileSync(agentPath, "utf-8");
  } catch (err) {
    return toolError(
      "INVALID_INPUT",
      `Agent file not found: ${agentPath} (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  const parsed = matter(agentFile);
  const rawSkills = parsed.data.skills;
  if (!Array.isArray(rawSkills)) {
    return toolOk<ResolveAgentSkillsResult>({
      agent_name: agentName,
      skills: [],
      unresolved: [],
      preload_prompt: "",
    });
  }
  const skills: ResolvedSkill[] = [];
  const unresolved: string[] = [];
  for (const entry of rawSkills) {
    if (typeof entry !== "string") continue;
    const result = resolveOne(pluginDir, entry);
    if ("unresolved" in result) {
      unresolved.push(result.unresolved);
    } else {
      skills.push(result);
    }
  }
  return toolOk<ResolveAgentSkillsResult>({
    agent_name: agentName,
    skills,
    unresolved,
    preload_prompt: formatPreloadPrompt(skills),
  });
}
