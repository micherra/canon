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
} from "./flow-definition-schemas.ts";

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

/**
 * Type guard: returns true if value is a typed param object ({ type, default? }).
 * Distinguishes new-format typed params from old-format scalar/null values.
 */
function isTypedParam(v: unknown): v is TypedParam {
  return v !== null && typeof v === "object" && "type" in v;
}

/** Check if a param is required (no default) and not provided. */
function isParamMissing(
  paramName: string,
  paramDef: unknown,
  withParams: Record<string, unknown>,
): boolean {
  if (paramName in withParams) return false;
  if (isTypedParam(paramDef)) return paramDef.default === undefined;
  return paramDef === null || paramDef === undefined;
}

/** Extract the default value for a single param definition. */
function getParamDefault(paramDef: unknown): (string | number | boolean) | undefined {
  if (isTypedParam(paramDef)) {
    return paramDef.default as string | number | boolean | undefined;
  }
  // Old format: non-null scalar is a default value (includes false)
  if (paramDef !== null && paramDef !== undefined) {
    return paramDef as string | number | boolean;
  }
  return undefined;
}

/** Validate required params and build the effective params map (defaults + overrides). */
function buildEffectiveParams(
  definition: FragmentDefinition,
  include: FragmentInclude,
): Record<string, string | number | boolean> {
  const withParams = include.with ?? {};

  // Validate required params
  if (definition.params) {
    for (const [paramName, paramDef] of Object.entries(definition.params)) {
      if (isParamMissing(paramName, paramDef, withParams)) {
        throw new Error(
          `Fragment "${include.fragment}" requires param "${paramName}" but it was not provided`,
        );
      }
    }
  }

  // Build effective params: defaults then with overrides
  const defaults: Record<string, string | number | boolean> = {};
  for (const [paramName, paramDef] of Object.entries(definition.params ?? {})) {
    const defaultVal = getParamDefault(paramDef);
    if (defaultVal !== undefined) {
      defaults[paramName] = defaultVal;
    }
  }

  return {
    ...defaults,
    ...(include.with ?? {}),
  } as Record<string, string | number | boolean>;
}

type ResolveConsultationOpts = {
  effectiveParams: Record<string, string | number | boolean>;
  spawnInstructions: Record<string, string>;
  consultations: Record<string, ConsultationFragment>;
  mergedSpawnInstructions: Record<string, string>;
};

/** Resolve a consultation-type fragment into the consultations and spawn instructions maps. */
function resolveConsultationFragment(
  definition: FragmentDefinition,
  include: FragmentInclude,
  opts: ResolveConsultationOpts,
): void {
  const { effectiveParams, spawnInstructions, consultations, mergedSpawnInstructions } = opts;
  const consultation: ConsultationFragment = {
    agent: definition.agent!,
    artifact: definition.artifact,
    description: definition.description,
    fragment: definition.fragment,
    min_waves: definition.min_waves,
    role: definition.role!,
    section: definition.section,
    timeout: definition.timeout,
    ...(definition.skip_when !== undefined ? { skip_when: definition.skip_when } : {}),
  };

  const hasParams = Object.keys(effectiveParams).length > 0;
  const substituted = hasParams ? substituteParams(consultation, effectiveParams) : consultation;
  const consultName = include.as ?? definition.fragment;
  consultations[consultName] = substituted;

  mergeSpawnInstructions(definition, include, {
    effectiveParams,
    mergedSpawnInstructions,
    spawnInstructions,
  });
}

/** Apply overrides to fragment states. */
function applyStateOverrides(
  states: Record<string, unknown>,
  overrides: Record<string, unknown>,
): void {
  for (const [stateId, overrideFields] of Object.entries(overrides)) {
    if (states[stateId]) {
      states[stateId] = {
        ...(states[stateId] as object),
        ...(overrideFields as object),
      } as StateDefinition;
    }
  }
}

