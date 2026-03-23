/**
 * Flow file parsing and fragment resolution.
 *
 * Reads `.md` flow files (YAML frontmatter + markdown spawn instructions),
 * resolves fragment includes, and produces a fully validated ResolvedFlow.
 */

import { readFile } from "fs/promises";
import { parse as parseYaml } from "yaml";
import {
  FlowDefinitionSchema,
  FragmentDefinitionSchema,
  StateDefinitionSchema,
  type FlowDefinition,
  type FragmentDefinition,
  type FragmentInclude,
  type StateDefinition,
  type ConsultationFragment,
  type ResolvedFlow,
} from "./flow-schema.js";

// ---------------------------------------------------------------------------
// parseFlowContent
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// loadFragment
// ---------------------------------------------------------------------------

/**
 * Load a fragment file from `${pluginDir}/flows/fragments/${name}.md`,
 * parse it, validate against FragmentDefinitionSchema, and return the
 * definition plus spawn instructions.
 */
export async function loadFragment(
  pluginDir: string,
  name: string,
): Promise<{
  definition: FragmentDefinition;
  spawnInstructions: Record<string, string>;
}> {
  const filePath = `${pluginDir}/flows/fragments/${name}.md`;
  const raw = await readFile(filePath, "utf-8");
  const { frontmatter, spawnInstructions } = parseFlowContent(raw);
  const definition = FragmentDefinitionSchema.parse(frontmatter);
  return { definition, spawnInstructions };
}

// ---------------------------------------------------------------------------
// resolveFragments
// ---------------------------------------------------------------------------

/**
 * Deep string substitution: recursively walk an object and replace every
 * `${param}` occurrence in string values with the corresponding param value.
 *
 * Uses recursive traversal instead of JSON round-trip to avoid breaking on
 * param values that contain JSON-special characters (quotes, backslashes).
 */
function substituteParams<T>(obj: T, params: Record<string, string | number>): T {
  if (typeof obj === "string") {
    let result: string = obj;
    for (const [key, value] of Object.entries(params)) {
      result = result.replaceAll(`\${${key}}`, String(value));
    }
    return result as T & string;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => substituteParams(item, params)) as T & unknown[];
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = substituteParams(value, params);
    }
    return result as T;
  }
  return obj;
}

/**
 * Substitute params in spawn instruction text.
 */
function substituteSpawnInstructions(
  instructions: Record<string, string>,
  params: Record<string, string | number>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, text] of Object.entries(instructions)) {
    let substituted = text;
    for (const [pKey, pVal] of Object.entries(params)) {
      substituted = substituted.replaceAll(`\${${pKey}}`, String(pVal));
    }
    result[key] = substituted;
  }
  return result;
}

/**
 * Resolve all fragment includes into merged states, consultations, and
 * spawn instructions.
 */
