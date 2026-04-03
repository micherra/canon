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
  type TypedParam,
} from "./flow-schema.ts";

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
 * Resolve a fragment file path using two-tier lookup:
 * 1. Check `${projectDir}/.canon/flows/fragments/${name}.md` first (if projectDir provided)
 * 2. Fall back to `${pluginDir}/flows/fragments/${name}.md`
 */
async function resolveFragmentFile(pluginDir: string, name: string, projectDir?: string): Promise<string> {
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
function substituteParams<T>(obj: T, params: Record<string, string | number | boolean>): T {
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
  params: Record<string, string | number | boolean>,
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
      resolveConsultationFragment(
        definition,
        include,
        effectiveParams,
        spawnInstructions,
        consultations,
        mergedSpawnInstructions,
      );
      continue;
    }

    resolveRegularFragment(definition, include, effectiveParams, mergedStates);
    mergeSpawnInstructions(definition, include, effectiveParams, spawnInstructions, mergedSpawnInstructions);
  }

  return {
    states: mergedStates,
    consultations,
    spawnInstructions: mergedSpawnInstructions,
    firstFragmentEntry,
  };
}

/**
 * Type guard: returns true if value is a typed param object ({ type, default? }).
 * Distinguishes new-format typed params from old-format scalar/null values.
 */
function isTypedParam(v: unknown): v is TypedParam {
  return v !== null && typeof v === "object" && "type" in v;
}

/** Validate required params and build the effective params map (defaults + overrides). */
function buildEffectiveParams(
  definition: FragmentDefinition,
  include: FragmentInclude,
): Record<string, string | number | boolean> {
  const withParams = include.with ?? {};
  if (definition.params) {
    for (const [paramName, paramDef] of Object.entries(definition.params)) {
      if (isTypedParam(paramDef)) {
        // New typed format: required if no default and not provided in with
        if (paramDef.default === undefined && !(paramName in withParams)) {
          throw new Error(`Fragment "${include.fragment}" requires param "${paramName}" but it was not provided`);
        }
      } else {
        // Old format: null means required
        if ((paramDef === null || paramDef === undefined) && !(paramName in withParams)) {
          throw new Error(`Fragment "${include.fragment}" requires param "${paramName}" but it was not provided`);
        }
      }
    }
  }

  // Build effective params: typed param defaults, then old-format scalar defaults, then with overrides
  const defaults: Record<string, string | number | boolean> = {};
  for (const [paramName, paramDef] of Object.entries(definition.params ?? {})) {
    if (isTypedParam(paramDef)) {
      // Use typed default if defined; skip if no default (caller must supply via with)
      if (paramDef.default !== undefined) {
        defaults[paramName] = paramDef.default as string | number | boolean;
      }
    } else if (paramDef !== null && paramDef !== undefined) {
      // Old format: non-null scalar is a default value (includes false)
      defaults[paramName] = paramDef as string | number | boolean;
    }
  }

  return {
    ...defaults,
    ...(include.with ?? {}),
  } as Record<string, string | number | boolean>;
}

/** Resolve a consultation-type fragment into the consultations and spawn instructions maps. */
function resolveConsultationFragment(
  definition: FragmentDefinition,
  include: FragmentInclude,
  effectiveParams: Record<string, string | number | boolean>,
  spawnInstructions: Record<string, string>,
  consultations: Record<string, ConsultationFragment>,
  mergedSpawnInstructions: Record<string, string>,
): void {
  const consultation: ConsultationFragment = {
    fragment: definition.fragment,
    description: definition.description,
    agent: definition.agent!,
    role: definition.role!,
    section: definition.section,
    artifact: definition.artifact,
    timeout: definition.timeout,
    min_waves: definition.min_waves,
    ...(definition.skip_when !== undefined ? { skip_when: definition.skip_when } : {}),
  };

  const hasParams = Object.keys(effectiveParams).length > 0;
  const substituted = hasParams ? substituteParams(consultation, effectiveParams) : consultation;
  const consultName = include.as ?? definition.fragment;
  consultations[consultName] = substituted;

  mergeSpawnInstructions(definition, include, effectiveParams, spawnInstructions, mergedSpawnInstructions);
}

/** Resolve a regular (non-consultation) fragment's states into the merged states map. */
function resolveRegularFragment(
  definition: FragmentDefinition,
  include: FragmentInclude,
  effectiveParams: Record<string, string | number | boolean>,
  mergedStates: Record<string, StateDefinition>,
): void {
  if (!definition.states) return;

  const hasParams = Object.keys(effectiveParams).length > 0;
  let states = hasParams ? substituteParams(definition.states, effectiveParams) : { ...definition.states };

  if (include.overrides) {
    for (const [stateId, overrideFields] of Object.entries(include.overrides)) {
      if (states[stateId]) {
        states[stateId] = { ...states[stateId], ...overrideFields } as StateDefinition;
      }
    }
  }

  if (include.as) {
    const stateEntries = Object.entries(states);
    if (stateEntries.length !== 1) {
      throw new Error(
        `Fragment "${include.fragment}" has ${stateEntries.length} states but "as:" only works with single-state fragments`,
      );
    }
    states = { [include.as]: stateEntries[0][1] };
  }

  for (const [stateId, stateDef] of Object.entries(states)) {
    if (mergedStates[stateId]) {
      throw new Error(`State ID collision: "${stateId}" already exists`);
    }
    mergedStates[stateId] = stateDef as StateDefinition;
  }
}