/** Rename states when `as:` is used (single-state fragments only). */
function applyAsRename(
  states: Record<string, unknown>,
  alias: string,
  fragmentName: string,
): Record<string, unknown> {
  const stateEntries = Object.entries(states);
  if (stateEntries.length !== 1) {
    throw new Error(
      `Fragment "${fragmentName}" has ${stateEntries.length} states but "as:" only works with single-state fragments`,
    );
  }
  return { [alias]: stateEntries[0][1] };
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
  let states = hasParams
    ? substituteParams(definition.states, effectiveParams)
    : { ...definition.states };

  if (include.overrides) applyStateOverrides(states, include.overrides);
  if (include.as) states = applyAsRename(states, include.as, include.fragment) as typeof states;

  for (const [stateId, stateDef] of Object.entries(states)) {
    if (mergedStates[stateId]) {
      throw new Error(`State ID collision: "${stateId}" already exists`);
    }
    mergedStates[stateId] = stateDef as StateDefinition;
  }
}

type MergeSpawnOpts = {
  effectiveParams: Record<string, string | number | boolean>;
  spawnInstructions: Record<string, string>;
  mergedSpawnInstructions: Record<string, string>;
};

/** Merge spawn instructions from a fragment, applying param substitution and renaming. */
function mergeSpawnInstructions(
  definition: FragmentDefinition,
  include: FragmentInclude,
  opts: MergeSpawnOpts,
): void {
  const { effectiveParams, spawnInstructions, mergedSpawnInstructions } = opts;
  const hasParams = Object.keys(effectiveParams).length > 0;
  const fragSpawn = hasParams
    ? substituteSpawnInstructions(spawnInstructions, effectiveParams)
    : { ...spawnInstructions };

  for (const [sId, sText] of Object.entries(fragSpawn)) {
    const spawnKey = include.as ? sId.replace(definition.fragment, include.as) : sId;
    mergedSpawnInstructions[spawnKey] = sText;
  }
}

// VIRTUAL_SINKS / RUNTIME_VARIABLES constants

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

// validateSpawnCoverage

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

// analyzeReachability

/**
 * BFS from the entry state to find all reachable states.
 * Virtual sinks (hitl, no_items) are skipped — they are not real states.
 *
 * Returns an array of warning messages for unreachable states (empty if all reachable).
 * These are warnings only — they do NOT block flow loading per ADR-004.
 */
/** BFS from entry to collect all reachable state IDs. */
export function collectReachableStates(flow: ResolvedFlow): Set<string> {
  const visited = new Set<string>();
  const queue = [flow.entry];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);
    const state = flow.states[current];
    if (!state?.transitions) continue;
    for (const target of Object.values(state.transitions)) {
      if (!VIRTUAL_SINKS.has(target) && !visited.has(target)) {
        queue.push(target);
      }
    }
  }
  return visited;
}

export function analyzeReachability(flow: ResolvedFlow): string[] {
  const visited = collectReachableStates(flow);
  const warnings: string[] = [];
  for (const stateId of Object.keys(flow.states)) {
    if (!visited.has(stateId)) {
      warnings.push(`Warning: state "${stateId}" is unreachable from entry "${flow.entry}"`);
    }
  }
  warnings.push(...detectDeadEnds(flow));
  warnings.push(...detectStuckLoops(flow));
  return warnings;
}

// checkUnresolvedRefs

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
/** Check spawn instructions for unknown ${...} references. */
function checkSpawnInstructionRefs(spawnInstructions: Record<string, string>): string[] {
  const errors: string[] = [];
  const refPattern = /\$\{([^}]+)\}/g;
  for (const [stateId, text] of Object.entries(spawnInstructions)) {
    refPattern.lastIndex = 0;
    let match = refPattern.exec(text);
    while (match !== null) {
      if (!RUNTIME_VARIABLES.has(match[1])) {
        errors.push(`Spawn instruction "${stateId}" has unresolved reference: \${${match[1]}}`);
      }
      match = refPattern.exec(text);
    }
  }
  return errors;
}

