import { createReadStream } from "node:fs";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { ToolResult } from "@shared/lib/tool-result.ts";
import { toolOk } from "@shared/lib/tool-result.ts";
import { isPathContained } from "@shared/lib/worktree-guard.ts";
import { projectDir } from "../../../app/server-state.ts";
import { transformClaudeCodeTranscript } from "../services/transcript-transformer.ts";

export type CaptureTranscriptInput = {
  workspace: string;
  step_id: string;
  agent_type: string;
  agent_id: string;
};

export type CaptureTranscriptResult = {
  transcript_path: string;
  entry_count: number;
  warning?: string;
};

async function findAgentTranscript(agentId: string): Promise<string | null> {
  const home = process.env.HOME ?? "/tmp";
  const projectsDir = join(home, ".claude", "projects", projectDir.replace(/\//g, "-"));
  let sessionDirs: string[];
  try {
    sessionDirs = await readdir(projectsDir);
  } catch {
    return null;
  }
  const candidates = sessionDirs.map((s) =>
    join(projectsDir, s, "subagents", `agent-${agentId}.jsonl`),
  );
  const checks = await Promise.all(
    candidates.map((c) =>
      stat(c)
        .then(() => c)
        .catch(() => null),
    ),
  );
  return checks.find((c) => c !== null) ?? null;
}

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
      // best-effort
    }
  }
  return entries;
}

export async function captureTranscript(
  input: CaptureTranscriptInput,
): Promise<ToolResult<CaptureTranscriptResult>> {
  const { workspace, step_id, agent_type, agent_id } = input;

  const sourcePath = await findAgentTranscript(agent_id);
  if (!sourcePath) {
    return toolOk({
      entry_count: 0,
      transcript_path: "",
      warning: `Source transcript not found for agent ${agent_id}`,
    });
  }

  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = join(workspace, "transcripts", `${step_id}--${agent_type}--${iso}.jsonl`);

  const transcriptsDir = resolve(workspace, "transcripts");
  if (!isPathContained(transcriptsDir, resolve(outputPath))) {
    return toolOk({
      entry_count: 0,
      transcript_path: "",
      warning: `Output path outside transcripts directory: ${outputPath}`,
    });
  }

  let rawEntries: unknown[];
  try {
    rawEntries = await readJsonlFile(sourcePath);
  } catch {
    return toolOk({
      entry_count: 0,
      transcript_path: "",
      warning: `Source transcript unreadable: ${sourcePath}`,
    });
  }

  const canonEntries = transformClaudeCodeTranscript(
    rawEntries as Parameters<typeof transformClaudeCodeTranscript>[0],
  );

  try {
    await mkdir(transcriptsDir, { recursive: true });
    const content = canonEntries.map((e) => JSON.stringify(e)).join("\n");
    await writeFile(outputPath, content, "utf-8");
  } catch (err) {
    return toolOk({
      entry_count: 0,
      transcript_path: "",
      warning: `Failed to write transcript: ${String(err)}`,
    });
  }

  return toolOk({
    entry_count: canonEntries.length,
    transcript_path: outputPath,
  });
}
