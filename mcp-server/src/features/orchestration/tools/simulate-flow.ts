/**
 * simulate-flow.ts — Pure simulation engine and MCP tool wrapper.
 *
 * Walks a Canon flow's state machine deterministically using a provided
 * scenario of (state_id, status) pairs. No agents spawned, no workspace needed.
 */

import type { ResolvedFlow } from "@domains/flows/flow-definition-schemas.ts";
import { VIRTUAL_SINKS, loadAndResolveFlow } from "@domains/flows/flow-parser.ts";
import { normalizeStatus, evaluateTransition } from "../engine/transitions.ts";
import { type ToolResult, toolOk, toolError } from "@shared/lib/tool-result.ts";

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
  let currentState = flow.entry;
  let scenarioIndex = 0;
  let step = 0;
  const path: SimulationPathEntry[] = [];
  const iterationsConsumed: Record<string, number> = {};
  const warnings: string[] = [];

  while (step < maxSteps) {
    const stateDef = flow.states[currentState];

    // (b) Terminal state — success
    if (stateDef.type === "terminal") {
      return {
        dead_end_at: undefined,
        iterations_consumed: iterationsConsumed,
        ok: true,
        path,
        stuck_at: undefined,
        terminal_state: currentState,
        warnings,
      };
    }

    // (c) Wave / parallel / parallel-per warning
    if (
      stateDef.type === "wave" ||
      stateDef.type === "parallel" ||
      stateDef.type === "parallel-per"
    ) {
      warnings.push(
        `State "${currentState}" is type ${stateDef.type} — simulated as single step`,
      );
    }

    // skip_when warning
    if ("skip_when" in stateDef && stateDef.skip_when !== undefined) {
      warnings.push(
        `State "${currentState}" has skip_when — predicate not evaluated in simulation`,
      );
    }

    // (d) Scenario exhausted
    if (scenarioIndex >= scenario.length) {
      return {
        dead_end_at: undefined,
        iterations_consumed: iterationsConsumed,
        ok: false,
        path,
        stuck_at: currentState,
        terminal_state: undefined,
        warnings,
      };
    }

    // (e) Get next scenario entry
    const entry = scenario[scenarioIndex];

    // (f) State ID mismatch
    if (entry.state_id !== currentState) {
      warnings.push(
        `Scenario mismatch at step ${step}: expected "${currentState}", got "${entry.state_id}"`,
      );
      return {
        dead_end_at: currentState,
        iterations_consumed: iterationsConsumed,
        ok: false,
        path,
        stuck_at: undefined,
        terminal_state: undefined,
        warnings,
      };
    }

    // (g) Normalize status
    const normalized = normalizeStatus(entry.status);

    // (h) Evaluate transition
    const nextState = evaluateTransition(stateDef, normalized);

    // (i) No matching transition
    if (nextState === null) {
      return {
        dead_end_at: currentState,
        iterations_consumed: iterationsConsumed,
        ok: false,
        path,
        stuck_at: undefined,
        terminal_state: undefined,
        warnings,
      };
    }

    // Record path entry
    const pathEntry: SimulationPathEntry = {
      next_state: nextState,
      state_id: currentState,
      status_input: entry.status,
      transition_matched: normalized,
    };

    // (j) Virtual sink — treat as terminal-like
    if (VIRTUAL_SINKS.has(nextState)) {
      path.push(pathEntry);
      iterationsConsumed[currentState] = (iterationsConsumed[currentState] ?? 0) + 1;
      return {
        dead_end_at: undefined,
        iterations_consumed: iterationsConsumed,
        ok: true,
        path,
        stuck_at: undefined,
        terminal_state: currentState,
        warnings,
      };
    }

    // (k) Record path entry
    path.push(pathEntry);

    // (l) Increment iterations_consumed
    iterationsConsumed[currentState] = (iterationsConsumed[currentState] ?? 0) + 1;

    // (m) Check stuck via max_iterations
    const maxIter =
      "max_iterations" in stateDef && stateDef.max_iterations !== undefined
        ? Number(stateDef.max_iterations)
        : undefined;
    if (maxIter !== undefined && iterationsConsumed[currentState] > maxIter) {
      warnings.push(
        `State "${currentState}" exceeded max_iterations (${maxIter}) — stuck`,
      );
      return {
        dead_end_at: undefined,
        iterations_consumed: iterationsConsumed,
        ok: false,
        path,
        stuck_at: currentState,
        terminal_state: undefined,
        warnings,
      };
    }

    // (n) Advance
    currentState = nextState;
    scenarioIndex++;
    step++;
  }

  // Loop exited — max_steps exceeded
  warnings.push(`Simulation stopped at max_steps (${maxSteps})`);
  return {
    dead_end_at: undefined,
    iterations_consumed: iterationsConsumed,
    ok: false,
    path,
    stuck_at: currentState,
    terminal_state: undefined,
    warnings,
  };
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
