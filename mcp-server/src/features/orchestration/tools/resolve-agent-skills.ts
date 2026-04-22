import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import matter from "gray-matter";

/**
 * resolve_agent_skills — Canon's custom skill-preload resolver.
 *
 * Reads three dedicated frontmatter fields from an agent definition:
 *
 *   rules:      [<name>, ...]   → loaded from `rules/<name>.md`
 *   references: [<name>, ...]   → loaded from `references/<name>.md`
 *   primers:    [<name>, ...]   → loaded from `primers/<name>.md`
 *
 * Returns a structured list of resolved content plus a single
 * `preload_prompt` string ready to inject at the top of a spawn prompt.
 *
 * Why three fields rather than one `skills:` with prefixes? Claude Code's
 * native `skills:` mechanism expects SKILL.md-wrapped directories (see
 * https://code.claude.com/docs/en/sub-agents). Canon stores rules,
 * protocol fragments, and domain primers as flat .md files and resolves
 * them itself. Keeping Canon's declarations out of `skills:` means the
 * native preloader never sees them, produces no spurious "skill not
 * found" warnings, and remains available for real native skills if
 * anyone ever registers one.
 *
 * Missing files are collected in `unresolved` (formatted as "<kind>:<name>"
 * for clarity) and otherwise skipped silently, matching the
 * agent-context-check convention that missing context is degraded, not
 * blocked.
 */

export type ResolveAgentSkillsInput = {
  agent_name: string;
};

export type ResolvedSkillKind = "rule" | "ref" | "primer";

export type ResolvedSkill = {
  id: string;
  kind: ResolvedSkillKind;
  path: string;
  content: string;
};

export type ResolveAgentSkillsResult = {
  agent_name: string;
  skills: ResolvedSkill[];
  unresolved: string[];
  preload_prompt: string;
};

const KIND_TO_DIR: Record<ResolvedSkillKind, string> = {
  primer: "primers",
  ref: "references",
  rule: "rules",
};

const KIND_TO_FIELD: Record<ResolvedSkillKind, string> = {
  primer: "primers",
  ref: "references",
  rule: "rules",
};

const KIND_ORDER: ResolvedSkillKind[] = ["rule", "ref", "primer"];

function stripCanonPrefix(name: string): string {
  return name.startsWith("canon:") ? name.slice("canon:".length) : name;
}

function coerceStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function tryReadSkill(
  pluginDir: string,
  kind: ResolvedSkillKind,
  name: string,
): { path: string; content: string } | null {
  const path = join(pluginDir, KIND_TO_DIR[kind], `${name}.md`);
  try {
    const content = readFileSync(path, "utf-8");
    return { content, path };
  } catch {
    return null;
  }
}

function formatPreloadPrompt(skills: ResolvedSkill[]): string {
  if (skills.length === 0) return "";
  const sections = skills.map((s) => {
    const label = s.kind === "rule" ? "Rule" : s.kind === "ref" ? "Reference" : "Domain primer";
    return `### ${label}: ${s.id}\n\n${s.content.trim()}`;
  });
  return [
    "## Preloaded Skills",
    "",
    "The following rules, references, and primers have been preloaded from the agent's frontmatter. Apply them as governing context throughout this task; do not re-read them.",
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
  const skills: ResolvedSkill[] = [];
  const unresolved: string[] = [];
  for (const kind of KIND_ORDER) {
    const ids = coerceStringList(parsed.data[KIND_TO_FIELD[kind]]);
    for (const id of ids) {
      const hit = tryReadSkill(pluginDir, kind, id);
      if (hit) {
        skills.push({ content: hit.content, id, kind, path: hit.path });
      } else {
        unresolved.push(`${kind}:${id}`);
      }
    }
  }
  return toolOk<ResolveAgentSkillsResult>({
    agent_name: agentName,
    preload_prompt: formatPreloadPrompt(skills),
    skills,
    unresolved,
  });
}