/** Merge spawn instructions from a fragment, applying param substitution and renaming. */
function mergeSpawnInstructions(
  definition: FragmentDefinition,
  include: FragmentInclude,
  effectiveParams: Record<string, string | number | boolean>,
  spawnInstructions: Record<string, string>,
  mergedSpawnInstructions: Record<string, string>,
): void {
  const hasParams = Object.keys(effectiveParams).length > 0;
  const fragSpawn = hasParams
    ? substituteSpawnInstructions(spawnInstructions, effectiveParams)
    : { ...spawnInstructions };

  for (const [sId, sText] of Object.entries(fragSpawn)) {
    const spawnKey = include.as ? sId.replace(definition.fragment, include.as) : sId;
    mergedSpawnInstructions[spawnKey] = sText;
  }
}

// ---------------------------------------------------------------------------
// VIRTUAL_SINKS / RUNTIME_VARIABLES constants
// ---------------------------------------------------------------------------

/**
 * Virtual transition targets that are handled by the orchestrator at runtime
 * rather than being real flow states. These are exempt from reachability
 * analysis and transition-target validation.
 */
export const VIRTUAL_SINKS = new Set(["hitl", "no_items"]);

/**
 * Variables that are substituted at runtime by the orchestrator rather than
 * at flow-load time. These are allowed to remain as `${var}` patterns in
 * spawn instructions after fragment param substitution.
 */
export const RUNTIME_VARIABLES = new Set([
  // Core orchestrator variables
  "WORKSPACE",
  "task",
  "slug",
  "task_id",
  "base_commit",
  "CLAUDE_PLUGIN_ROOT",
  // Session branch variables (injected by enterAndPrepareState from execution row)
  "branch",
  "worktree_branch",
  "worktree_path",
  // Progress and review
  "wave_briefing",
  "progress",
  "review_scope",
  // Wave-level variables
  "wave",
  "wave_plans",
  "wave_summaries",
  "wave_files",
  "wave_diff",
  "all_summaries",
  // Parallel-per iteration variables
  "item.principle_id",
  "item.severity",
  "item.file_path",
  "item.detail",
  "item.test_file",
  "item.test_name",
  "item.error_message",
  "item.source_file",
  // Role variable (used in parallel state spawn instructions)
  "role",
  // Consultation open questions
  "open_questions",
  // Adopt flow runtime variables
  "directory",
  "severity_filter",
  "top_n",
  // Verify flow variables
  "user_write_tests",
  "write_tests",
  // Context enrichment (implementor and reviewer only — selective exposure)
  "enrichment",
]);

// ---------------------------------------------------------------------------
// validateSpawnCoverage
// ---------------------------------------------------------------------------

/**
 * Check that every non-terminal state has a matching key in flow.spawn_instructions.
 * Terminal states are exempt — they don't need spawn instructions.
 *
 * Returns an array of error messages (empty if valid).
 */
