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
import { resolve, relative } from "node:path";
import { getExecutionStore } from "../orchestration/execution-store.ts";
import { toolError, toolOk } from "../utils/tool-result.ts";
import type { ToolResult } from "../utils/tool-result.ts";
import {
  TranscriptEntrySchema,
  type TranscriptEntry,
} from "../orchestration/flow-schema.ts";

export interface GetTranscriptInput {
  workspace: string;
  state_id: string;
  mode?: "full" | "summary"; // default: "full"
}

export interface GetTranscriptResult {
  state_id: string;
  mode: "full" | "summary";
  transcript_path: string;
  entries: TranscriptEntry[];
  entry_count: number;
  total_tokens?: number;
}

/**
 * Retrieve the agent conversation transcript for a given state execution.
 *
 * Reads the JSONL file at the path stored in execution_states.transcript_path.
 * Returns a typed error when no path is recorded or the file does not exist.
 * Corrupt JSONL lines are skipped silently (best-effort — large transcripts should not fail entirely).
 */
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

  // Path traversal guard: transcript must resolve under ${workspace}/transcripts/
  const transcriptsDir = resolve(input.workspace, "transcripts");
  const resolvedTranscriptPath = resolve(transcriptPath);
  const rel = relative(transcriptsDir, resolvedTranscriptPath);
  if (rel.startsWith("..") || resolve(transcriptsDir, rel) !== resolvedTranscriptPath) {
    return toolError(
      "TRANSCRIPT_NOT_FOUND",
      `Transcript path is outside the expected transcripts directory for workspace '${input.workspace}'`,
      false,
    );
  }

  // Symlink escape guard: resolve real paths to ensure the file doesn't escape via symlink
  let realReadPath: string;
  try {
    const realTranscriptsDir = await realpath(transcriptsDir);
    realReadPath = await realpath(resolvedTranscriptPath);
    const realRel = relative(realTranscriptsDir, realReadPath);
    if (realRel.startsWith("..") || resolve(realTranscriptsDir, realRel) !== realReadPath) {
      return toolError(
        "TRANSCRIPT_NOT_FOUND",
        `Transcript path is outside the expected transcripts directory for workspace '${input.workspace}'`,
        false,
      );
    }
  } catch {
    return toolError(
      "TRANSCRIPT_NOT_FOUND",
      `Transcript file not found for state '${input.state_id}' in workspace '${input.workspace}': ${transcriptPath}`,
      false,
    );
  }

  let raw: string;
  try {
    raw = await readFile(realReadPath, "utf-8");
  } catch {
    return toolError(
      "TRANSCRIPT_NOT_FOUND",
      `Transcript file could not be read for state '${input.state_id}' in workspace '${input.workspace}': ${transcriptPath}`,
      false,
    );
  }
  const lines = raw.trim().split("\n").filter(Boolean);

  let entries: TranscriptEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = TranscriptEntrySchema.safeParse(JSON.parse(line));
      if (parsed.success) {
        entries.push(parsed.data);
      }
      // Skip lines that fail schema validation (best-effort)
    } catch {
      // Skip corrupt JSON lines (best-effort — large transcripts should not fail entirely)
    }
  }

  // Compute total_tokens from ALL entries (not just filtered ones)
  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
  const totalTokens = lastEntry?.cumulative_tokens;

  const mode = input.mode ?? "full";
  if (mode === "summary") {
    entries = entries.filter((e) => e.role === "assistant");
  }

  return toolOk({
    state_id: input.state_id,
    mode,
    transcript_path: transcriptPath,
    entries,
    entry_count: entries.length,
    ...(totalTokens != null ? { total_tokens: totalTokens } : {}),
  });
}
