/**
 * record_agent_metrics — MCP tool for agents to record their own performance counters.
 *
 * Agents call this before returning their final status. The fields are merged into
 * the existing execution_states.metrics JSON, preserving orchestrator-written fields
 * (duration_ms, spawns, model) while adding agent-measured fields (tool_calls,
 * orientation_calls, turns).
 */

import { getExecutionStore } from "../orchestration/execution-store.ts";
import { toolError, toolOk } from "../utils/tool-result.ts";
import type { ToolResult } from "../utils/tool-result.ts";

interface RecordAgentMetricsInput {
  workspace: string;
  state_id: string;
  tool_calls?: number;
  orientation_calls?: number;
  turns?: number;
}

interface RecordAgentMetricsResult {
  recorded: Record<string, number>;
}

export async function recordAgentMetrics(
  input: RecordAgentMetricsInput,
): Promise<ToolResult<RecordAgentMetricsResult>> {
  const { workspace, state_id, tool_calls, orientation_calls, turns } = input;

  // Validate: at least one metric field must be provided
  if (tool_calls === undefined && orientation_calls === undefined && turns === undefined) {
    return toolError(
      "INVALID_INPUT",
      "At least one metric field must be provided (tool_calls, orientation_calls, turns)",
      false,
    );
  }

  // Build the metrics object from only the defined fields
  const provided: Record<string, number> = {};
  if (tool_calls !== undefined) provided.tool_calls = tool_calls;
  if (orientation_calls !== undefined) provided.orientation_calls = orientation_calls;
  if (turns !== undefined) provided.turns = turns;

  // Validate: all provided values must be non-negative integers
  for (const [key, value] of Object.entries(provided)) {
    if (!Number.isInteger(value) || value < 0) {
      return toolError(
        "INVALID_INPUT",
        `Metric "${key}" must be a non-negative integer, got: ${value}`,
        false,
        { field: key, value },
      );
    }
  }

  // Get the store and check state exists
  let store: ReturnType<typeof getExecutionStore>;
  try {
    store = getExecutionStore(workspace);
  } catch (err) {
    return toolError(
      "WORKSPACE_NOT_FOUND",
      `Workspace not found or invalid: ${workspace}`,
      false,
      { workspace, cause: String(err) },
    );
  }
  const state = store.getState(state_id);
  if (!state) {
    return toolError(
      "INVALID_INPUT",
      `State "${state_id}" not found in workspace`,
      false,
      { workspace, state_id },
    );
  }

  // Merge agent fields into existing metrics (preserves orchestrator fields)
  store.updateStateMetrics(state_id, provided);

  return toolOk({ recorded: provided });
}
