/**
 * capture_transcript — Reads a Claude Code agent transcript JSONL, transforms
 * entries to Canon format, and writes them to the workspace transcripts directory.
 *
 * Claude Code persists full agent conversation transcripts at:
 *   ${CLAUDE_CONFIG_DIR}/projects/${projectId}/${sessionId}/subagents/agent-${agentId}.jsonl
 *
 * This tool is best-effort: when the source file cannot be found, it returns a
 * warning rather than an error. Capture failures must never crash a flow
 * (fail-closed-by-default: non-fatal path only; errors are values not throws).
 *
 * Security:
 * - claudeConfigHome is derived from CLAUDE_CONFIG_DIR env var or ~/.claude (never hardcoded)
 * - projectId is derived from CANON_PROJECT_DIR env var when not supplied (secrets-never-in-code)
 * - Output path is always inside {workspace}/transcripts/ (path-traversal guard)
 */

import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolOk } from "@shared/lib/tool-result.ts";
import { isPathContained } from "@shared/lib/worktree-guard.ts";
import { transformClaudeCodeTranscript } from "../services/transcript-transformer.ts";

export type CaptureTranscriptInput = {
  workspace: string;
  step_id: string;
  agent_type: string;
  agent_id: string;
  session_id?: string;
  project_id?: string;
};

export type CaptureTranscriptResult = {
  transcript_path: string;
  entry_count: number;
  warning?: string;
};

/**
 * Derive the Claude config home directory.
 * Uses CLAUDE_CONFIG_DIR env var when set, otherwise defaults to ~/.claude.
 * Never hardcodes a path — secrets-never-in-code principle.
 */
function claudeConfigHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/**
 * Derive the Claude Code project ID from CANON_PROJECT_DIR env var.
 * Sanitizes the path: replaces all "/" with "-".
 * Preserves the leading "-" because Claude Code project directories always
 * start with "/" (e.g., CANON_PROJECT_DIR="/Users/test-project" →
 * project_id = "-Users-test-project"), which matches Claude Code's own
 * project-directory naming convention.
 * Returns null when the env var is not set.
 */
function deriveProjectIdFromEnv(): string | null {
  const canonProjectDir = process.env.CANON_PROJECT_DIR;
  if (!canonProjectDir) return null;
  return canonProjectDir.replace(/\//g, "-");
}

/**
 * Build the path to the Claude Code agent transcript JSONL file.
 */
function buildSourcePath(agentId: string, projectId: string, sessionId: string): string {
  const configHome = claudeConfigHome();
  return join(configHome, "projects", projectId, sessionId, "subagents", `agent-${agentId}.jsonl`);
}

/**
 * Build the output path for the Canon transcript file.
 * Always inside {workspace}/transcripts/.
 * Format: {step_id}--{agent_type}--{ISO-timestamp}.jsonl
 */
function buildOutputPath(workspace: string, stepId: string, agentType: string): string {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${stepId}--${agentType}--${iso}.jsonl`;
  return join(workspace, "transcripts", filename);
}

/**
 * Read a JSONL file line by line and return the parsed JSON objects.
 * Skips empty lines and malformed JSON (best-effort).
 */
async function readJsonlFile(filePath: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  const rl = createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: createReadStream(filePath, { encoding: "utf-8" }),
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed JSON lines (best-effort)
    }
  }
  return entries;
}

export async function captureTranscript(
  input: CaptureTranscriptInput,
): Promise<ToolResult<CaptureTranscriptResult>> {
  const { workspace, step_id, agent_type, agent_id } = input;

  // Resolve projectId
  const projectId = input.project_id ?? deriveProjectIdFromEnv();
  if (!projectId) {
    return toolOk({
      entry_count: 0,
      transcript_path: "",
      warning:
        "Cannot capture transcript: project_id not provided and CANON_PROJECT_DIR env var not set",
    });
  }

  // Resolve sessionId
  const sessionId = input.session_id ?? process.env.CLAUDE_SESSION_ID;
  if (!sessionId) {
    return toolOk({
      entry_count: 0,
      transcript_path: "",
      warning:
        "Cannot capture transcript: session_id not provided and CLAUDE_SESSION_ID env var not set",
    });
  }

  const sourcePath = buildSourcePath(agent_id, projectId, sessionId);
  const outputPath = buildOutputPath(workspace, step_id, agent_type);

  // Guard: output must stay inside workspace/transcripts/
  const transcriptsDir = resolve(workspace, "transcripts");
  if (!isPathContained(transcriptsDir, resolve(outputPath))) {
    return toolOk({
      entry_count: 0,
      transcript_path: "",
      warning: `Output path is outside the expected transcripts directory: ${outputPath}`,
    });
  }

  // Read the source transcript (best-effort — file may not exist yet)
  let rawEntries: unknown[];
  try {
    rawEntries = await readJsonlFile(sourcePath);
  } catch {
    return toolOk({
      entry_count: 0,
      transcript_path: "",
      warning: `Source transcript not found or unreadable: ${sourcePath}`,
    });
  }

  // Transform CC entries to Canon format
  // transformClaudeCodeTranscript validates each entry and skips malformed ones
  const canonEntries = transformClaudeCodeTranscript(
    rawEntries as Parameters<typeof transformClaudeCodeTranscript>[0],
  );

  // Write output
  try {
    await mkdir(transcriptsDir, { recursive: true });
    const content = canonEntries.map((e) => JSON.stringify(e)).join("\n");
    await writeFile(outputPath, content, "utf-8");
  } catch (err) {
    return toolOk({
      entry_count: 0,
      transcript_path: "",
      warning: `Failed to write transcript file: ${String(err)}`,
    });
  }

  return toolOk({
    entry_count: canonEntries.length,
    transcript_path: outputPath,
  });
}