export function resolveFragments(
  flow: FlowDefinition,
  fragments: Array<{
    definition: FragmentDefinition;
    spawnInstructions: Record<string, string>;
  }>,
  includes: FragmentInclude[],
): {
  states: Record<string, StateDefinition>;
  consultations: Record<string, ConsultationFragment>;
  spawnInstructions: Record<string, string>;
} {
  const mergedStates: Record<string, StateDefinition> = {};
  const consultations: Record<string, ConsultationFragment> = {};
  const mergedSpawnInstructions: Record<string, string> = {};

  for (const include of includes) {
    const found = fragments.find((f) => f.definition.fragment === include.fragment);
    if (!found) {
      throw new Error(`Fragment not found: ${include.fragment}`);
    }

    const { definition, spawnInstructions } = found;

    // Validate required params (those with null values in the fragment's params)
    const withParams = include.with ?? {};
    if (definition.params) {
      for (const [paramName, defaultVal] of Object.entries(definition.params)) {
        if (defaultVal === null || defaultVal === undefined) {
          if (!(paramName in withParams)) {
            throw new Error(
              `Fragment "${include.fragment}" requires param "${paramName}" but it was not provided`,
            );
          }
        }
      }
    }

    // Build effective params: defaults merged with include.with
    const effectiveParams: Record<string, string | number> = {};
    if (definition.params) {
      for (const [k, v] of Object.entries(definition.params)) {
        if (v !== null) {
          effectiveParams[k] = v;
        }
      }
    }
    for (const [k, v] of Object.entries(withParams)) {
      effectiveParams[k] = v;
    }

    // Handle consultation-type fragments
    if (definition.type === "consultation") {
      const consultation: ConsultationFragment = {
        fragment: definition.fragment,
        description: definition.description,
        agent: definition.agent!,
        role: definition.role!,
        section: definition.section,
        artifact: definition.artifact,
        timeout: definition.timeout,
      };

      const substituted = Object.keys(effectiveParams).length > 0
        ? substituteParams(consultation, effectiveParams)
        : consultation;

      const consultName = include.as ?? definition.fragment;
      consultations[consultName] = substituted;

      // Merge spawn instructions for consultation
      const fragSpawn = Object.keys(effectiveParams).length > 0
        ? substituteSpawnInstructions(spawnInstructions, effectiveParams)
        : { ...spawnInstructions };

      for (const [sId, sText] of Object.entries(fragSpawn)) {
        const spawnKey = include.as ? sId.replace(definition.fragment, include.as) : sId;
        mergedSpawnInstructions[spawnKey] = sText;
      }

      continue;
    }

    // Regular fragment: merge states
    if (definition.states) {
      let states = Object.keys(effectiveParams).length > 0
        ? substituteParams(definition.states, effectiveParams)
        : { ...definition.states };

      // Apply overrides
      if (include.overrides) {
        for (const [stateId, overrideFields] of Object.entries(include.overrides)) {
          if (states[stateId]) {
            states[stateId] = { ...states[stateId], ...overrideFields } as StateDefinition;
          }
        }
      }

      // Apply rename (as:) — only valid for single-state fragments
      if (include.as) {
        const stateEntries = Object.entries(states);
        if (stateEntries.length !== 1) {
          throw new Error(
            `Fragment "${include.fragment}" has ${stateEntries.length} states but "as:" only works with single-state fragments`,
          );
        }
        states = { [include.as]: stateEntries[0][1] };
      }

      // Check for collisions and merge
      for (const [stateId, stateDef] of Object.entries(states)) {
        if (mergedStates[stateId]) {
          throw new Error(`State ID collision: "${stateId}" already exists`);
        }
        mergedStates[stateId] = stateDef as StateDefinition;
      }
    }

    // Merge spawn instructions
    const fragSpawn = Object.keys(effectiveParams).length > 0
      ? substituteSpawnInstructions(spawnInstructions, effectiveParams)
      : { ...spawnInstructions };

    for (const [sId, sText] of Object.entries(fragSpawn)) {
      mergedSpawnInstructions[sId] = sText;
    }
  }

  return {
    states: mergedStates,
    consultations,
    spawnInstructions: mergedSpawnInstructions,
  };
}

// ---------------------------------------------------------------------------
// validateFlow
// ---------------------------------------------------------------------------

/**
 * Validate a resolved flow definition. Returns an array of error messages
 * (empty if valid).
 */
