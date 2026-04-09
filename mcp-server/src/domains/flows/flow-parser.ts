/**
 * Flow file parsing and fragment resolution.
 *
 * Reads `.md` flow files (YAML frontmatter + markdown spawn instructions),
 * resolves fragment includes, and produces a fully validated ResolvedFlow.
 */

import { readdir, readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import {
  type ConsultationFragment,
  type FlowDefinition,
  FlowDefinitionSchema,
  type FragmentDefinition,
  FragmentDefinitionSchema,
  type FragmentInclude,
  type ResolvedFlow,
  type StateDefinition,
  StateDefinitionSchema,
} from "./flow-definition-schemas.ts";
import {
  buildEffectiveParams,
  mergeSpawnInstructions,
  resolveConsultationFragment,
  resolveRegularFragment,
} from "./flow-parser-fragments.ts";
import { validateFlow, validateStateIdParams } from "./flow-parser-validation.ts";

// parseFlowContent

/**
 * Split a flow/fragment `.md` file into YAML frontmatter and spawn instructions.
 *
 * Format:
 * ```
 * ---
 * <yaml>
 * ---
 *
 * ## Spawn Instructions
 *
 * ### state-id
 * prompt text ...
 * ```
 */
export function parseFlowContent(content: string): {
  frontmatter: Record<string, unknown>;
  spawnInstructions: Record<string, string>;
} {
  // Extract YAML between first pair of ---
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) {
    return { frontmatter: {}, spawnInstructions: {} };
  }

  const frontmatter = (parseYaml(fmMatch[1]) ?? {}) as Record<string, unknown>;
  const body = content.slice(fmMatch[0].length);

  // Parse spawn instructions from ### headings
  const spawnInstructions: Record<string, string> = {};
  const sections = body.split(/^### /m);
  for (const section of sections) {
    if (!section.trim()) continue;
    const newlineIdx = section.indexOf("\n");
    if (newlineIdx === -1) continue;
    const stateId = section.slice(0, newlineIdx).trim();
    const prompt = section.slice(newlineIdx + 1).trim();
    if (stateId) {
      spawnInstructions[stateId] = prompt;
    }
  }

  return { frontmatter, spawnInstructions };
}

// loadFragment

/**
 * Resolve a fragment file path using two-tier lookup:
 * 1. Check `${projectDir}/.canon/flows/fragments/${name}.md` first (if projectDir provided)
 * 2. Fall back to `${pluginDir}/flows/fragments/${name}.md`
 */
async function resolveFragmentFile(
  pluginDir: string,
  name: string,
  projectDir?: string,
): Promise<string> {
  if (projectDir) {
    const projectPath = `${projectDir}/.canon/flows/fragments/${name}.md`;
    try {
      return await readFile(projectPath, "utf-8");
    } catch {
      /* not in project dir, fall through */
    }
  }
  return await readFile(`${pluginDir}/flows/fragments/${name}.md`, "utf-8");
}

/**
 * Load a fragment file, using two-tier lookup (project dir first, then plugin dir).
 * Parse it, validate against FragmentDefinitionSchema, and return the
 * definition plus spawn instructions.
 */
export async function loadFragment(
  pluginDir: string,
  name: string,
  projectDir?: string,
): Promise<{
  definition: FragmentDefinition;
  spawnInstructions: Record<string, string>;
}> {
  const raw = await resolveFragmentFile(pluginDir, name, projectDir);
  const { frontmatter, spawnInstructions } = parseFlowContent(raw);
  const definition = FragmentDefinitionSchema.parse(frontmatter);
  return { definition, spawnInstructions };
}

// resolveFragments

/**
 * Resolve all fragment includes into merged states, consultations, and
 * spawn instructions.
 */
export function resolveFragments(
  _flow: FlowDefinition,
  fragments: Array<{
    definition: FragmentDefinition;
    spawnInstructions: Record<string, string>;
  }>,
  includes: FragmentInclude[],
): {
  states: Record<string, StateDefinition>;
  consultations: Record<string, ConsultationFragment>;
  spawnInstructions: Record<string, string>;
  firstFragmentEntry?: string;
} {
  const mergedStates: Record<string, StateDefinition> = {};
  const consultations: Record<string, ConsultationFragment> = {};
  const mergedSpawnInstructions: Record<string, string> = {};
  let firstFragmentEntry: string | undefined;

  for (const include of includes) {
    const found = fragments.find((f) => f.definition.fragment === include.fragment);
    if (!found) {
      throw new Error(`Fragment not found: ${include.fragment}`);
    }

    const { definition, spawnInstructions } = found;

    if (!firstFragmentEntry && definition.entry && definition.type !== "consultation") {
      firstFragmentEntry = include.as ?? definition.entry;
    }

    const effectiveParams = buildEffectiveParams(definition, include);

    if (definition.type === "consultation") {
      resolveConsultationFragment(definition, include, {
        consultations,
        effectiveParams,
        mergedSpawnInstructions,
        spawnInstructions,
      });
      continue;
    }

    resolveRegularFragment(definition, include, effectiveParams, mergedStates);
    mergeSpawnInstructions(definition, include, {
      effectiveParams,
      mergedSpawnInstructions,
      spawnInstructions,
    });
  }

  return {
    consultations,
    firstFragmentEntry,
    spawnInstructions: mergedSpawnInstructions,
    states: mergedStates,
  };
}

// loadAndResolveFlow

/**
 * Resolve a flow file using two-tier lookup:
 * 1. Check `${projectDir}/.canon/flows/${flowName}.md` first (if projectDir provided)
 * 2. Fall back to `${pluginDir}/flows/${flowName}.md`
 * Throws a descriptive error listing available flows if neither exists.
 */

/** Filter and extract flow names from directory entries. */
function extractFlowNames(entries: string[]): string[] {
  return entries
    .filter(
      (e) =>
        e.endsWith(".md") &&
        !e.startsWith(".") &&
        e !== "README.md" &&
        e !== "SCHEMA.md" &&
        e !== "GATES.md",
    )
    .map((e) => e.replace(/\.md$/, ""))
    .sort();
}

/** List all available flow names from plugin and project directories. */
async function listAvailableFlows(pluginDir: string, projectDir?: string): Promise<string[]> {
  let available: string[] = [];
  try {
    available = extractFlowNames(await readdir(`${pluginDir}/flows`));
  } catch {
    /* flows dir missing */
  }
  if (!projectDir) return available;
  try {
    const projectFlows = extractFlowNames(await readdir(`${projectDir}/.canon/flows`));
    return [...new Set([...available, ...projectFlows])].sort();
  } catch {
    return available;
  }
}

async function resolveFlowFile(
  pluginDir: string,
  flowName: string,
  projectDir?: string,
): Promise<string> {
  if (projectDir) {
    const projectPath = `${projectDir}/.canon/flows/${flowName}.md`;
    try {
      return await readFile(projectPath, "utf-8");
    } catch {
      /* not in project dir, fall through */
    }
  }
  const pluginPath = `${pluginDir}/flows/${flowName}.md`;
  try {
    return await readFile(pluginPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const available = await listAvailableFlows(pluginDir, projectDir);
    const list = available.length > 0 ? `: ${available.join(", ")}` : "";
    throw new Error(
      `Flow "${flowName}" not found (checked ${projectDir ? `${projectDir}/.canon/flows/ and ` : ""}${pluginPath}). Available flows${list}`,
    );
  }
}

/**
 * Orchestrates the full flow loading pipeline:
 * 1. Read and parse the flow file (project dir first, then plugin dir)
 * 2. Validate frontmatter
 * 3. Resolve fragment includes
 * 4. Build ResolvedFlow
 * 5. Validate — throws on any error (hard-blocking per ADR-004)
 *
 * Returns the resolved flow directly (no errors field — validation either
 * passes or throws a descriptive error).
 */

/** Re-validate all resolved states through the strict schema. */
function validateResolvedStates(resolvedStates: Record<string, unknown>): {
  validatedStates: Record<string, StateDefinition>;
  errors: string[];
} {
  const validatedStates: Record<string, StateDefinition> = {};
  const errors: string[] = [];
  for (const [stateId, stateDef] of Object.entries(resolvedStates)) {
    const result = StateDefinitionSchema.safeParse(stateDef);
    if (result.success) {
      validatedStates[stateId] = result.data;
    } else {
      errors.push(
        `State "${stateId}" failed validation after param substitution: ${JSON.stringify(result.error.issues)}`,
      );
    }
  }
  return { errors, validatedStates };
}

/** Resolve fragment includes and merge with inline states/spawn instructions. */
type ResolveIncludesOpts = {
  inlineStates: Record<string, StateDefinition>;
  spawnInstructions: Record<string, string>;
  pluginDir: string;
  projectDir?: string;
};

async function resolveIncludes(
  flowDef: FlowDefinition,
  opts: ResolveIncludesOpts,
): Promise<{
  resolvedStates: Record<string, unknown>;
  resolvedConsultations: Record<string, ConsultationFragment>;
  resolvedSpawnInstructions: Record<string, string>;
  fragmentEntry: string | undefined;
  loadedFragments: Array<{
    definition: FragmentDefinition;
    spawnInstructions: Record<string, string>;
  }>;
}> {
  const { inlineStates, spawnInstructions, pluginDir, projectDir } = opts;
  if (!flowDef.includes || flowDef.includes.length === 0) {
    return {
      fragmentEntry: undefined,
      loadedFragments: [],
      resolvedConsultations: {},
      resolvedSpawnInstructions: { ...spawnInstructions },
      resolvedStates: { ...inlineStates },
    };
  }

  const fragmentNames = [...new Set(flowDef.includes.map((i) => i.fragment))];
  const loadedFragments = await Promise.all(
    fragmentNames.map((name) => loadFragment(pluginDir, name, projectDir)),
  );
  const resolved = resolveFragments(flowDef, loadedFragments, flowDef.includes);
  return {
    fragmentEntry: resolved.firstFragmentEntry,
    loadedFragments,
    resolvedConsultations: resolved.consultations,
    resolvedSpawnInstructions: { ...resolved.spawnInstructions, ...spawnInstructions },
    resolvedStates: { ...resolved.states, ...inlineStates },
  };
}

export async function loadAndResolveFlow(
  pluginDir: string,
  flowName: string,
  projectDir?: string,
): Promise<ResolvedFlow> {
  if (!/^[a-zA-Z0-9_-]+$/.test(flowName)) {
    throw new Error(
      `Invalid flow name "${flowName}": only alphanumeric characters, hyphens, and underscores are allowed`,
    );
  }
  const raw = await resolveFlowFile(pluginDir, flowName, projectDir);
  const { frontmatter, spawnInstructions } = parseFlowContent(raw);
  const flowDef = FlowDefinitionSchema.parse(frontmatter);

  const hasInlineStates = flowDef.states && Object.keys(flowDef.states).length > 0;
  const hasIncludes = flowDef.includes && flowDef.includes.length > 0;
  if (!hasInlineStates && !hasIncludes) {
    throw new Error(`Flow "${flowName}" has no states and no includes — nothing to resolve`);
  }

  const inlineStates = flowDef.states ?? {};
  const {
    resolvedStates,
    resolvedConsultations,
    resolvedSpawnInstructions,
    fragmentEntry,
    loadedFragments,
  } = await resolveIncludes(flowDef, { inlineStates, pluginDir, projectDir, spawnInstructions });

  const { validatedStates, errors: schemaErrors } = validateResolvedStates(resolvedStates);

  const resolvedStateIds = new Set(Object.keys(resolvedStates));
  const stateIdParamErrors =
    loadedFragments.length > 0 && flowDef.includes
      ? validateStateIdParams(loadedFragments, flowDef.includes, resolvedStateIds)
      : [];

  const entry = flowDef.entry ?? Object.keys(inlineStates)[0] ?? fragmentEntry;
  if (!entry) {
    throw new Error(
      `Flow "${flowName}" has no entry state — set entry: in frontmatter or include a fragment with an entry`,
    );
  }

  const resolvedFlow: ResolvedFlow = {
    ...flowDef,
    entry,
    spawn_instructions: resolvedSpawnInstructions,
    states: validatedStates,
    ...(Object.keys(resolvedConsultations).length > 0
      ? { consultations: resolvedConsultations }
      : {}),
  };

  const allMessages = [...schemaErrors, ...stateIdParamErrors, ...validateFlow(resolvedFlow)];
  const hardErrors = allMessages.filter((msg) => !msg.startsWith("Warning:"));

  if (hardErrors.length > 0) {
    throw new Error(`Flow "${flowName}" validation failed:\n${hardErrors.join("\n")}`);
  }

  return resolvedFlow;
}
