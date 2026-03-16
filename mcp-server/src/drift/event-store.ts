import { readFile, writeFile, appendFile, mkdir } from "fs/promises";
import { dirname, join } from "path";
import type { OrchestrationEvent } from "../schema.js";

const MAX_ENTRIES = 500;

async function readJsonl<T>(filePath: string): Promise<T[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return [];
  }

  const results: T[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    try {
      results.push(JSON.parse(line) as T);
    } catch {
      // skip malformed
    }
  }
  return results;
}

async function appendJsonl<T>(filePath: string, entry: T): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  await appendFile(filePath, JSON.stringify(entry) + "\n", "utf-8");
}

async function rotateIfNeeded(filePath: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return;
  }

  const lines = content.split("\n").filter((l) => l.trim() !== "");
  if (lines.length <= MAX_ENTRIES) return;

  const archiveLines = lines.slice(0, lines.length - MAX_ENTRIES);
  const keepLines = lines.slice(lines.length - MAX_ENTRIES);

  const archivePath = filePath.replace(/\.jsonl$/, ".archive.jsonl");
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  await appendFile(archivePath, archiveLines.join("\n") + "\n", "utf-8");
  await writeFile(filePath, keepLines.join("\n") + "\n", "utf-8");
}

export class EventStore {
  private eventsPath: string;

  constructor(projectDir: string) {
    this.eventsPath = join(projectDir, ".canon", "orchestration-events.jsonl");
  }

  async getEvents(filter?: {
    task_slug?: string;
    since?: string;
  }): Promise<OrchestrationEvent[]> {
    const events = await readJsonl<OrchestrationEvent>(this.eventsPath);
    if (!filter) return events;

    return events.filter((e) => {
      if (filter.task_slug && e.task_slug !== filter.task_slug) return false;
      if (filter.since && e.timestamp < filter.since) return false;
      return true;
    });
  }

  async appendEvent(event: OrchestrationEvent): Promise<void> {
    await appendJsonl(this.eventsPath, event);
    await rotateIfNeeded(this.eventsPath);
  }
}
