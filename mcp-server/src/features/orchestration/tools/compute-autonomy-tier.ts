/**
 * MCP tool wrapper for compute_autonomy_tier.
 *
 * Gathers confidence signals from drift.db, KG blast radius, and file path
 * patterns, then computes an autonomy tier for the given workspace build.
 *
 * Logs an auto_decision event to the execution store's event log for audit.
 *
 * Fail-safe: any signal-gathering error returns supervised tier — never fails closed.
 */

import { isAbsolute } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { projectDir } from "@app/server-state.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolOk } from "@shared/lib/tool-result.ts";
import {
  computeConfidence,
  gatherSignals,
  type AutonomyTier,
} from "../services/confidence-scorer.ts";

// ---- Types ----

export type ComputeAutonomyTierInput = {
  workspace: string;
  file_paths: string[];
  override_tier?: AutonomyTier;
};

export type ComputeAutonomyTierResult = {
  tier: AutonomyTier;
  score: number;
  reasoning: string;
  signals_used: string[];
};

// Fail-safe response used when signal gathering fails entirely.
const FAIL_SAFE_RESULT: ComputeAutonomyTierResult = {
  reasoning: "signal gathering failed — defaulting to supervised",
  score: 0,
  signals_used: [],
  tier: "supervised",
};

// ---- Tool implementation ----

/**
 * Compute the autonomy tier for a build based on confidence signals.
 *
 * Steps:
 * 1. Gather signals: drift.db build history, KG blast radius, file patterns
 * 2. Apply override_tier if provided
 * 3. Compute confidence score and tier
 * 4. Log auto_decision event to execution store
 * 5. Return tier result
 *
 * On any signal-gathering failure: returns supervised (fail-safe, not fail-closed).
 */
export async function computeAutonomyTier(
  input: ComputeAutonomyTierInput,
): Promise<ToolResult<ComputeAutonomyTierResult>> {
  const { workspace, file_paths, override_tier } = input;

  // Gather signals — wrapped in try/catch for fail-safe behavior
  let result: ComputeAutonomyTierResult;
  try {
    const signals = await gatherSignals(file_paths, projectDir);

    // Apply user override if provided
    if (override_tier !== undefined) {
      signals.override_tier = override_tier;
    }

    const confidence = computeConfidence(signals);
    result = {
      reasoning: confidence.reasoning,
      score: confidence.score,
      signals_used: confidence.signals_used,
      tier: confidence.tier,
    };
  } catch (err) {
    console.warn(
      "[canon] compute-autonomy-tier: signal gathering failed, defaulting to supervised:",
      err instanceof Error ? err.message : err,
    );
    result = FAIL_SAFE_RESULT;
  }

  // Log auto_decision event — best-effort, never blocks the response
  if (isAbsolute(workspace)) {
    try {
      const store = getExecutionStore(workspace);
      store.appendEvent("auto_decision", {
        decision_type: "tier_assignment",
        file_paths,
        reasoning: result.reasoning,
        score: result.score,
        signals_used: result.signals_used,
        tier: result.tier,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.warn(
        "[canon] compute-autonomy-tier: auto_decision event logging failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  return toolOk(result);
}
