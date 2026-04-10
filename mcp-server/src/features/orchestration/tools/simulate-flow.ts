/**
 * simulate-flow.ts — Pure simulation engine and MCP tool wrapper.
 *
 * Walks a Canon flow's state machine deterministically using a provided
 * scenario of (state_id, status) pairs. No agents spawned, no workspace needed.
 */

import type { StateId } from "@domains/flows/board-state-schemas.ts";
import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { loadAndResolveFlow, VIRTUAL_SINKS } from "@domains/flows/flow-parser.ts";
import { type ToolResult, toolError, toolOk } from "@shared/lib/tool-result.ts";
import { evaluateTransition, normalizeStatus } from "../engine/transitions.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SimulateFlowInput = {
  flow: string; // flow name (not a ResolvedFlow object)
  scenario: Array<{
    state_id: string;
    status: string;
  }>;
  max_steps?: number; // default 50
};

export type SimulationPathEntry = {
  state_id: string;
  status_input: string;
  next_state: string;
  transition_matched: string;
};

export type SimulateFlowOutput = {
  ok: boolean; // true when terminal_state is set, false otherwise
  path: SimulationPathEntry[];
  terminal_state?: string;
  stuck_at?: string;
  dead_end_at?: string;
  iterations_consumed: Record<string, number>;
  warnings: string[];
};

// ---------------------------------------------------------------------------
// Pure simulation engine
// ---------------------------------------------------------------------------

/** Build a success result. */
function simOk(
  path: SimulationPathEntry[],
  iterationsConsumed: Record<string, number>,
  warnings: string[],
  terminalState: string,
): SimulateFlowOutput {
  return {
    dead_end_at: undefined,
    iterations_consumed: iterationsConsumed,
    ok: true,
    path,
    stuck_at: undefined,
    terminal_state: terminalState,
    warnings,
  };
}

/** Build a failure result. */
function simFail(
  path: SimulationPathEntry[],
  iterationsConsumed: Record<string, number>,
  warnings: string[],
  opts: { stuck_at?: string; dead_end_at?: string },
): SimulateFlowOutput {
  return {
    dead_end_at: opts.dead_end_at,
    iterations_consumed: iterationsConsumed,
    ok: false,
    path,
    stuck_at: opts.stuck_at,
    terminal_state: undefined,
    warnings,
  };
}

/** Emit warnings for non-single state types and skip_when predicates. */
function emitStateWarnings(
  stateDef: ResolvedFlow["states"][StateId],
  currentState: string,
  warnings: string[],
): void {
  if (
    stateDef.type === "wave" ||
    stateDef.type === "parallel" ||
    stateDef.type === "parallel-per"
  ) {
    warnings.push(`State "${currentState}" is type ${stateDef.type} — simulated as single step`);
  }
  if ("skip_when" in stateDef && stateDef.skip_when !== undefined) {
    warnings.push(`State "${currentState}" has skip_when — predicate not evaluated in simulation`);
  }
}

type SimState = {
  currentState: string;
  scenarioIndex: number;
  path: SimulationPathEntry[];
  iterationsConsumed: Record<string, number>;
  warnings: string[];
};

/** Process one simulation step. Returns a result to exit, or the next state to continue. */
function simulateStep(
  flow: ResolvedFlow,
  scenario: Array<{ state_id: string; status: string }>,
  sim: SimState,
  step: number,
): SimulateFlowOutput | string {
  const { currentState, path, iterationsConsumed, warnings } = sim;
  const stateDef = flow.states[currentState as StateId];

  if (stateDef.type === "terminal") return simOk(path, iterationsConsumed, warnings, currentState);

  emitStateWarnings(stateDef, currentState, warnings);

  if (sim.scenarioIndex >= scenario.length) {
    return simFail(path, iterationsConsumed, warnings, { stuck_at: currentState });
  }

  const entry = scenario[sim.scenarioIndex];
  if (entry.state_id !== currentState) {
    warnings.push(
      `Scenario mismatch at step ${step}: expected "${currentState}", got "${entry.state_id}"`,
    );
    return simFail(path, iterationsConsumed, warnings, { dead_end_at: currentState });
  }

  const normalized = normalizeStatus(entry.status);
  const nextState = evaluateTransition(stateDef, normalized);
  if (nextState === null) {
    return simFail(path, iterationsConsumed, warnings, { dead_end_at: currentState });
  }

  const pathEntry: SimulationPathEntry = {
    next_state: nextState,
    state_id: currentState,
    status_input: entry.status,
    transition_matched: normalized,
  };

  if (VIRTUAL_SINKS.has(nextState)) {
    path.push(pathEntry);
    iterationsConsumed[currentState] = (iterationsConsumed[currentState] ?? 0) + 1;
    return simOk(path, iterationsConsumed, warnings, currentState);
  }

  path.push(pathEntry);
  iterationsConsumed[currentState] = (iterationsConsumed[currentState] ?? 0) + 1;

  const maxIter =
    "max_iterations" in stateDef && stateDef.max_iterations !== undefined
      ? Number(stateDef.max_iterations)
      : undefined;
  if (maxIter !== undefined && iterationsConsumed[currentState] > maxIter) {
    warnings.push(`State "${currentState}" exceeded max_iterations (${maxIter}) — stuck`);
    return simFail(path, iterationsConsumed, warnings, { stuck_at: currentState });
  }

  sim.scenarioIndex++;
  return nextState;
}

/**
 * Simulate a Canon flow execution deterministically using a provided scenario.
 *
 * This is a pure function — it reads the flow definition and scenario list,
 * and returns a structured output describing what happened. It never throws
 * for expected conditions; all error cases are returned as structured output.
 */
export function simulateFlow(
  flow: ResolvedFlow,
  scenario: Array<{ state_id: string; status: string }>,
  maxSteps: number,
): SimulateFlowOutput {
  const sim: SimState = {
    currentState: flow.entry,
    iterationsConsumed: {},
    path: [],
    scenarioIndex: 0,
    warnings: [],
  };

  for (let step = 0; step < maxSteps; step++) {
    const result = simulateStep(flow, scenario, sim, step);
    if (typeof result !== "string") return result;
    sim.currentState = result;
  }

  sim.warnings.push(`Simulation stopped at max_steps (${maxSteps})`);
  return simFail(sim.path, sim.iterationsConsumed, sim.warnings, {
    stuck_at: sim.currentState,
  });
}

// ---------------------------------------------------------------------------
// Tool wrapper
// ---------------------------------------------------------------------------

/**
 * MCP tool wrapper for simulateFlow.
 *
 * Loads the flow by name, then delegates to the pure simulateFlow engine.
 * Returns a ToolResult — the outer ok reflects tool-level success (flow loaded),
 * while the inner SimulateFlowOutput.ok reflects simulation-level success.
 */
export async function simulateFlowTool(
  input: SimulateFlowInput,
  pluginDir: string,
  projectDir?: string,
): Promise<ToolResult<SimulateFlowOutput>> {
  let resolvedFlow: ResolvedFlow;
  try {
    resolvedFlow = await loadAndResolveFlow(pluginDir, input.flow, projectDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = message.includes("not found") ? "FLOW_NOT_FOUND" : "FLOW_PARSE_ERROR";
    return toolError(code, message);
  }

  const result = simulateFlow(resolvedFlow, input.scenario, input.max_steps ?? 50);
  return toolOk(result);
}
