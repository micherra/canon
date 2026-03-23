import { loadAndResolveFlow, buildStateGraph } from "../orchestration/flow-parser.js";
import { readdir } from "fs/promises";
import { resolve } from "path";
import type { ResolvedFlow } from "../orchestration/flow-schema.js";

export interface ValidateFlowsInput {
  flow_name?: string;
}

export interface FlowValidation {
  name: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  state_count: number;
  fragment_count: number;
  state_graph: Record<string, string[]>;
}

export interface ValidateFlowsResult {
  flows: FlowValidation[];
  summary: { total: number; valid: number; invalid: number };
}

/**
 * BFS from entry state to find all reachable states.
 */
function findReachableStates(
  entry: string,
  graph: Record<string, string[]>,
): Set<string> {
  const visited = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current)) continue;
    visited.add(current);

    const targets = graph[current] ?? [];
    for (const target of targets) {
      if (!visited.has(target)) {
        queue.push(target);
      }
    }
  }

  return visited;
}

/**
 * Check whether any terminal state is reachable from the entry.
 */
function hasReachableTerminal(
  flow: ResolvedFlow,
  reachable: Set<string>,
): boolean {
  for (const stateId of reachable) {
    const stateDef = flow.states[stateId];
    if (stateDef && stateDef.type === "terminal") {
      return true;
    }
  }
  return false;
}

async function validateSingleFlow(
  pluginDir: string,
  flowName: string,
): Promise<FlowValidation> {
  try {
    const { flow, errors } = await loadAndResolveFlow(pluginDir, flowName);
    const state_graph = buildStateGraph(flow);
    const warnings: string[] = [];

    // Count fragments
    const fragment_count = flow.includes?.length ?? 0;

    // Orphan detection: BFS from entry, find unreachable states
    const reachable = findReachableStates(flow.entry, state_graph);
    const allStates = Object.keys(flow.states);
    for (const stateId of allStates) {
      if (!reachable.has(stateId)) {
        warnings.push(`Orphan state "${stateId}" is not reachable from entry "${flow.entry}"`);
      }
    }

    // Check if a terminal state is reachable
    if (!hasReachableTerminal(flow, reachable)) {
      warnings.push("No terminal state is reachable from entry");
    }

    return {
      name: flowName,
      valid: errors.length === 0,
      errors,
      warnings,
      state_count: allStates.length,
      fragment_count,
      state_graph,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name: flowName,
      valid: false,
      errors: [message],
      warnings: [],
      state_count: 0,
      fragment_count: 0,
      state_graph: {},
    };
  }
}

export async function validateFlows(
  input: ValidateFlowsInput,
  pluginDir: string,
): Promise<ValidateFlowsResult> {
  let flowNames: string[];

  if (input.flow_name) {
    flowNames = [input.flow_name];
  } else {
    const flowsDir = resolve(pluginDir, "flows");
    const entries = await readdir(flowsDir, { withFileTypes: true });
    const excluded = new Set(["SCHEMA.md", "CLAUDE.md"]);

    flowNames = entries
      .filter(
        (e) =>
          e.isFile() &&
          e.name.endsWith(".md") &&
          !excluded.has(e.name),
      )
      .map((e) => e.name.replace(/\.md$/, ""));
  }

  const flows = await Promise.all(
    flowNames.map((name) => validateSingleFlow(pluginDir, name)),
  );

  const valid = flows.filter((f) => f.valid).length;

  return {
    flows,
    summary: {
      total: flows.length,
      valid,
      invalid: flows.length - valid,
    },
  };
}
