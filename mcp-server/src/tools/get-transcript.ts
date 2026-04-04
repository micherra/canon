/**
 * get_transcript — Retrieve the transcript of a specialist agent's conversation
 * for a given state execution.
 *
 * Reads the JSONL transcript file referenced by transcript_path in the
 * execution_states table. Supports full mode (all entries) and summary mode
 * (assistant messages only, ~20% of full).
 *
 * Errors are returned as ToolResult values (errors-are-values principle).
 * The function never throws for expected error conditions.
 */

import { readFile, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import { type TranscriptEntry, TranscriptEntrySchema } from "../orchestration/flow-schema.ts";
import type { ToolResult } from "../utils/tool-result.ts";
import { toolError, toolOk } from "../utils/tool-result.ts";

export type GetTranscriptInput = {
  workspace: string;
  state_id: string;
  mode?: "full" | "summary"; // default: "full"
};

export type GetTranscriptResult = {
  state_id: string;
  mode: "full" | "summary";
  transcript_path: string;
  entries: TranscriptEntry[];
  entry_count: number;
  total_tokens?: number;
};

/**
 * Retrieve the agent conversation transcript for a given state execution.
 *
 * Reads the JSONL file at the path stored in execution_states.transcript_path.
 * Returns a typed error when no path is recorded or the file does not exist.
 * Corrupt JSONL lines are skipped silently (best-effort — large transcripts should not fail entirely).
 */
/** Validate that a resolved path is contained within the transcripts directory. */
function isPathContained(containerDir: string, targetPath: string): boolean {
  const rel = relative(containerDir, targetPath);
  return !rel.startsWith("..") && resolve(containerDir, rel) === targetPath;
}

/** Resolve the real filesystem path for the transcript, guarding against traversal and symlink escapes. */
async function resolveTranscriptRealPath(
  transcriptPath: string,
  workspace: string,
): Promise<ToolResult<string> | string> {
  const transcriptsDir = resolve(workspace, "transcripts");
  const resolvedTranscriptPath = resolve(transcriptPath);

  if (!isPathContained(transcriptsDir, resolvedTranscriptPath)) {
    return toolError(
      "TRANSCRIPT_NOT_FOUND",
      `Transcript path is outside the expected transcripts directory for workspace '${workspace}'`,
      false,
    );
  }

  try {
    const realTranscriptsDir = await realpath(transcriptsDir);
    const realReadPath = await realpath(resolvedTranscriptPath);
    if (!isPathContained(realTranscriptsDir, realReadPath)) {
      return toolError(
        "TRANSCRIPT_NOT_FOUND",
        `Transcript path is outside the expected transcripts directory for workspace '${workspace}'`,
        false,
      );
    }
    return realReadPath;
  } catch {
    return toolError(
      "TRANSCRIPT_NOT_FOUND",
      `Transcript file not found for state in workspace '${workspace}': ${transcriptPath}`,
      false,
    );
  }
}

/** Parse JSONL content into TranscriptEntry[], skipping corrupt lines. */
function parseTranscriptLines(raw: string): TranscriptEntry[] {
  const lines = raw.trim().split("\n").filter(Boolean);
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = TranscriptEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) {
        entries.push(parsed.data);
      }
    } catch {
      // Skip corrupt JSON lines (best-effort)
    }
  }
  return entries;
}

export async function getTranscript(
  input: GetTranscriptInput,
): Promise<ToolResult<GetTranscriptResult>> {
  const store = getExecutionStore(input.workspace);
  const transcriptPath = store.getTranscriptPath(input.state_id);

  if (!transcriptPath) {
    return toolError(
      "TRANSCRIPT_NOT_FOUND",
      `No transcript recorded for state '${input.state_id}' in workspace '${input.workspace}'`,
      false,
    );
  }

  const realPathResult = await resolveTranscriptRealPath(transcriptPath, input.workspace);
  if (typeof realPathResult !== "string") return realPathResult;

  let raw: string;
  try {
    raw = await readFile(realPathResult, "utf-8");
  } catch {
    return toolError(
      "TRANSCRIPT_NOT_FOUND",
      `Transcript file could not be read for state '${input.state_id}' in workspace '${input.workspace}': ${transcriptPath}`,
      false,
    );
  }

  let entries = parseTranscriptLines(raw);

  // Compute total_tokens from ALL entries (not just filtered ones)
  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
  const totalTokens = lastEntry?.cumulative_tokens;

  const mode = input.mode ?? "full";
  if (mode === "summary") {
    entries = entries.filter((e) => e.role === "assistant");
  }

  return toolOk({
    entries,
    entry_count: entries.length,
    mode,
    state_id: input.state_id,
    transcript_path: transcriptPath,
    ...(totalTokens != null ? { total_tokens: totalTokens } : {}),
  });
}
