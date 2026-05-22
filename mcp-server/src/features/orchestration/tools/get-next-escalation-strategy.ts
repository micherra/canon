/**
 * get_next_escalation_strategy — MCP tool wrapper.
 *
 * Determines the next fallback strategy for an auto-escalation cascade.
 * Reads or initializes escalation state from the workspace execution store,
 * advances it by one step, persists the update, and logs an audit event.
 *
 * Terminal state (hitl) is a valid result, not an error — errors-are-values.
 */

import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";
import type { EscalationConfig, EscalationResult } from "../services/escalation-cascade.ts";
import {
  getNextStrategy,
  initEscalationState,
  readEscalationState,
  recordAttempt,
  writeEscalationState,
} from "../services/escalation-cascade.ts";

// ---- Types ----

export type GetNextEscalationStrategyInput = {
  workspace: string;
  step_id: string;
  flow_config?: EscalationConfig;
};

export type GetNextEscalationStrategyResult = EscalationResult;

// ---- Tool handler ----

export async function getNextEscalationStrategy(
  input: GetNextEscalationStrategyInput,
): Promise<ToolResult<GetNextEscalationStrategyResult>> {
  const { workspace, step_id, flow_config } = input;

  // 1. Get execution store from workspace
  let store: ReturnType<typeof getExecutionStore>;
  try {
    store = getExecutionStore(workspace);
  } catch (err) {
    return toolError("WORKSPACE_NOT_FOUND", `Workspace not found or invalid: ${workspace}`, false, {
      cause: String(err),
      workspace,
    });
  }

  // 2. Read or initialize escalation state
  let state = readEscalationState(store, step_id);
  if (state === null) {
    state = initEscalationState(step_id);
    // Must upsert the state row before we can write metrics to it
    // Use recordStateEntry to ensure the row exists, or check if it already does.
    // getState returns null when no row — we need to ensure a row exists for updateStateMetrics.
    const existingState = store.getState(step_id);
    if (!existingState) {
      // Create a minimal state row so updateStateMetrics has a row to update
      store.upsertState(step_id, { entries: 0, status: "pending" });
    }
    writeEscalationState(store, step_id, state);
  }

  // 3. Determine next strategy
  const result = getNextStrategy(state, flow_config);

  // 4. Record the attempt and persist updated state
  const updatedState = recordAttempt(state, result.strategy, step_id);
  writeEscalationState(store, step_id, updatedState);

  // 5. Log auto_decision event
  store.appendEvent("auto_decision", {
    attempts_so_far: result.attempts_so_far,
    decision_type: "escalation",
    reasoning: result.reasoning,
    strategy: result.strategy,
    time_elapsed_ms: result.time_elapsed_ms,
  });

  // 6. Return the result — terminal (hitl) is a valid value, not an error
  return toolOk(result);
}