/** Check state transition targets for leftover ${...} patterns. */
function checkTransitionTargetRefs(states: Record<string, StateDefinition>): string[] {
  const errors: string[] = [];
  for (const [stateId, stateDef] of Object.entries(states)) {
    if (!stateDef.transitions) continue;
    for (const [cond, target] of Object.entries(stateDef.transitions)) {
      if (/\$\{/.test(target)) {
        errors.push(
          `State "${stateId}" transition "${cond}" has unresolved reference in target: "${target}"`,
        );
      }
    }
  }
  return errors;
}

export function checkUnresolvedRefs(flow: ResolvedFlow): string[] {
  return [
    ...checkSpawnInstructionRefs(flow.spawn_instructions),
    ...checkTransitionTargetRefs(flow.states),
  ];
}

// validateStateIdParams

/**
 * Validate that fragment params declared as `type: "state_id"` have values
 * that exist in the resolved state map. "hitl" is a virtual target and is
 * always valid.
 *
 * Returns an array of error messages (empty if valid).
 */
/** Validate a single include's state_id params against resolved state IDs. */
function validateIncludeStateIdParams(
  include: FragmentInclude,
  params: Record<string, unknown>,
  resolvedStateIds: Set<string>,
): string[] {
  const errors: string[] = [];
  const withParams = include.with ?? {};
  for (const [paramName, paramDef] of Object.entries(params)) {
    if (!isTypedParam(paramDef) || paramDef.type !== "state_id") continue;
    const value = paramName in withParams ? withParams[paramName] : paramDef.default;
    if (typeof value === "string" && value !== "hitl" && !resolvedStateIds.has(value)) {
      errors.push(
        `Fragment "${include.fragment}" param "${paramName}" is state_id but "${value}" is not a valid state`,
      );
    }
  }
  return errors;
}

export function validateStateIdParams(
  fragments: Array<{ definition: FragmentDefinition; spawnInstructions: Record<string, string> }>,
  includes: FragmentInclude[],
  resolvedStateIds: Set<string>,
): string[] {
  const errors: string[] = [];
  for (const include of includes) {
    const frag = fragments.find((f) => f.definition.fragment === include.fragment);
    if (!frag?.definition.params) continue;
    errors.push(...validateIncludeStateIdParams(include, frag.definition.params, resolvedStateIds));
  }
  return errors;
}

// validateFlow

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
/** Validate that all transition targets reference existing states or virtual sinks. */
function validateTransitionTargets(
  stateId: string,
  transitions: Record<string, string>,
  stateIds: Set<string>,
): string[] {
  const errors: string[] = [];
  for (const [condition, target] of Object.entries(transitions)) {
    if (!VIRTUAL_SINKS.has(target) && !stateIds.has(target)) {
      errors.push(
        `State "${stateId}" transition "${condition}" targets non-existent state "${target}"`,
      );
    }
  }
  return errors;
}

/** Validate structural properties of individual states. */
function validateStateStructure(
  stateId: string,
  stateDef: StateDefinition,
  stateIds: Set<string>,
): string[] {
  const errors: string[] = [];
  if (stateDef.transitions) {
    errors.push(...validateTransitionTargets(stateId, stateDef.transitions, stateIds));
  }
  if (stateDef.max_iterations !== undefined && !stateDef.stuck_when) {
    errors.push(`State "${stateId}" has max_iterations but no stuck_when`);
  }
  if (stateDef.type === "parallel-per" && !stateDef.iterate_on) {
    errors.push(`State "${stateId}" is parallel-per but has no iterate_on`);
  }
  if (stateDef.type === "terminal" && stateDef.transitions) {
    errors.push(`State "${stateId}" is terminal but has transitions`);
  }
  return errors;
}

export function validateFlow(flow: ResolvedFlow): string[] {
  const errors: string[] = [];
  const stateIds = new Set(Object.keys(flow.states));

  if (!stateIds.has(flow.entry)) {
    errors.push(`Entry state "${flow.entry}" does not exist in states`);
  }

  for (const [stateId, stateDef] of Object.entries(flow.states)) {
    errors.push(...validateStateStructure(stateId, stateDef, stateIds));
  }

  errors.push(...validateSpawnCoverage(flow));

  const reachabilityWarnings = analyzeReachability(flow);
  for (const warning of reachabilityWarnings) {
    console.warn(`[flow-parser] ${warning}`);
  }
  errors.push(...reachabilityWarnings);
  errors.push(...checkUnresolvedRefs(flow));

  return errors;
}

// buildStateGraph

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

// buildReverseGraph / detectDeadEnds / detectStuckLoops

/**
 * Invert an adjacency list: for each a -> b edge, add b -> a in the reverse graph.
 * All source keys from the input graph appear as keys in the result (even with no
 * incoming edges), so callers can iterate the same key set.
 */
export function buildReverseGraph(graph: Record<string, string[]>): Record<string, string[]> {
  const reversed: Record<string, string[]> = {};
  // Seed all keys with empty arrays
  for (const key of Object.keys(graph)) {
    reversed[key] = [];
  }
  // For each a -> b edge, add a as an incoming neighbor of b
  for (const [source, targets] of Object.entries(graph)) {
    for (const target of targets) {
      if (!reversed[target]) {
        reversed[target] = [];
      }
      reversed[target].push(source);
    }
  }
  return reversed;
}

/**
 * Detect dead-end states: forward-reachable from entry but with no path to any
 * terminal or virtual-sink (hitl / no_items).
 *
 * Algorithm: reverse-BFS from the seed set (terminals ∪ hitl-adjacent states).
 * Any forward-reachable state not in the reverse-BFS result is a dead-end.
 *
 * Returns Warning-prefixed strings, one per dead-end state.
 */
export function detectDeadEnds(flow: ResolvedFlow): string[] {
  const forwardGraph = buildStateGraph(flow);
  const reverseGraph = buildReverseGraph(forwardGraph);

  // Collect terminal states and hitl-adjacent states as seed for reverse BFS
  const seed = new Set<string>();
  for (const [stateId, stateDef] of Object.entries(flow.states)) {
    if (stateDef.type === "terminal") {
      seed.add(stateId);
      continue;
    }
    if (stateDef.transitions) {
      for (const target of Object.values(stateDef.transitions)) {
        if (VIRTUAL_SINKS.has(target)) {
          seed.add(stateId);
          break;
        }
      }
    }
  }

  // Reverse BFS: find all states that can reach the seed set
  const canReachTerminal = new Set<string>(seed);
  const queue = [...seed];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const predecessors = reverseGraph[current] ?? [];
    for (const pred of predecessors) {
      if (!canReachTerminal.has(pred)) {
        canReachTerminal.add(pred);
        queue.push(pred);
      }
    }
  }

  // Forward-reachable states (only real flow states, not virtual sinks)
  const forwardReachable = collectReachableStates(flow);
  const flowStateIds = new Set(Object.keys(flow.states));
  const realForwardReachable = new Set([...forwardReachable].filter((s) => flowStateIds.has(s)));

  // Dead-ends = forward-reachable real states NOT in canReachTerminal AND NOT terminal
  const warnings: string[] = [];
  for (const stateId of realForwardReachable) {
    const stateDef = flow.states[stateId];
    if (stateDef?.type === "terminal") continue;
    if (!canReachTerminal.has(stateId)) {
      warnings.push(
        `Warning: state "${stateId}" is a dead-end — reachable from entry but no path to terminal or hitl`,
      );
    }
  }
  return warnings;
}

