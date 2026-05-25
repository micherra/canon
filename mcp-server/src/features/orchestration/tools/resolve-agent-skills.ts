import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { buildPitfallsSection } from "@features/diagnostics/services/pitfall-enrichment.ts";
import {
  formatCorrectionsSection,
  readCorrections,
} from "@features/orchestration/services/correction-reader.ts";
import { applyAgentSkillsDisclosure } from "@features/orchestration/tools/resolve-agent-skills-disclosure.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import matter from "gray-matter";

/**
 * resolve_agent_skills — Canon's custom skill-preload resolver.
 *
 * Reads four dedicated frontmatter fields from an agent definition:
 *
 *   rules:      [<name>, ...]   → loaded from `rules/<name>.md`
 *   references: [<name>, ...]   → loaded from `references/<name>.md`
 *   primers:    [<name>, ...]   → loaded from `primers/<name>.md`
 *   templates:  [<name>, ...]   → loaded from `templates/<name>.md`
 *
 * Returns a structured list of resolved content plus a single
 * `preload_prompt` string ready to inject at the top of a spawn prompt.
 *
 * Why four fields rather than one `skills:` with prefixes? Claude Code's
 * native `skills:` mechanism expects SKILL.md-wrapped directories (see
 * https://code.claude.com/docs/en/sub-agents). Canon stores rules,
 * protocol fragments, domain primers, and output templates as flat .md
 * files and resolves them itself. Keeping Canon's declarations out of
 * `skills:` means the native preloader never sees them, produces no
 * spurious "skill not found" warnings, and remains available for real
 * native skills if anyone ever registers one.
 *
 * Missing files are collected in `unresolved` (formatted as "<kind>:<name>"
 * for clarity) and otherwise skipped silently, matching the
 * agent-context-check convention that missing context is degraded, not
 * blocked.
 */

export type ResolveAgentSkillsInput = {
  agent_name: string;
};

/**
 * Options for feed-forward enrichment in resolve_agent_skills.
 *
 * When filePaths is provided, pitfall enrichment is performed against
 * drift.db and appended to preload_prompt. Fail-open: errors produce
 * an empty pitfalls section without blocking spawn.
 */
export type ResolveAgentSkillsOptions = {
  /** File paths to query for historical pitfalls. */
  filePaths?: string[];
  /** Workspace path for audit logging. When provided, a pitfall_injected event is appended. */
  workspace?: string;
};

export type ResolvedSkillKind = "rule" | "ref" | "primer" | "template";

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
  /** Set when progressive disclosure truncated the result; path to full JSON payload. */
  full_data_path?: string;
};

const KIND_TO_DIR: Record<ResolvedSkillKind, string> = {
  primer: "primers",
  ref: "references",
  rule: "rules",
  template: "templates",
};

const KIND_TO_FIELD: Record<ResolvedSkillKind, string> = {
  primer: "primers",
  ref: "references",
  rule: "rules",
  template: "templates",
};

const KIND_ORDER: ResolvedSkillKind[] = ["rule", "ref", "primer", "template"];

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

const KIND_LABEL: Record<ResolvedSkillKind, string> = {
  primer: "Domain primer",
  ref: "Reference",
  rule: "Rule",
  template: "Template",
};

function formatPreloadPrompt(skills: ResolvedSkill[]): string {
  if (skills.length === 0) return "";
  const sections = skills.map((s) => `### ${KIND_LABEL[s.kind]}: ${s.id}\n\n${s.content.trim()}`);
  return [
    "## Preloaded Skills",
    "",
    "The following rules, references, primers, and templates have been preloaded from the agent's frontmatter. Apply rules and references as governing context. Produce outputs matching the shape of any declared template; do not re-read these files.",
    "",
    sections.join("\n\n---\n\n"),
  ].join("\n");
}

/**
 * Log a pitfall_injected audit event to the execution store.
 * Fail-open: store errors are silently ignored so audit never blocks spawn.
 */
function logPitfallAuditEvent(workspace: string, agentName: string, pitfallCount: number): void {
  try {
    const store = getExecutionStore(workspace);
    store.appendEvent("pitfall_injected", {
      agent: agentName,
      pitfall_count: pitfallCount,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(
      "[pitfall-enrichment] logPitfallAuditEvent failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

function buildCorrectionsSection(projectDir: string | undefined): string {
  if (!projectDir) return "";
  const result = readCorrections(projectDir);
  if (!result.ok) {
    console.warn("[resolve-agent-skills] corrections unavailable:", result.error);
    return "\n\n## Recent User Corrections\n\n_Corrections unavailable due to a read error. Details have been logged._";
  }
  return formatCorrectionsSection(result.records);
}

/** Resolve skills for an agent from its frontmatter fields. */
function resolveSkills(
  data: Record<string, unknown>,
  pluginDir: string,
): { skills: ResolvedSkill[]; unresolved: string[] } {
  const skills: ResolvedSkill[] = [];
  const unresolved: string[] = [];
  for (const kind of KIND_ORDER) {
    const ids = coerceStringList(data[KIND_TO_FIELD[kind]]);
    for (const id of ids) {
      const hit = tryReadSkill(pluginDir, kind, id);
      if (hit) {
        skills.push({ content: hit.content, id, kind, path: hit.path });
      } else {
        unresolved.push(`${kind}:${id}`);
      }
    }
  }
  return { skills, unresolved };
}

export async function resolveAgentSkills(
  input: ResolveAgentSkillsInput,
  pluginDir: string,
  projectDir?: string,
  options?: ResolveAgentSkillsOptions,
): Promise<ToolResult<ResolveAgentSkillsResult>> {
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
  const { skills, unresolved } = resolveSkills(parsed.data as Record<string, unknown>, pluginDir);

  const basePrompt = formatPreloadPrompt(skills);
  const correctionsSection = buildCorrectionsSection(projectDir);

  // Build pitfalls section when filePaths provided (fail-open)
  const filePaths = options?.filePaths ?? [];
  const { section: pitfallsSection, count: pitfallCount } =
    filePaths.length > 0 && projectDir
      ? buildPitfallsSection(filePaths, projectDir)
      : { count: 0, section: "" };

  // Audit log when pitfalls found and workspace provided
  if (pitfallsSection && options?.workspace) {
    logPitfallAuditEvent(options.workspace, agentName, pitfallCount);
  }

  // Compose preload_prompt: base → corrections → pitfalls
  const sections = [basePrompt, correctionsSection, pitfallsSection].filter(Boolean);
  const preload_prompt = sections.join("\n\n");

  const result: ResolveAgentSkillsResult = {
    agent_name: agentName,
    preload_prompt,
    skills,
    unresolved,
  };

  if (projectDir) {
    const disclosed = await applyAgentSkillsDisclosure(result, projectDir);
    return toolOk<ResolveAgentSkillsResult>(disclosed);
  }

  return toolOk<ResolveAgentSkillsResult>(result);
}
