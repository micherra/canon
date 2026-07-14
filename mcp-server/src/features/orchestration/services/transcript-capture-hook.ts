/**
 * transcript-capture-hook — best-effort transcript capture side-effect for log_step.
 *
 * Extracted from orchestration-journal.ts to comply with the noExcessiveLinesPerFile
 * limit (line-limit-split-into-siblings convention). Called from logStep and batchLogSteps
 * on completed steps that carry an agent_id.
 *
 * Resolution order: raw exact-stat first (unnamed path, unchanged — see
 * capture-transcript.ts's agent_id glob fallback), then a named fallback that
 * reuses the shared session-scoped resolver (resolveCliffTranscriptSource,
 * ADR-0041) when the raw stat misses and the agent_id is a composite
 * (`<name>@session-<id>`) named-agent id. A miss after both attempts emits
 * fail-open `transcript_capture_miss` telemetry. See DESIGN.md Decisions D1–D4.
 */

import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { captureTranscript } from "../tools/capture-transcript.ts";
import type { JournalStep, LogStepInput, LogStepResult } from "../tools/orchestration-journal.ts";
import { resolveCliffTranscriptSource } from "./cliff-transcript-source.ts";
import { normalizeWorkspaceRoot } from "./write-receipt.ts";

type CaptureResult = Awaited<ReturnType<typeof captureTranscript>>;

/**
 * Fail-open telemetry marking a completion-path capture miss (both the raw
 * exact-stat attempt and, when applicable, the named fallback found nothing).
 * Mirrors emitWeakPassTelemetry in write-receipt.ts — never throws.
 */
function emitTranscriptCaptureMiss(
  workspace: string,
  payload: { step_id: string; agent_type: string | null; agent_id?: string; reason?: string },
): void {
  try {
    getExecutionStore(normalizeWorkspaceRoot(workspace)).appendEvent(
      "transcript_capture_miss",
      payload,
    );
  } catch (err) {
    console.warn(
      "[canon] transcript_capture_miss telemetry emit failed (fail-open):",
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Named fallback — only reached on a raw exact-stat miss. Resolves the
 * source via the shared session-scoped resolver (ADR-0041) and re-runs
 * captureTranscript with the pre-resolved source_path when found. Returns
 * the original captureResult unchanged when the guard conditions aren't met
 * or the resolver finds nothing.
 */
async function tryNamedFallback(
  captureResult: CaptureResult,
  step: JournalStep,
  input: LogStepInput,
  sessionId: string | undefined,
): Promise<CaptureResult> {
  const eligible =
    captureResult.ok &&
    !captureResult.transcript_path &&
    sessionId &&
    step.agent_type &&
    input.agent_id?.includes("@");
  if (!eligible) return captureResult;

  const src = resolveCliffTranscriptSource({
    agentType: step.agent_type,
    projectDir: input.projectDir,
    sessionId: sessionId as string,
    startedAt: step.started_at,
    stepId: input.step_id,
  });
  if (!("path" in src) || !src.path) return captureResult;

  return captureTranscript({
    agent_type: step.agent_type ?? "unknown",
    projectDir: input.projectDir,
    source_path: src.path,
    step_id: input.step_id,
    workspace: input.workspace,
  });
}

export async function tryTranscriptCapture(
  step: JournalStep,
  result: LogStepResult,
  input: LogStepInput,
  sessionId?: string,
): Promise<void> {
  if (!input.agent_id) return;

  // 1. Raw exact-stat first — unnamed path, unchanged. Hits for an unnamed
  //    agent (agent-a<hex>.jsonl); misses for a composite named agent_id.
  const rawResult = await captureTranscript({
    agent_id: input.agent_id,
    agent_type: step.agent_type ?? "unknown",
    projectDir: input.projectDir,
    step_id: input.step_id,
    workspace: input.workspace,
  });

  // 2. Named fallback — only when the raw stat missed and the id looks like
  //    a composite named agent id (see tryNamedFallback's eligibility guard).
  const captureResult = await tryNamedFallback(rawResult, step, input, sessionId);

  // 3. Apply success — unchanged.
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
    return;
  }

  // 4. Miss telemetry — after both attempts, still nothing.
  if (captureResult.ok && !captureResult.transcript_path) {
    result.transcript_warning = captureResult.warning;
    emitTranscriptCaptureMiss(input.workspace, {
      agent_id: input.agent_id,
      agent_type: step.agent_type,
      reason: captureResult.warning,
      step_id: input.step_id,
    });
  }
}
