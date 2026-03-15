import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { DriftStore } from "../drift/store.js";

describe("DriftStore", () => {
  let tmpDir: string;
  let store: DriftStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-store-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
    store = new DriftStore(tmpDir);
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

  it("appends and reads decisions", async () => {
    const entry = {
      decision_id: "dec_20260315_ab12",
      principle_id: "p1",
      file_path: "src/foo.ts",
      justification: "test",
      timestamp: "2026-03-15T00:00:00Z",
    };
    await store.appendDecision(entry as any);
    const decisions = await store.getDecisions();
    expect(decisions).toHaveLength(1);
    expect(decisions[0].principle_id).toBe("p1");
  });

  it("appends and reads patterns", async () => {
    const entry = {
      pattern_id: "pat_20260315_ab12",
      pattern: "Early returns",
      file_paths: ["src/a.ts"],
      context: "",
      timestamp: "2026-03-15T00:00:00Z",
    };
    await store.appendPattern(entry as any);
    const patterns = await store.getPatterns();
    expect(patterns).toHaveLength(1);
    expect(patterns[0].pattern).toBe("Early returns");
  });

  it("appends and reads reviews", async () => {
    const entry = {
      review_id: "rev_20260315_ab12",
      files: ["src/a.ts"],
      violations: [],
      honored: ["p1"],
      score: {
        rules: { passed: 1, total: 1 },
        opinions: { passed: 0, total: 0 },
        conventions: { passed: 0, total: 0 },
      },
      verdict: "CLEAN",
      timestamp: "2026-03-15T00:00:00Z",
    };
    await store.appendReview(entry as any);
    const reviews = await store.getReviews();
    expect(reviews).toHaveLength(1);
    expect(reviews[0].verdict).toBe("CLEAN");
  });

  it("returns empty arrays for nonexistent files", async () => {
    expect(await store.getDecisions()).toEqual([]);
    expect(await store.getPatterns()).toEqual([]);
    expect(await store.getReviews()).toEqual([]);
  });

  it("rotates files exceeding 500 entries", async () => {
    // Write 510 lines directly to decisions.jsonl
    const decisionsPath = join(tmpDir, ".canon", "decisions.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 510; i++) {
      lines.push(
        JSON.stringify({
          decision_id: `dec_${i}`,
          principle_id: "p1",
          file_path: "src/foo.ts",
          justification: `entry ${i}`,
          timestamp: "2026-03-15T00:00:00Z",
        })
      );
    }
    await writeFile(decisionsPath, lines.join("\n") + "\n", "utf-8");

    // Trigger rotation by appending one more
    await store.appendDecision({
      decision_id: "dec_trigger",
      principle_id: "p1",
      file_path: "src/bar.ts",
      justification: "trigger rotation",
      timestamp: "2026-03-15T00:00:00Z",
    } as any);

    // Active file should have <= 500 entries
    const activeEntries = await readJsonl(decisionsPath);
    expect(activeEntries.length).toBeLessThanOrEqual(500);

    // Archive file should exist with the overflow
    const archivePath = join(tmpDir, ".canon", "decisions.archive.jsonl");
    const archiveEntries = await readJsonl(archivePath);
    expect(archiveEntries.length).toBeGreaterThan(0);

    // Total should be preserved
    expect(activeEntries.length + archiveEntries.length).toBe(511);
  });

  it("does not rotate files at or below 500 entries", async () => {
    const decisionsPath = join(tmpDir, ".canon", "decisions.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 499; i++) {
      lines.push(
        JSON.stringify({
          decision_id: `dec_${i}`,
          principle_id: "p1",
          file_path: "src/foo.ts",
          justification: `entry ${i}`,
          timestamp: "2026-03-15T00:00:00Z",
        })
      );
    }
    await writeFile(decisionsPath, lines.join("\n") + "\n", "utf-8");

    // Append one more (total = 500, should not rotate)
    await store.appendDecision({
      decision_id: "dec_500",
      principle_id: "p1",
      file_path: "src/bar.ts",
      justification: "entry 500",
      timestamp: "2026-03-15T00:00:00Z",
    } as any);

    const entries = await readJsonl(decisionsPath);
    expect(entries.length).toBe(500);

    // No archive file should exist
    const archivePath = join(tmpDir, ".canon", "decisions.archive.jsonl");
    await expect(readFile(archivePath, "utf-8")).rejects.toThrow();
  });
});
