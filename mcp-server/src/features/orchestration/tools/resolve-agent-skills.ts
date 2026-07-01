import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { buildAreaMemorySection } from "@features/orchestration/services/area-memory-enrichment.ts";
import {
  formatCorrectionsSection,
  readCorrections,
} from "@features/orchestration/services/correction-reader.ts";
import { buildHotFileSection } from "@features/orchestration/services/hot-file-detection.ts";
import { buildPitfallsSection } from "@features/orchestration/services/pitfall-enrichment.ts";
import { applyAgentSkillsDisclosure } from "@features/orchestration/tools/resolve-agent-skills-disclosure.ts";
import { emitContextProvenance } from "@features/orchestration/tools/resolve-agent-skills-provenance.ts";
import { splitFrontmatter } from "@shared/lib/frontmatter.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";

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
  /** Journal step_id — durable join key for context provenance back-fill. Fail-open when absent. */
  step_id?: string;
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
    // best-effort: skill file may not exist (e.g. domain primer not installed); caller handles null
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

/**
 * Build area memory and hot-file sections, and log audit event when data found.
 * Fail-open: individual section errors produce empty strings; audit errors are warned.
 */
function buildAreaEnrichmentSections(
  filePaths: string[],
  projectDir: string,
  agentName: string,
  workspace: string | undefined,
): { areaMemorySection: string; hotFileSection: string } {
  const { section: areaMemorySection, count: areaMemoryCount } = buildAreaMemorySection(
    filePaths,
    projectDir,
  );
  const { section: hotFileSection, count: hotFileCount } = buildHotFileSection(
    filePaths,
    projectDir,
  );

  if ((areaMemoryCount > 0 || hotFileCount > 0) && workspace) {
    try {
      const store = getExecutionStore(workspace);
      store.appendEvent("area_enrichment_injected", {
        agent: agentName,
        area_memory_count: areaMemoryCount,
        hot_file_count: hotFileCount,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.warn("[area-enrichment] audit log failed:", err instanceof Error ? err.message : err);
    }
  }

  return { areaMemorySection, hotFileSection };
}

/**
 * Build all feed-forward enrichment sections (pitfalls + area memory + hot-file caution).
 * Extracted to reduce cognitive complexity of resolveAgentSkills.
 */
function buildFeedForwardSections(
  filePaths: string[],
  projectDir: string,
  agentName: string,
  workspace: string | undefined,
): { pitfallsSection: string; areaMemorySection: string; hotFileSection: string } {
  const { section: pitfallsSection, count: pitfallCount } = buildPitfallsSection(
    filePaths,
    projectDir,
  );
  if (pitfallsSection && workspace) {
    logPitfallAuditEvent(workspace, agentName, pitfallCount);
  }

  const { areaMemorySection, hotFileSection } = buildAreaEnrichmentSections(
    filePaths,
    projectDir,
    agentName,
    workspace,
  );

  return { areaMemorySection, hotFileSection, pitfallsSection };
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

/** Apply disclosure (if projectDir present), emit provenance, return final result. */
async function applyDisclosureAndEmit(args: {
  result: ResolveAgentSkillsResult;
  skills: ResolvedSkill[];
  projectDir: string | undefined;
  options: ResolveAgentSkillsOptions | undefined;
  agentDef: { path: string; fullFile: string };
  pluginDir: string;
}): Promise<ResolveAgentSkillsResult> {
  const { result, skills, projectDir, options, agentDef, pluginDir } = args;
  if (projectDir) {
    const disclosed = await applyAgentSkillsDisclosure(result, projectDir);
    // Emit provenance AFTER disclosure so char_span reflects the final prompt.
    emitContextProvenance({
      agentDef,
      disclosed,
      pluginDir,
      preDisclosureSkills: skills,
      stepId: options?.step_id,
      workspace: options?.workspace,
    });
    return disclosed;
  }
  // Non-disclosure branch: result has full content and no full_data_path.
  // Emit provenance when workspace is present (fail-open on absent workspace).
  emitContextProvenance({
    agentDef,
    disclosed: result,
    pluginDir,
    preDisclosureSkills: skills,
    stepId: options?.step_id,
    workspace: options?.workspace,
  });
  return result;
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
  const { data } = splitFrontmatter(agentFile);
  const { skills, unresolved } = resolveSkills(data, pluginDir);

  const basePrompt = formatPreloadPrompt(skills);
  const correctionsSection = buildCorrectionsSection(projectDir);

  // Build feed-forward enrichment sections when filePaths provided (fail-open)
  const filePaths = options?.filePaths ?? [];
  const { pitfallsSection, areaMemorySection, hotFileSection } =
    filePaths.length > 0 && projectDir
      ? buildFeedForwardSections(filePaths, projectDir, agentName, options?.workspace)
      : { areaMemorySection: "", hotFileSection: "", pitfallsSection: "" };

  // Compose preload_prompt: base → corrections → pitfalls → area memory → hot-file caution
  const sections = [
    basePrompt,
    correctionsSection,
    pitfallsSection,
    areaMemorySection,
    hotFileSection,
  ].filter(Boolean);
  const preload_prompt = sections.join("\n\n");

  const result: ResolveAgentSkillsResult = {
    agent_name: agentName,
    preload_prompt,
    skills,
    unresolved,
  };
  const final = await applyDisclosureAndEmit({
    agentDef: { fullFile: agentFile, path: agentPath },
    options,
    pluginDir,
    projectDir,
    result,
    skills,
  });
  return toolOk<ResolveAgentSkillsResult>(final);
}
