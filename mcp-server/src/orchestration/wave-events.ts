import { appendFile, readFile, mkdir, access, writeFile } from "fs/promises";
import { join, dirname } from "path";
import { generateId } from "../utils/id.js";
import type { WaveEvent, WaveEventType, WaveEventResolution } from "./flow-schema.js";

/**
 * Compute the events file path for a given workspace.
 */
export function eventsPath(workspace: string): string {
  return join(workspace, "waves", "events.jsonl");
}

/**
 * Post a new wave event to the events log.
 * Creates the directory structure if needed.
 * Returns the full event with generated ID, timestamp, and "pending" status.
 */
export async function postWaveEvent(
  workspace: string,
  event: Omit<WaveEvent, "id" | "timestamp" | "status">
): Promise<WaveEvent> {
  const filePath = eventsPath(workspace);
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const full: WaveEvent = {
    ...event,
    id: generateId("evt"),
    timestamp: new Date().toISOString(),
    status: "pending",
  };

  try {
    await appendFile(filePath, JSON.stringify(full) + "\n", "utf-8");
  } catch {
    // Best-effort — never crash on write failure
  }

  return full;
}

/**
 * Read all pending events from the events log.
 * Returns empty array if file doesn't exist.
 * Skips corrupt lines rather than failing.
 */
export async function readPendingEvents(workspace: string): Promise<WaveEvent[]> {
  const all = await readAllEvents(workspace);
  return all.filter((e) => e.status === "pending");
}

/**
 * Read all events from the events log regardless of status.
 * Returns empty array if file doesn't exist.
 * Skips corrupt lines rather than failing.
 */
export async function readAllEvents(workspace: string): Promise<WaveEvent[]> {
  const filePath = eventsPath(workspace);

  try {
    await access(filePath);
  } catch {
    return [];
  }

  const content = await readFile(filePath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  const events: WaveEvent[] = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      // Skip corrupt JSONL lines rather than failing the entire read
    }
  }

  return events;
}

/**
 * Mark an event as applied, optionally attaching a resolution.
 * Rewrites the entire events file atomically.
 */
export async function markEventApplied(
  workspace: string,
  eventId: string,
  resolution?: WaveEventResolution
): Promise<void> {
  const events = await readAllEvents(workspace);
  const updated = events.map((e) => {
    if (e.id !== eventId) return e;
    const result: WaveEvent = {
      ...e,
      status: "applied",
      applied_at: new Date().toISOString(),
    };
    if (resolution !== undefined) {
      result.resolution = resolution;
    }
    return result;
  });

  await atomicWriteEvents(workspace, updated);
}

/**
 * Mark an event as rejected with a reason.
 * Rewrites the entire events file atomically.
 */
export async function markEventRejected(
  workspace: string,
  eventId: string,
  reason: string
): Promise<void> {
  const events = await readAllEvents(workspace);
  const updated = events.map((e): WaveEvent => {
    if (e.id !== eventId) return e;
    return {
      ...e,
      status: "rejected",
      rejection_reason: reason,
    };
  });

  await atomicWriteEvents(workspace, updated);
}

/**
 * Pure lookup: returns which agents (if any) need to be spawned to handle
 * a given wave event type, along with per-agent spawn descriptions.
 */
export function resolveEventAgents(eventType: WaveEventType): {
  agents: string[];
  descriptions: Record<string, string>;
} {
  switch (eventType) {
    case "add_task":
      return {
        agents: ["canon-architect"],
        descriptions: {
          "canon-architect": "Break down the new task into a plan and slot it into INDEX.md",
        },
      };
    case "skip_task":
      return { agents: [], descriptions: {} };
    case "reprioritize":
      return {
        agents: ["canon-architect"],
        descriptions: {
          "canon-architect": "Validate dependency ordering after reprioritization",
        },
      };
    case "inject_context":
      // Researcher is optional; orchestrator decides
      return { agents: [], descriptions: {} };
    case "guidance":
      return {
        agents: ["canon-guide"],
        descriptions: {
          "canon-guide": "Interpret user guidance into actionable constraints for wave agents",
        },
      };
    case "pause":
      return { agents: [], descriptions: {} };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Write all events back to the JSONL file using a temp-then-rename pattern. */
async function atomicWriteEvents(workspace: string, events: WaveEvent[]): Promise<void> {
  const filePath = eventsPath(workspace);
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const content = events.map((e) => JSON.stringify(e)).join("\n") + (events.length > 0 ? "\n" : "");
  const tmpPath = filePath + ".tmp";

  try {
    await writeFile(tmpPath, content, "utf-8");
    // Rename is atomic on POSIX; on Windows it overwrites
    const { rename } = await import("fs/promises");
    await rename(tmpPath, filePath);
  } catch {
    // Best-effort — never crash on write failure
  }
}
