/**
 * context-provenance-backfill — fail-open agent_id back-fill for context provenance records.
 *
 * When log_step completes a step with an agent_id, this helper appends a
 * context_provenance_agent_id event to the execution store so the run-summary
 * builder (step0-04) can join agent_id onto the provisional provenance record.
 *
 * Design contract (errors-are-values / fail-open):
 *   - Never throws, never rejects.
 *   - A failure in the back-fill must NOT block step completion — it is advisory.
 *   - Mirrors tryTranscriptCapture's best-effort setTranscriptPath store touch.
 */

import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";

/**
 * Append a context_provenance_agent_id event so a later run-summary join can attach
 * agent_id to the provisional context_provenance record for this step.
 *
 * Fail-open: never throws, never blocks log_step completion.
 */
export function backfillContextProvenanceAgentId(
  workspace: string,
  stepId: string,
  agentId: string,
): void {
  try {
    getExecutionStore(workspace).appendEvent(
      "context_provenance_agent_id",
      { agent_id: agentId, step_id: stepId },
      stepId,
    );
  } catch (err) {
    // Fail-open: provenance back-fill must never block a step completion.
    console.warn("[context-provenance] backfill failed:", err instanceof Error ? err.message : err);
  }
}