export function validateSpawnCoverage(flow: ResolvedFlow): string[] {
  const errors: string[] = [];
  for (const [stateId, stateDef] of Object.entries(flow.states)) {
    if (stateDef.type === "terminal") continue;
    if (!flow.spawn_instructions[stateId]) {
      errors.push(`State "${stateId}" (type: ${stateDef.type}) has no spawn instruction heading`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// analyzeReachability
// ---------------------------------------------------------------------------

/**
 * BFS from the entry state to find all reachable states.
 * Virtual sinks (hitl, no_items) are skipped — they are not real states.
 *
 * Returns an array of warning messages for unreachable states (empty if all reachable).
 * These are warnings only — they do NOT block flow loading per ADR-004.
 */
export function analyzeReachability(flow: ResolvedFlow): string[] {
  const warnings: string[] = [];
  const visited = new Set<string>();
  const queue = [flow.entry];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const state = flow.states[current];
    if (state?.transitions) {
      for (const target of Object.values(state.transitions)) {
        if (!VIRTUAL_SINKS.has(target) && !visited.has(target)) {
          queue.push(target);
        }
      }
    }
  }

  for (const stateId of Object.keys(flow.states)) {
    if (!visited.has(stateId)) {
      warnings.push(`Warning: state "${stateId}" is unreachable from entry "${flow.entry}"`);
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// checkUnresolvedRefs
// ---------------------------------------------------------------------------

/**
 * After fragment param substitution, check for remaining `${...}` patterns
 * in spawn instructions and transition targets that are not known runtime variables.
 *
 * Only checks spawn instructions and transition target values.
 * Does NOT check flow-level YAML fields (e.g. progress, description) which may
 * legitimately contain `${WORKSPACE}` and similar patterns.
 *
 * Returns an array of error messages (empty if valid).
 */
export function checkUnresolvedRefs(flow: ResolvedFlow): string[] {
  const errors: string[] = [];
  const refPattern = /\$\{([^}]+)\}/g;

  // Check spawn instructions for unknown ${...} references
  for (const [stateId, text] of Object.entries(flow.spawn_instructions)) {
    refPattern.lastIndex = 0;
    let match;
    while ((match = refPattern.exec(text)) !== null) {
      if (!RUNTIME_VARIABLES.has(match[1])) {
        errors.push(`Spawn instruction "${stateId}" has unresolved reference: \${${match[1]}}`);
      }
    }
  }

  // Check state transition targets for leftover ${...}
  for (const [stateId, stateDef] of Object.entries(flow.states)) {
    if (stateDef.transitions) {
      for (const [cond, target] of Object.entries(stateDef.transitions)) {
        if (/\$\{/.test(target)) {
          errors.push(
            `State "${stateId}" transition "${cond}" has unresolved reference in target: "${target}"`,
          );
        }
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// validateStateIdParams
// ---------------------------------------------------------------------------

/**
 * Validate that fragment params declared as `type: "state_id"` have values
 * that exist in the resolved state map. "hitl" is a virtual target and is
 * always valid.
 *
 * Returns an array of error messages (empty if valid).
 */
export function validateStateIdParams(
  fragments: Array<{ definition: FragmentDefinition; spawnInstructions: Record<string, string> }>,
  includes: FragmentInclude[],
  resolvedStateIds: Set<string>,
): string[] {
  const errors: string[] = [];
  for (const include of includes) {
    const frag = fragments.find((f) => f.definition.fragment === include.fragment);
    if (!frag?.definition.params) continue;
    const withParams = include.with ?? {};
    for (const [paramName, paramDef] of Object.entries(frag.definition.params)) {
      if (isTypedParam(paramDef) && paramDef.type === "state_id") {
        const value = paramName in withParams ? withParams[paramName] : paramDef.default;
        if (typeof value === "string" && value !== "hitl" && !resolvedStateIds.has(value)) {
          errors.push(
            `Fragment "${include.fragment}" param "${paramName}" is state_id but "${value}" is not a valid state`,
          );
        }
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// validateFlow
// ---------------------------------------------------------------------------

/**
 * Validate a resolved flow definition. Returns an array of error messages
 * and warnings (empty if valid).
 *
 * Includes four validation passes:
 *   1. Structural checks (entry, transitions, max_iterations, parallel-per, terminal)
 *   2. Spawn instruction coverage (ADR-004)
 *   3. Reachability analysis — WARN only, does not block (ADR-004)
 *   4. Unresolved reference check (ADR-004)
 */
export function validateFlow(flow: ResolvedFlow): string[] {
  const errors: string[] = [];
  const stateIds = new Set(Object.keys(flow.states));

  // Entry state must exist
  if (!stateIds.has(flow.entry)) {
    errors.push(`Entry state "${flow.entry}" does not exist in states`);
  }

  for (const [stateId, stateDef] of Object.entries(flow.states)) {
    // All transition targets must exist (or be a virtual sink)
    if (stateDef.transitions) {
      for (const [condition, target] of Object.entries(stateDef.transitions)) {
        if (!VIRTUAL_SINKS.has(target) && !stateIds.has(target)) {
          errors.push(`State "${stateId}" transition "${condition}" targets non-existent state "${target}"`);
        }
      }
    }

    // States with max_iterations should have stuck_when
    if (stateDef.max_iterations !== undefined && !stateDef.stuck_when) {
      errors.push(`State "${stateId}" has max_iterations but no stuck_when`);
    }

    // parallel-per states should have iterate_on
    if (stateDef.type === "parallel-per" && !stateDef.iterate_on) {
      errors.push(`State "${stateId}" is parallel-per but has no iterate_on`);
    }

    // terminal states should not have transitions
    if (stateDef.type === "terminal" && stateDef.transitions) {
      errors.push(`State "${stateId}" is terminal but has transitions`);
    }
  }

  // ADR-004 pass 2: spawn instruction coverage (hard errors)
  errors.push(...validateSpawnCoverage(flow));

  // ADR-004 pass 3: reachability analysis (warnings only — do not block)
  const reachabilityWarnings = analyzeReachability(flow);
  if (reachabilityWarnings.length > 0) {
    // Log to console — reachability issues are visible but non-blocking
    for (const warning of reachabilityWarnings) {
      console.warn(`[flow-parser] ${warning}`);
    }
    // Include in output so callers can see them (but loadAndResolveFlow
    // separates warnings from errors by the "Warning:" prefix)
    errors.push(...reachabilityWarnings);
  }

  // ADR-004 pass 4: unresolved reference check (hard errors)
  errors.push(...checkUnresolvedRefs(flow));

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
 * Resolve a flow file using two-tier lookup:
 * 1. Check `${projectDir}/.canon/flows/${flowName}.md` first (if projectDir provided)
 * 2. Fall back to `${pluginDir}/flows/${flowName}.md`
 * Throws a descriptive error listing available flows if neither exists.
 */
async function resolveFlowFile(pluginDir: string, flowName: string, projectDir?: string): Promise<string> {
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
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const flowsDir = `${pluginDir}/flows`;
      let available: string[] = [];
      try {
        const entries = await readdir(flowsDir);
        available = entries
          .filter(
            (e) =>
              e.endsWith(".md") && !e.startsWith(".") && e !== "README.md" && e !== "SCHEMA.md" && e !== "GATES.md",
          )
          .map((e) => e.replace(/\.md$/, ""))
          .sort();
      } catch {
        /* flows dir missing — leave empty */
      }
      // Also include project-level flows in the available list if projectDir given
      if (projectDir) {
        const projectFlowsDir = `${projectDir}/.canon/flows`;
        try {
          const projectEntries = await readdir(projectFlowsDir);
          const projectFlows = projectEntries
            .filter(
              (e) =>
                e.endsWith(".md") && !e.startsWith(".") && e !== "README.md" && e !== "SCHEMA.md" && e !== "GATES.md",
            )
            .map((e) => e.replace(/\.md$/, ""))
            .sort();
          available = [...new Set([...available, ...projectFlows])].sort();
        } catch {
          /* project flows dir missing — leave empty */
        }
      }
      const list = available.length > 0 ? `: ${available.join(", ")}` : "";
      throw new Error(
        `Flow "${flowName}" not found (checked ${projectDir ? `${projectDir}/.canon/flows/ and ` : ""}${pluginPath}). Available flows${list}`,
      );
    }
    throw err;
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
  let fragmentEntry: string | undefined;
  let loadedFragments: Array<{ definition: FragmentDefinition; spawnInstructions: Record<string, string> }> = [];

  // If includes exist, load all fragments and resolve
  if (flowDef.includes && flowDef.includes.length > 0) {
    // Load all unique fragments — project dir first, then plugin dir
    const fragmentNames = [...new Set(flowDef.includes.map((i) => i.fragment))];
    loadedFragments = await Promise.all(fragmentNames.map((name) => loadFragment(pluginDir, name, projectDir)));

    const resolved = resolveFragments(flowDef, loadedFragments, flowDef.includes);

    // Merge fragment states with flow states (flow states take precedence)
    resolvedStates = { ...resolved.states, ...inlineStates };
    resolvedConsultations = resolved.consultations;
    resolvedSpawnInstructions = { ...resolved.spawnInstructions, ...spawnInstructions };
    fragmentEntry = resolved.firstFragmentEntry;
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

  // Validate state_id params against resolved state map
  const resolvedStateIds = new Set(Object.keys(resolvedStates));
  const stateIdParamErrors =
    loadedFragments.length > 0 && flowDef.includes
      ? validateStateIdParams(loadedFragments, flowDef.includes, resolvedStateIds)
      : [];

  // Determine entry: explicit flow entry, first inline state, or first fragment's entry
  const entry = flowDef.entry ?? Object.keys(inlineStates)[0] ?? fragmentEntry;
  if (!entry) {
    throw new Error(
      `Flow "${flowName}" has no entry state — set entry: in frontmatter or include a fragment with an entry`,
    );
  }

  const resolvedFlow: ResolvedFlow = {
    ...flowDef,
    entry,
    states: validatedStates,
    spawn_instructions: resolvedSpawnInstructions,
    ...(Object.keys(resolvedConsultations).length > 0 ? { consultations: resolvedConsultations } : {}),
  };

  // Hard-blocking validation (ADR-004): separate hard errors from reachability warnings.
  // Reachability warnings start with "Warning:" and are non-blocking (already logged to
  // console.warn inside validateFlow). All other messages are hard errors that block loading.
  const allMessages = [...schemaErrors, ...stateIdParamErrors, ...validateFlow(resolvedFlow)];
  const hardErrors = allMessages.filter((msg) => !msg.startsWith("Warning:"));

  if (hardErrors.length > 0) {
    throw new Error(`Flow "${flowName}" validation failed:\n${hardErrors.join("\n")}`);
  }

  return resolvedFlow;
}
