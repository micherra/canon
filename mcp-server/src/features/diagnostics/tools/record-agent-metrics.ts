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
 *
 * Durability: `init_workspace` never creates per-step `execution_states` rows, so on
 * the happy path (no prior escalation) a step's row doesn't exist yet when the agent
 * first calls this tool. The state row is auto-created (upsert-if-absent) so the write
 * lands instead of being silently discarded as `INVALID_INPUT`. A workspace with no
 * execution row at all still fails closed as `WORKSPACE_NOT_FOUND` — the tool never
 * creates an orphan state row for a workspace that was never initialized.
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
 * Returns whatever `updateStateMetrics` returns — `false` means the write did
 * not land (state row absent), which the caller must treat as a failure.
 */
function writeProvidedMetrics(opts: {
  store: ReturnType<typeof getExecutionStore>;
  state: BoardStateEntry;
  stateId: string;
  stage: string | undefined;
  provided: Record<string, number>;
}): boolean {
  const { store, state, stateId, stage, provided } = opts;
  if (stage === undefined) {
    return store.updateStateMetrics(stateId, provided);
  }
  const existingStageMetrics = state.metrics?.stage_metrics ?? {};
  return store.updateStateMetrics(stateId, {
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

  // Get the store and confirm the workspace has been initialized
  let store: ReturnType<typeof getExecutionStore>;
  try {
    store = getExecutionStore(workspace);
  } catch (err) {
    return toolError("WORKSPACE_NOT_FOUND", `Workspace not found or invalid: ${workspace}`, false, {
      cause: String(err),
      workspace,
    });
  }
  if (store.getExecution() === null) {
    return toolError("WORKSPACE_NOT_FOUND", `Workspace has no execution: ${workspace}`, false, {
      workspace,
    });
  }

  // Auto-create the state row when it doesn't exist yet — on the happy path,
  // init_workspace never creates per-step execution_states rows, so a strict
  // "must already exist" check silently discards every agent's first metrics
  // write. Mirrors get-next-escalation-strategy.ts's upsert pattern.
  let state = store.getState(state_id);
  if (!state) {
    store.upsertState(state_id, { entries: 0, status: "pending" });
    state = store.getState(state_id);
  }
  if (!state) {
    return toolError("UNEXPECTED", `Failed to create state "${state_id}"`, false, {
      state_id,
      workspace,
    });
  }

  const landed = writeProvidedMetrics({ provided, stage, state, stateId: state_id, store });
  if (!landed) {
    return toolError("UNEXPECTED", `Metrics write did not land for state "${state_id}"`, false, {
      state_id,
      workspace,
    });
  }

  return toolOk({ recorded: provided });
}
