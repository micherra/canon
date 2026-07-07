/**
 * cliff-transcript-capture — best-effort transcript capture for cliffed steps.
 *
 * Effect layer paired with the pure `resolveCliffTranscriptSource` query: for
 * each incomplete step, resolves a source file and, when found, reuses the
 * existing `captureTranscript` service (no parallel capture path — PRD
 * constraint) to write it under the workspace's `transcripts/` directory.
 *
 * Strictly fail-open end to end: this is diagnostic instrumentation for the
 * cliff-detection path, not a safety gate (the deliberate opposite of
 * `fail-closed-by-default`, which governs safety gates only). No throw ever
 * escapes `captureCliffTranscripts` — every step yields a typed outcome.
 */

import { captureTranscript } from "../tools/capture-transcript.ts";
import type { CliffCaptureAbsentReason } from "./cliff-transcript-source.ts";
import { resolveCliffTranscriptSource } from "./cliff-transcript-source.ts";

/** Minimal step shape needed for capture — avoids importing reconcile-workspace.ts
 * (which would create a reconcile-workspace <-> capture import cycle). */
export type CliffCaptureStepInput = {
  step_id: string;
  agent_type: string | null;
  started_at?: string;
};

/** Outcome of attempting to capture one cliffed step's transcript. */
export type CliffCaptureOutcome =
  | { transcript_path: string }
  | { transcript_uncaptured_reason: CliffCaptureAbsentReason };

export type CaptureCliffTranscriptsInput = {
  workspace: string;
  projectDir: string;
  sessionId?: string;
  steps: ReadonlyArray<CliffCaptureStepInput>;
};

/** Capture (or resolve the absent-reason for) a single cliffed step. Never throws. */
async function captureOneStep(
  workspace: string,
  projectDir: string,
  sessionId: string | undefined,
  step: CliffCaptureStepInput,
): Promise<CliffCaptureOutcome> {
  try {
    const source = resolveCliffTranscriptSource({
      agentType: step.agent_type,
      projectDir,
      sessionId,
      startedAt: step.started_at,
      stepId: step.step_id,
    });

    if (source.path === null) {
      return { transcript_uncaptured_reason: source.reason };
    }

    const shortType = (step.agent_type ?? "unknown").replace(/^canon:/, "");
    const result = await captureTranscript({
      agent_type: shortType,
      persist_path: true,
      projectDir,
      source_path: source.path,
      step_id: step.step_id,
      workspace,
    });

    return result.ok && result.transcript_path
      ? { transcript_path: result.transcript_path }
      : { transcript_uncaptured_reason: "capture_failed" };
  } catch {
    return { transcript_uncaptured_reason: "capture_failed" };
  }
}

/**
 * Best-effort capture of a transcript for each incomplete step, keyed by
 * step_id. Never throws: any error (resolution failure, captureTranscript
 * rejection, or an unexpected exception) is mapped to a typed
 * `transcript_uncaptured_reason` for that step; every step is attempted
 * independently and in parallel.
 */
export async function captureCliffTranscripts(
  args: CaptureCliffTranscriptsInput,
): Promise<Map<string, CliffCaptureOutcome>> {
  const { workspace, projectDir, sessionId, steps } = args;

  const results = await Promise.all(
    steps.map(
      async (step) =>
        [step.step_id, await captureOneStep(workspace, projectDir, sessionId, step)] as const,
    ),
  );

  return new Map(results);
}
