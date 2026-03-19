import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir, access } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { RalphStore } from "../drift/ralph-store.js";

describe("RalphStore", () => {
  let tmpDir: string;
  let store: RalphStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-ralph-store-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    store = new RalphStore(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function readJsonl<T>(filePath: string): Promise<T[]> {
    const content = await readFile(filePath, "utf-8");
    return content
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as T);
  }

  const makeEntry = (id: string) => ({
    loop_id: id,
    task_slug: "test-task",
    timestamp: "2026-03-16T00:00:00Z",
    iterations: [
      {
        iteration: 1,
        verdict: "WARNING" as const,
        violations_count: 3,
        violations_fixed: 2,
        cannot_fix: 0,
      },
      {
        iteration: 2,
        verdict: "CLEAN" as const,
        violations_count: 1,
        violations_fixed: 1,
        cannot_fix: 0,
      },
    ],
    final_verdict: "CLEAN" as const,
    converged: true,
    team: ["canon-reviewer", "canon-refactorer"],
  });

  it("appends and reads ralph loop entries", async () => {
    const entry = makeEntry("ralph_20260316_ab12");
    await store.appendLoop(entry);
    const loops = await store.getLoops();
    expect(loops).toHaveLength(1);
    expect(loops[0].loop_id).toBe("ralph_20260316_ab12");
    expect(loops[0].converged).toBe(true);
    expect(loops[0].iterations).toHaveLength(2);
  });

  it("returns empty array for nonexistent file", async () => {
    expect(await store.getLoops()).toEqual([]);
  });

  it("appends multiple entries", async () => {
    await store.appendLoop(makeEntry("ralph_1"));
    await store.appendLoop(makeEntry("ralph_2"));
    await store.appendLoop(makeEntry("ralph_3"));
    const loops = await store.getLoops();
    expect(loops).toHaveLength(3);
    expect(loops[2].loop_id).toBe("ralph_3");
  });

  it("rotates files exceeding 500 entries", async () => {
    const loopsPath = join(tmpDir, ".canon", "ralph-loops.jsonl");
    const archivePath = join(tmpDir, ".canon", "ralph-loops.archive.jsonl");

    const lines: string[] = [];
    for (let i = 0; i < 505; i++) {
      lines.push(JSON.stringify(makeEntry(`ralph_${i}`)));
    }
    await writeFile(loopsPath, lines.join("\n") + "\n", "utf-8");

    // Trigger rotation by appending
    await store.appendLoop(makeEntry("ralph_trigger"));

    const activeEntries = await readJsonl<any>(loopsPath);
    expect(activeEntries.length).toBe(500);
    expect(activeEntries[activeEntries.length - 1].loop_id).toBe(
      "ralph_trigger"
    );

    const archiveEntries = await readJsonl<any>(archivePath);
    expect(archiveEntries.length).toBe(6);
    expect(archiveEntries[0].loop_id).toBe("ralph_0");

    expect(activeEntries.length + archiveEntries.length).toBe(506);
  });

  it("does not rotate files at or below 500 entries", async () => {
    const loopsPath = join(tmpDir, ".canon", "ralph-loops.jsonl");
    const archivePath = join(tmpDir, ".canon", "ralph-loops.archive.jsonl");

    const lines: string[] = [];
    for (let i = 0; i < 499; i++) {
      lines.push(JSON.stringify(makeEntry(`ralph_${i}`)));
    }
    await writeFile(loopsPath, lines.join("\n") + "\n", "utf-8");

    await store.appendLoop(makeEntry("ralph_500"));

    const entries = await readJsonl<any>(loopsPath);
    expect(entries.length).toBe(500);
    await expect(access(archivePath)).rejects.toThrow();
  });
});