export function validateFlow(flow: ResolvedFlow): string[] {
  const errors: string[] = [];
  const stateIds = new Set(Object.keys(flow.states));

  // Entry state must exist
  if (!stateIds.has(flow.entry)) {
    errors.push(`Entry state "${flow.entry}" does not exist in states`);
  }

  for (const [stateId, stateDef] of Object.entries(flow.states)) {
    // All transition targets must exist (or be "hitl")
    if (stateDef.transitions) {
      for (const [condition, target] of Object.entries(stateDef.transitions)) {
        if (target !== "hitl" && !stateIds.has(target)) {
          errors.push(
            `State "${stateId}" transition "${condition}" targets non-existent state "${target}"`,
          );
        }
      }
    }

    // States with max_iterations should have stuck_when
    if (stateDef.max_iterations !== undefined && !stateDef.stuck_when) {
      errors.push(
        `State "${stateId}" has max_iterations but no stuck_when`,
      );
    }

    // parallel-per states should have iterate_on
    if (stateDef.type === "parallel-per" && !stateDef.iterate_on) {
      errors.push(`State "${stateId}" is parallel-per but has no iterate_on`);
    }

    // terminal states should not have transitions
    if (stateDef.type === "terminal" && stateDef.transitions) {
      errors.push(
        `State "${stateId}" is terminal but has transitions`,
      );
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// buildStateGraph
// ---------------------------------------------------------------------------

/**
 * Build an adjacency list from flow states: state → [target states].
 */
export function buildStateGraph(flow: ResolvedFlow): Record<string, string[]> {
  const graph: Record<string, string[]> = {};

  for (const [stateId, stateDef] of Object.entries(flow.states)) {
    const seen = new Set<string>();
    const targets: string[] = [];
    if (stateDef.transitions) {
      for (const target of Object.values(stateDef.transitions)) {
        if (!seen.has(target)) {
          seen.add(target);
          targets.push(target);
        }
      }
    }
    graph[stateId] = targets;
  }

  return graph;
}

// ---------------------------------------------------------------------------
// loadAndResolveFlow
// ---------------------------------------------------------------------------

/**
 * Orchestrates the full flow loading pipeline:
 * 1. Read and parse the flow file
 * 2. Validate frontmatter
 * 3. Resolve fragment includes
 * 4. Build ResolvedFlow
 * 5. Validate and return
 */
export async function loadAndResolveFlow(
  pluginDir: string,
  flowName: string,
): Promise<{ flow: ResolvedFlow; errors: string[] }> {
  if (!/^[a-zA-Z0-9_-]+$/.test(flowName)) {
    throw new Error(
      `Invalid flow name "${flowName}": only alphanumeric characters, hyphens, and underscores are allowed`,
    );
  }
  const filePath = `${pluginDir}/flows/${flowName}.md`;
  const raw = await readFile(filePath, "utf-8");
  const { frontmatter, spawnInstructions } = parseFlowContent(raw);

  // Validate frontmatter against FlowDefinitionSchema
  const flowDef = FlowDefinitionSchema.parse(frontmatter);

  const hasInlineStates = flowDef.states && Object.keys(flowDef.states).length > 0;
  const hasIncludes = flowDef.includes && flowDef.includes.length > 0;
  if (!hasInlineStates && !hasIncludes) {
    throw new Error(`Flow "${flowName}" has no states and no includes — nothing to resolve`);
  }

  const inlineStates = flowDef.states ?? {};
  let resolvedStates = { ...inlineStates };
  let resolvedConsultations: Record<string, ConsultationFragment> = {};
  let resolvedSpawnInstructions = { ...spawnInstructions };

  // If includes exist, load all fragments and resolve
  if (flowDef.includes && flowDef.includes.length > 0) {
    // Load all unique fragments
    const fragmentNames = [...new Set(flowDef.includes.map((i) => i.fragment))];
    const loadedFragments = await Promise.all(
      fragmentNames.map((name) => loadFragment(pluginDir, name)),
    );

    const resolved = resolveFragments(flowDef, loadedFragments, flowDef.includes);

    // Merge fragment states with flow states (flow states take precedence)
    resolvedStates = { ...resolved.states, ...inlineStates };
    resolvedConsultations = resolved.consultations;
    resolvedSpawnInstructions = { ...resolved.spawnInstructions, ...spawnInstructions };
  }

  // Re-validate all states through the strict schema after param substitution
  const validatedStates: Record<string, StateDefinition> = {};
  const schemaErrors: string[] = [];
  for (const [stateId, stateDef] of Object.entries(resolvedStates)) {
    const result = StateDefinitionSchema.safeParse(stateDef);
    if (result.success) {
      validatedStates[stateId] = result.data;
    } else {
      schemaErrors.push(
        `State "${stateId}" failed validation after param substitution: ${JSON.stringify(result.error.issues)}`,
      );
    }
  }

  // Determine entry: explicit, or first state from the flow's own states
  // (not fragment states, which are merged first and would wrongly take priority)
  const entry = flowDef.entry ?? Object.keys(inlineStates)[0] ?? Object.keys(validatedStates)[0];

  const resolvedFlow: ResolvedFlow = {
    ...flowDef,
    entry,
    states: validatedStates,
    spawn_instructions: resolvedSpawnInstructions,
    ...(Object.keys(resolvedConsultations).length > 0
      ? { consultations: resolvedConsultations }
      : {}),
  };

  const errors = [...schemaErrors, ...validateFlow(resolvedFlow)];

  return { flow: resolvedFlow, errors };
}
