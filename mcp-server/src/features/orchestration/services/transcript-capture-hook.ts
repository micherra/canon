/**
 * transcript-capture-hook — best-effort transcript capture side-effect for log_step.
 *
 * Extracted from orchestration-journal.ts to comply with the noExcessiveLinesPerFile
 * limit (line-limit-split-into-siblings convention). Called from logStep and batchLogSteps
 * on completed steps that carry an agent_id.
 */

import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { captureTranscript } from "../tools/capture-transcript.ts";
import type { JournalStep, LogStepInput, LogStepResult } from "../tools/orchestration-journal.ts";

export async function tryTranscriptCapture(
  step: JournalStep,
  result: LogStepResult,
  input: LogStepInput,
): Promise<void> {
  if (!input.agent_id) return;
  const captureResult = await captureTranscript({
    agent_id: input.agent_id,
    agent_type: step.agent_type ?? "unknown",
    projectDir: input.projectDir,
    step_id: input.step_id,
    workspace: input.workspace,
  });
  if (captureResult.ok && captureResult.transcript_path) {
    step.transcript_path = captureResult.transcript_path;
    result.transcript_path = captureResult.transcript_path;
    // Persist to ExecutionStore so get_transcript can find the path via getTranscriptPath().
    try {
      const store = getExecutionStore(input.workspace);
      store.setTranscriptPath(input.step_id, captureResult.transcript_path);
    } catch {
      // best-effort — transcript capture itself already succeeded; don't fail the step
    }
  }
  if (captureResult.ok && captureResult.warning) {
    result.transcript_warning = captureResult.warning;
  }
}
