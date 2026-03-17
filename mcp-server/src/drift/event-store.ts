import { join } from "path";
import type { OrchestrationEvent } from "../schema.js";
import { readJsonl, appendJsonl, rotateIfNeeded } from "./jsonl-store.js";

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
