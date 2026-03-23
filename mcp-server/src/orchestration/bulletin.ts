import { appendFile, readFile, mkdir, access } from "fs/promises";
import { join, dirname } from "path";

export interface BulletinMessage {
  timestamp: string;
  from: string;
  type: "created_utility" | "established_pattern" | "discovered_gotcha" | "needs_input" | "fyi";
  summary: string;
  detail: {
    path?: string;
    exports?: string[];
    pattern?: string;
    issue?: string;
  };
}

/**
 * Compute the bulletin file path for a given workspace and wave.
 */
export function bulletinPath(workspace: string, wave: number): string {
  return join(workspace, "waves", String(wave).padStart(3, "0"), "bulletin.jsonl");
}

/**
 * Post a message to the wave bulletin.
 * Creates the directory structure if needed.
 */
export async function postBulletin(workspace: string, wave: number, message: Omit<BulletinMessage, "timestamp">): Promise<BulletinMessage> {
  const filePath = bulletinPath(workspace, wave);
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const full: BulletinMessage = {
    ...message,
    timestamp: new Date().toISOString(),
  };

  await appendFile(filePath, JSON.stringify(full) + "\n", "utf-8");
  return full;
}

/**
 * Read messages from the wave bulletin.
 * Returns empty array if bulletin doesn't exist.
 * Optionally filters by timestamp (since) and/or message type.
 */
export async function readBulletin(
  workspace: string,
  wave: number,
  options?: { since?: string; type?: string }
): Promise<BulletinMessage[]> {
  const filePath = bulletinPath(workspace, wave);

  try {
    await access(filePath);
  } catch {
    return [];
  }

  const content = await readFile(filePath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  let messages: BulletinMessage[] = [];
  for (const line of lines) {
    try {
      messages.push(JSON.parse(line));
    } catch {
      // Skip corrupt JSONL lines rather than failing the entire read
    }
  }

  if (options?.since) {
    const sinceMs = new Date(options.since).getTime();
    messages = messages.filter(m => new Date(m.timestamp).getTime() > sinceMs);
  }

  if (options?.type) {
    messages = messages.filter(m => m.type === options.type);
  }

  return messages;
}

/**
 * Build wave coordination instructions to inject into agent prompts.
 * Used by get_spawn_prompt for wave/parallel-per states.
 */
export function buildBulletinInstructions(wave: number, peerCount: number, workspace?: string): string {
  const wsNote = workspace
    ? `\nBulletin parameters: workspace="${workspace}", wave=${wave}`
    : "";
  return `## Wave Coordination

You are in wave ${wave} with ${peerCount} other agents working in parallel.${wsNote}

Before creating a new shared utility, helper, or type:
1. Call get_wave_bulletin (workspace, wave) to check if another agent already created it
2. If it exists, import from their path instead of creating your own

After creating a shared utility, type, or establishing a pattern:
1. Call post_wave_bulletin with type "created_utility" or "established_pattern"
2. Include the file path and exported names in the detail so peers can find it

If you discover a gotcha (unexpected behavior, env issue, breaking test):
1. Call post_wave_bulletin with type "discovered_gotcha"
2. Include the issue in the detail — peers will see this on their next check`;
}
