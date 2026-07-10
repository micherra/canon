/**
 * MCP tool wrapper for compute_autonomy_tier.
 *
 * Gathers confidence signals from drift.db, KG blast radius, and file path
 * patterns, then computes an autonomy tier for the given workspace build.
 *
 * Logs an auto_decision event to the execution store's event log for audit.
 *
 * Fail-safe: any signal-gathering error returns supervised tier — never fails closed.
 *
 * Sensitive-path deny-list floor (ADR-0044): the floor is evaluated in BOTH the success
 * path (via confidence.floor from computeConfidence) and the fail-safe catch branch
 * (recomputed from the pure file_paths input) so it survives total signal-gathering
 * failure — see floorFields().
 */

import { isAbsolute } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolOk } from "@shared/lib/tool-result.ts";
import {
  type AutonomyTier,
  computeConfidence,
  type DenyCategory,
  type DenyListMatch,
  gatherSignals,
  matchSensitivePath,
} from "../services/confidence-scorer.ts";

// ---- Types ----

export type ComputeAutonomyTierInput = {
  workspace: string;
  file_paths: string[];
  override_tier?: AutonomyTier;
  /** Project directory — threaded from resolveScope(extra) in register-confidence-tools.ts. */
  projectDir: string;
};

export type ComputeAutonomyTierResult = {
  tier: AutonomyTier;
  score: number;
  reasoning: string;
  signals_used: string[];
  floor_engaged: boolean;
  floor_category?: DenyCategory;
  floor_matched_path?: string;
  require_security: boolean;
  require_adversarial: boolean;
};

/**
 * Derive the 5 machine-readable deny-list floor fields from a match (or its absence).
 * Pure. Applied in BOTH the success branch and the fail-safe catch branch so the floor
 * survives total signal-gathering failure (ADR-0044).
 */
function floorFields(
  match: DenyListMatch | null,
): Pick<
  ComputeAutonomyTierResult,
  | "floor_engaged"
  | "floor_category"
  | "floor_matched_path"
  | "require_security"
  | "require_adversarial"
> {
  return match
    ? {
        floor_category: match.category,
        floor_engaged: true,
        floor_matched_path: match.matched_path,
        require_adversarial: true,
        require_security: true,
      }
    : { floor_engaged: false, require_adversarial: false, require_security: false };
}

// Fail-safe response used when signal gathering fails entirely.
const FAIL_SAFE_RESULT: ComputeAutonomyTierResult = {
  floor_engaged: false,
  reasoning: "signal gathering failed — defaulting to supervised",
  require_adversarial: false,
  require_security: false,
  score: 0,
  signals_used: [],
  tier: "supervised",
};

// ---- Tool implementation ----

/**
 * Signal gathering and tier computation — no execution-store writes.
 * (I/O is limited to drift.db and KG reads for signal gathering.)
 */
async function computeTierResult(
  file_paths: string[],
  override_tier: AutonomyTier | undefined,
  projectDir: string,
): Promise<ComputeAutonomyTierResult> {
  const driftDb = getDriftDb(projectDir);
  const signals = await gatherSignals(file_paths, projectDir, driftDb);

  if (override_tier !== undefined) {
    signals.override_tier = override_tier;
  }

  const confidence = computeConfidence(signals);
  return {
    reasoning: confidence.reasoning,
    score: confidence.score,
    signals_used: confidence.signals_used,
    tier: confidence.tier,
    ...floorFields(confidence.floor ?? null),
  };
}

/**
 * Log an auto_decision event to the execution store for audit.
 * Best-effort: never throws, never blocks the caller.
 */
function logAutonomyTierDecision(
  workspace: string,
  file_paths: string[],
  result: ComputeAutonomyTierResult,
): void {
  if (!isAbsolute(workspace)) return;
  try {
    const store = getExecutionStore(workspace);
    store.appendEvent("auto_decision", {
      decision_type: "tier_assignment",
      file_paths,
      floor_category: result.floor_category,
      floor_engaged: result.floor_engaged,
      floor_matched_path: result.floor_matched_path,
      reasoning: result.reasoning,
      require_adversarial: result.require_adversarial,
      require_security: result.require_security,
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

/**
 * Compute the autonomy tier for a build based on confidence signals,
 * then log an auto_decision audit event to the execution store.
 *
 * On any signal-gathering failure: returns supervised (fail-safe, not fail-closed).
 */
export async function computeAutonomyTier(
  input: ComputeAutonomyTierInput,
): Promise<ToolResult<ComputeAutonomyTierResult>> {
  const { workspace, file_paths, override_tier, projectDir } = input;

  let result: ComputeAutonomyTierResult;
  try {
    result = await computeTierResult(file_paths, override_tier, projectDir);
  } catch (err) {
    console.warn(
      "[canon] compute-autonomy-tier: signal gathering failed, defaulting to supervised:",
      err instanceof Error ? err.message : err,
    );
    // Fail-CLOSED half of the deny-list floor (ADR-0044): recompute from the pure
    // file_paths input (no I/O dependency) so the floor survives total signal-gathering
    // failure — it must never weaken to "unfloored" just because drift.db/KG failed.
    const floor = matchSensitivePath(file_paths);
    result = { ...FAIL_SAFE_RESULT, ...floorFields(floor) };
    if (floor) {
      result.reasoning = `${FAIL_SAFE_RESULT.reasoning}; sensitive-path deny-list floor engaged — category "${floor.category}" matched pattern "${floor.pattern}" on "${floor.matched_path}"`;
    }
  }

  logAutonomyTierDecision(workspace, file_paths, result);

  return toolOk(result);
}
