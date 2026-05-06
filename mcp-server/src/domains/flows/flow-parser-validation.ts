/**
 * Flow validation and reachability analysis.
 *
 * Validates a resolved flow definition for structural correctness, spawn
 * instruction coverage, reachability, and unresolved reference checks.
 * Also provides graph utilities (buildStateGraph, detectDeadEnds, detectStuckLoops).
 */

import type {
  FragmentDefinition,
  FragmentInclude,
  ResolvedFlow,
  StateDefinition,
} from "./flow-definition-schemas.ts";
import { isTypedParam } from "./flow-parser-fragments.ts";

// ---------------------------------------------------------------------------
// Constants
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
  // Session branch variables (injected from execution row)
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
  // Context injection: design handoff summary for downstream states
  "design_handoff",
]);

// ---------------------------------------------------------------------------
// Graph utilities
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

// ---------------------------------------------------------------------------
// Spawn coverage validation
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
    // Gate-only states (no agent) don't need spawn instructions — they run gates deterministically
    if (stateDef.type === "single" && !stateDef.agent) continue;
    if (!flow.spawn_instructions[stateId]) {
      errors.push(`State "${stateId}" (type: ${stateDef.type}) has no spawn instruction heading`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Reachability analysis
// ---------------------------------------------------------------------------

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

/** Collect seed states: terminals + states with transitions to virtual sinks. */
function collectTerminalSeeds(flow: ResolvedFlow): Set<string> {
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
  return seed;
}

/** Reverse BFS from seed set through reverse graph. Returns all states that can reach the seed. */
function computeCanReachTerminal(
  seed: Set<string>,
  reverseGraph: Record<string, string[]>,
): Set<string> {
  const canReach = new Set<string>(seed);
  const queue = [...seed];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const pred of reverseGraph[current] ?? []) {
      if (!canReach.has(pred)) {
        canReach.add(pred);
        queue.push(pred);
      }
    }
  }
  return canReach;
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
  const seed = collectTerminalSeeds(flow);
  const canReachTerminal = computeCanReachTerminal(seed, reverseGraph);

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

// ---------------------------------------------------------------------------
// Tarjan's SCC algorithm (iterative)
// ---------------------------------------------------------------------------

/** State for Tarjan's SCC algorithm. */
type TarjanState = {
  index: Map<string, number>;
  lowlink: Map<string, number>;
  onStack: Map<string, boolean>;
  stack: string[];
  sccs: string[][];
  counter: number;
};

/** Initialize a node on first visit in the Tarjan traversal. */
function initTarjanNode(node: string, state: TarjanState): void {
  state.index.set(node, state.counter);
  state.lowlink.set(node, state.counter);
  state.counter++;
  state.onStack.set(node, true);
  state.stack.push(node);
}

/** Process neighbors for a single Tarjan frame. Returns true if it pushed a new frame (advanced). */
function processNeighbors(
  frame: { node: string; neighborIdx: number },
  graph: Record<string, string[]>,
  state: TarjanState,
  callStack: Array<{ node: string; neighborIdx: number }>,
): boolean {
  const neighbors = graph[frame.node] ?? [];
  while (frame.neighborIdx < neighbors.length) {
    const neighbor = neighbors[frame.neighborIdx];
    frame.neighborIdx++;
    if (!state.index.has(neighbor)) {
      callStack.push({ neighborIdx: 0, node: neighbor });
      return true;
    }
    if (state.onStack.get(neighbor)) {
      const nl = state.lowlink.get(frame.node)!;
      const ni = state.index.get(neighbor)!;
      if (ni < nl) state.lowlink.set(frame.node, ni);
    }
  }
  return false;
}

/** Pop an SCC from the stack when a root node is found. */
function popScc(node: string, state: TarjanState): void {
  if (state.lowlink.get(node) !== state.index.get(node)) return;
  const scc: string[] = [];
  let w: string;
  do {
    w = state.stack.pop()!;
    state.onStack.set(w, false);
    scc.push(w);
  } while (w !== node);
  state.sccs.push(scc);
}

/** Propagate lowlink from child to parent after backtracking. */
function propagateLowlink(
  callStack: Array<{ node: string; neighborIdx: number }>,
  node: string,
  state: TarjanState,
): void {
  if (callStack.length > 0) {
    const parent = callStack[callStack.length - 1].node;
    const pl = state.lowlink.get(parent)!;
    const nl = state.lowlink.get(node)!;
    if (nl < pl) state.lowlink.set(parent, nl);
  }
}

/**
 * Find all strongly connected components (SCCs) using iterative Tarjan's algorithm.
 * Returns an array of SCCs, each represented as an array of state IDs.
 */
function findSCCs(graph: Record<string, string[]>): string[][] {
  const state: TarjanState = {
    counter: 0,
    index: new Map(),
    lowlink: new Map(),
    onStack: new Map(),
    sccs: [],
    stack: [],
  };

  for (const startNode of Object.keys(graph)) {
    if (state.index.has(startNode)) continue;

    const callStack = [{ neighborIdx: 0, node: startNode }];
    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      if (!state.index.has(frame.node)) initTarjanNode(frame.node, state);

      if (!processNeighbors(frame, graph, state, callStack)) {
        const { node } = frame;
        callStack.pop();
        propagateLowlink(callStack, node, state);
        popScc(node, state);
      }
    }
  }

  return state.sccs;
}

/** Check if an SCC has any exit edge to a terminal-reachable state or virtual sink. */
function sccHasExit(
  scc: string[],
  forwardGraph: Record<string, string[]>,
  canReachTerminal: Set<string>,
): boolean {
  const sccSet = new Set(scc);
  for (const member of scc) {
    for (const neighbor of forwardGraph[member] ?? []) {
      if (
        !sccSet.has(neighbor) &&
        (canReachTerminal.has(neighbor) || VIRTUAL_SINKS.has(neighbor))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Detect stuck loops: cycles (SCCs with 2+ members) where no member can exit
 * to a terminal-reachable state or virtual sink.
 *
 * Returns Warning-prefixed strings, one per stuck loop.
 */
export function detectStuckLoops(flow: ResolvedFlow): string[] {
  const forwardGraph = buildStateGraph(flow);
  const reverseGraph = buildReverseGraph(forwardGraph);
  const seed = collectTerminalSeeds(flow);
  const canReachTerminal = computeCanReachTerminal(seed, reverseGraph);
  const sccs = findSCCs(forwardGraph);
  const warnings: string[] = [];

  for (const scc of sccs) {
    if (scc.length < 2) continue;
    if (!sccHasExit(scc, forwardGraph, canReachTerminal)) {
      const ids = [...scc].sort().join(", ");
      warnings.push(
        `Warning: states [${ids}] form a stuck loop — cycle with no exit to terminal or hitl`,
      );
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// analyzeReachability (combined)
// ---------------------------------------------------------------------------

/**
 * BFS from the entry state to find all reachable states.
 * Virtual sinks (hitl, no_items) are skipped — they are not real states.
 *
 * Returns an array of warning messages for unreachable states (empty if all reachable).
 * These are warnings only — they do NOT block flow loading per ADR-004.
 */
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

// ---------------------------------------------------------------------------
// Unresolved reference checks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// State ID param validation
// ---------------------------------------------------------------------------

/**
 * Validate that fragment params declared as `type: "state_id"` have values
 * that exist in the resolved state map. "hitl" is a virtual target and is
 * always valid.
 *
 * Returns an array of error messages (empty if valid).
 */
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

// ---------------------------------------------------------------------------
// Structural validation
// ---------------------------------------------------------------------------

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
