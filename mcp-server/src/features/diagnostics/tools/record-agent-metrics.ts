/**
 * record_agent_metrics — MCP tool for agents to record their own performance counters.
 *
 * Agents call this before returning their final status. The fields are merged into
 * the existing execution_states.metrics JSON, preserving orchestrator-written fields
 * (duration_ms, spawns, model) while adding agent-measured fields (tool_calls,
 * orientation_calls, turns).
 *
 * Two write paths:
 * - No `stage`: today's flat merge — counters land directly on `metrics` (unchanged).
 * - `stage` present: counters are namespaced under `metrics.stage_metrics[stage]`,
 *   append-merged so a later stage does not clobber an earlier one. Lets a
 *   single-window agent (topology C, G3) emit per-stage metrics without a new tool.
 */

import type { BoardStateEntry } from "@domains/flows/board-state-schemas.ts";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import type { CanonToolError, ToolResult } from "@shared/lib/tool-result.ts";
import { toolError, toolOk } from "@shared/lib/tool-result.ts";

type RecordAgentMetricsInput = {
  workspace: string;
  state_id: string;
  tool_calls?: number;
  orientation_calls?: number;
  turns?: number;
  stage?: string;
};

type RecordAgentMetricsResult = {
  recorded: Record<string, number>;
};

/**
 * Build and validate the flat counters object from whichever fields were
 * provided. Returns the error to surface, or the validated `provided` map.
 */
function validateProvidedCounters(
  tool_calls: number | undefined,
  orientation_calls: number | undefined,
  turns: number | undefined,
): { error: CanonToolError } | { provided: Record<string, number> } {
  if (tool_calls === undefined && orientation_calls === undefined && turns === undefined) {
    return {
      error: toolError(
        "INVALID_INPUT",
        "At least one metric field must be provided (tool_calls, orientation_calls, turns)",
        false,
      ),
    };
  }

  const provided: Record<string, number> = {};
  if (tool_calls !== undefined) provided.tool_calls = tool_calls;
  if (orientation_calls !== undefined) provided.orientation_calls = orientation_calls;
  if (turns !== undefined) provided.turns = turns;

  for (const [key, value] of Object.entries(provided)) {
    if (!Number.isInteger(value) || value < 0) {
      return {
        error: toolError(
          "INVALID_INPUT",
          `Metric "${key}" must be a non-negative integer, got: ${value}`,
          false,
          { field: key, value },
        ),
      };
    }
  }

  return { provided };
}

/**
 * Write `provided` to the state's metrics. No `stage`: today's flat merge
 * (unchanged). With `stage`: read-modify-write the `stage_metrics` sub-object
 * so an earlier stage's counters survive a later stage's call —
 * `updateStateMetrics` only shallow-merges top-level keys (see its doc comment).
 */
function writeProvidedMetrics(opts: {
  store: ReturnType<typeof getExecutionStore>;
  state: BoardStateEntry;
  stateId: string;
  stage: string | undefined;
  provided: Record<string, number>;
}): void {
  const { store, state, stateId, stage, provided } = opts;
  if (stage === undefined) {
    store.updateStateMetrics(stateId, provided);
    return;
  }
  const existingStageMetrics = state.metrics?.stage_metrics ?? {};
  store.updateStateMetrics(stateId, {
    stage_metrics: { ...existingStageMetrics, [stage]: provided },
  });
}

export async function recordAgentMetrics(
  input: RecordAgentMetricsInput,
): Promise<ToolResult<RecordAgentMetricsResult>> {
  const { workspace, state_id, tool_calls, orientation_calls, turns, stage } = input;

  // Validate: stage, when provided, must be a non-empty string
  if (stage !== undefined && stage.length === 0) {
    return toolError("INVALID_INPUT", 'Metric "stage" must be a non-empty string', false, {
      field: "stage",
      value: stage,
    });
  }

  const validated = validateProvidedCounters(tool_calls, orientation_calls, turns);
  if ("error" in validated) return validated.error;
  const { provided } = validated;

  // Get the store and check state exists
  let store: ReturnType<typeof getExecutionStore>;
  try {
    store = getExecutionStore(workspace);
  } catch (err) {
    return toolError("WORKSPACE_NOT_FOUND", `Workspace not found or invalid: ${workspace}`, false, {
      cause: String(err),
      workspace,
    });
  }
  const state = store.getState(state_id);
  if (!state) {
    return toolError("INVALID_INPUT", `State "${state_id}" not found in workspace`, false, {
      state_id,
      workspace,
    });
  }

  writeProvidedMetrics({ provided, stage, state, stateId: state_id, store });

  return toolOk({ recorded: provided });
}