/**
 * Find all strongly connected components (SCCs) using iterative Tarjan's algorithm.
 * Returns an array of SCCs, each represented as an array of state IDs.
 */
function findSCCs(graph: Record<string, string[]>): string[][] {
  const nodes = Object.keys(graph);
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Map<string, boolean>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  let counter = 0;

  // Iterative Tarjan's using an explicit call stack
  for (const startNode of nodes) {
    if (index.has(startNode)) continue;

    // Each entry: [node, neighborIndex, isFirstVisit]
    const callStack: Array<{ node: string; neighborIdx: number }> = [
      { node: startNode, neighborIdx: 0 },
    ];

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      const { node } = frame;

      if (!index.has(node)) {
        // First visit: initialize
        index.set(node, counter);
        lowlink.set(node, counter);
        counter++;
        onStack.set(node, true);
        stack.push(node);
      }

      const neighbors = graph[node] ?? [];
      let advanced = false;

      while (frame.neighborIdx < neighbors.length) {
        const neighbor = neighbors[frame.neighborIdx];
        frame.neighborIdx++;

        if (!index.has(neighbor)) {
          // Tree edge: recurse
          callStack.push({ node: neighbor, neighborIdx: 0 });
          advanced = true;
          break;
        } else if (onStack.get(neighbor)) {
          // Back edge: update lowlink
          const nl = lowlink.get(node)!;
          const ni = index.get(neighbor)!;
          if (ni < nl) lowlink.set(node, ni);
        }
      }

      if (!advanced) {
        // All neighbors processed: check if root of SCC
        callStack.pop();
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1].node;
          const pl = lowlink.get(parent)!;
          const nl = lowlink.get(node)!;
          if (nl < pl) lowlink.set(parent, nl);
        }

        if (lowlink.get(node) === index.get(node)) {
          // Pop SCC
          const scc: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.set(w, false);
            scc.push(w);
          } while (w !== node);
          sccs.push(scc);
        }
      }
    }
  }

  return sccs;
}

