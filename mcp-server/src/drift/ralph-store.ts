import { join } from "path";
import type { RalphLoopEntry } from "../schema.js";
import { readJsonl, appendJsonl, rotateIfNeeded } from "./jsonl-store.js";
import { CANON_DIR } from "../constants.js";

export class RalphStore {
  private loopsPath: string;

  constructor(projectDir: string) {
    this.loopsPath = join(projectDir, CANON_DIR, "ralph-loops.jsonl");
  }

  async getLoops(): Promise<RalphLoopEntry[]> {
    return readJsonl<RalphLoopEntry>(this.loopsPath);
  }

  async appendLoop(entry: RalphLoopEntry): Promise<void> {
    await appendJsonl(this.loopsPath, entry);
    await rotateIfNeeded(this.loopsPath);
  }
}
