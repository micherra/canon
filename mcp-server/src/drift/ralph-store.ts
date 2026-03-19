import { join } from "path";
import type { RalphLoopEntry } from "../schema.js";
import { readJsonl, appendJsonl, rotateIfNeeded } from "./jsonl-store.js";

export class RalphStore {
  private loopsPath: string;

  constructor(projectDir: string) {
    this.loopsPath = join(projectDir, ".canon", "ralph-loops.jsonl");
  }

  async getLoops(): Promise<RalphLoopEntry[]> {
    return readJsonl<RalphLoopEntry>(this.loopsPath);
  }

  async appendLoop(entry: RalphLoopEntry): Promise<void> {
    await appendJsonl(this.loopsPath, entry);
    await rotateIfNeeded(this.loopsPath);
  }
}