/**
 * Detect stuck loops: cycles (SCCs with 2+ members) where no member can exit
 * to a terminal-reachable state or virtual sink.
 *
 * Returns Warning-prefixed strings, one per stuck loop.
 */
export function detectStuckLoops(flow: ResolvedFlow): string[] {
  const forwardGraph = buildStateGraph(flow);

  // Compute the can-reach-terminal set (same as in detectDeadEnds)
  const reverseGraph = buildReverseGraph(forwardGraph);
  const seed = new Set<string>();
  for (const [stateId, stateDef] of Object.entries(flow.states)) {
    if (stateDef.type === "terminal") {
      seed.add(stateId);
      continue;
    }
    if (stateDef.transitions) {
      for (const target of Object.values(stateDef.transitions)) {
        if (VIRTUAL_SINKS.has(target)) {
          seed.add(stateId);
          break;
        }
      }
    }
  }
  const canReachTerminal = new Set<string>(seed);
  const queue = [...seed];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const pred of reverseGraph[current] ?? []) {
      if (!canReachTerminal.has(pred)) {
        canReachTerminal.add(pred);
        queue.push(pred);
      }
    }
  }

  const sccs = findSCCs(forwardGraph);
  const warnings: string[] = [];

  for (const scc of sccs) {
    // Only analyze multi-member SCCs
    if (scc.length < 2) continue;

    // Check if any member exits the SCC to a terminal-reachable state or virtual sink
    const sccSet = new Set(scc);
    let hasExit = false;

    for (const member of scc) {
      const neighbors = forwardGraph[member] ?? [];
      for (const neighbor of neighbors) {
        if (!sccSet.has(neighbor)) {
          // Exits the SCC — check if neighbor can reach terminal or is a virtual sink
          if (canReachTerminal.has(neighbor) || VIRTUAL_SINKS.has(neighbor)) {
            hasExit = true;
            break;
          }
        }
      }
      if (hasExit) break;
    }

    if (!hasExit) {
      const ids = [...scc].sort().join(", ");
      warnings.push(
        `Warning: states [${ids}] form a stuck loop — cycle with no exit to terminal or hitl`,
      );
    }
  }

  return warnings;
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
