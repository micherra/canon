import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir, access } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { DriftStore } from "../drift/store.ts";
import { report } from "../tools/report.ts";

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
    const archivePath = join(tmpDir, ".canon", "decisions.archive.jsonl");
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

    // Active file should have exactly 500 most-recent entries
    const activeEntries = await readJsonl<any>(decisionsPath);
    expect(activeEntries.length).toBe(500);

    // The active file's first entry should be entry 11 (the 500 most recent of 511)
    expect(activeEntries[0].decision_id).toBe("dec_11");
    // The active file's last entry should be the trigger entry
    expect(activeEntries[activeEntries.length - 1].decision_id).toBe(
      "dec_trigger"
    );

    // Archive file should exist with the 11 oldest entries
    const archiveEntries = await readJsonl<any>(archivePath);
    expect(archiveEntries.length).toBe(11);
    expect(archiveEntries[0].decision_id).toBe("dec_0");
    expect(archiveEntries[archiveEntries.length - 1].decision_id).toBe(
      "dec_10"
    );

    // Total entries preserved: no data loss
    expect(activeEntries.length + archiveEntries.length).toBe(511);
  });

  it("does not rotate files at or below 500 entries", async () => {
    const decisionsPath = join(tmpDir, ".canon", "decisions.jsonl");
    const archivePath = join(tmpDir, ".canon", "decisions.archive.jsonl");
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

    const entries = await readJsonl<any>(decisionsPath);
    expect(entries.length).toBe(500);

    // No archive file should exist
    await expect(access(archivePath)).rejects.toThrow();
  });

  it("appends to existing archive on subsequent rotations", async () => {
    const decisionsPath = join(tmpDir, ".canon", "decisions.jsonl");
    const archivePath = join(tmpDir, ".canon", "decisions.archive.jsonl");

    // Seed archive with 5 pre-existing entries
    const archiveLines: string[] = [];
    for (let i = 0; i < 5; i++) {
      archiveLines.push(
        JSON.stringify({
          decision_id: `old_${i}`,
          principle_id: "p1",
          file_path: "src/old.ts",
          justification: `old entry ${i}`,
          timestamp: "2026-01-01T00:00:00Z",
        })
      );
    }
    await writeFile(archivePath, archiveLines.join("\n") + "\n", "utf-8");

    // Write 502 entries to active file
    const lines: string[] = [];
    for (let i = 0; i < 502; i++) {
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

    // Trigger rotation
    await store.appendDecision({
      decision_id: "dec_new",
      principle_id: "p1",
      file_path: "src/bar.ts",
      justification: "new",
      timestamp: "2026-03-15T00:00:00Z",
    } as any);

    const activeEntries = await readJsonl<any>(decisionsPath);
    expect(activeEntries.length).toBe(500);

    // Archive should have original 5 + 3 rotated out = 8
    const allArchive = await readJsonl<any>(archivePath);
    expect(allArchive.length).toBe(8);
    // Original entries preserved at the start
    expect(allArchive[0].decision_id).toBe("old_0");
    // New rotated entries appended after
    expect(allArchive[5].decision_id).toBe("dec_0");
  });
});

describe("rotation via report() end-to-end", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-rotation-e2e-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
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

  it("rotates reviews.jsonl after 501 report() calls", async () => {
    const reviewsPath = join(tmpDir, ".canon", "reviews.jsonl");
    const archivePath = join(tmpDir, ".canon", "reviews.archive.jsonl");

    // Seed 500 reviews via direct write (to keep test fast)
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(
        JSON.stringify({
          review_id: `rev_seed_${i}`,
          files: [`src/file_${i}.ts`],
          violations: [],
          honored: ["p1"],
          score: {
            rules: { passed: 1, total: 1 },
            opinions: { passed: 0, total: 0 },
            conventions: { passed: 0, total: 0 },
          },
          verdict: "CLEAN",
          timestamp: `2026-03-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`,
        })
      );
    }
    await writeFile(reviewsPath, lines.join("\n") + "\n", "utf-8");

    // Now call report() to add the 501st entry — this triggers rotation
    const result = await report(
      {
        type: "review",
        files: ["src/trigger.ts"],
        violations: [{ principle_id: "p-final", severity: "rule" }],
        honored: [],
        score: {
          rules: { passed: 0, total: 1 },
          opinions: { passed: 0, total: 0 },
          conventions: { passed: 0, total: 0 },
        },
      },
      tmpDir
    );

    expect(result.recorded).toBe(true);

    // Active file: exactly 500 most-recent entries
    const activeEntries = await readJsonl<any>(reviewsPath);
    expect(activeEntries.length).toBe(500);

    // The last active entry should be the one we just reported
    const lastActive = activeEntries[activeEntries.length - 1];
    expect(lastActive.review_id).toBe(result.id);
    expect(lastActive.files).toEqual(["src/trigger.ts"]);
    expect(lastActive.verdict).toBe("BLOCKING");

    // Archive file exists with the 1 oldest entry
    const archiveEntries = await readJsonl<any>(archivePath);
    expect(archiveEntries.length).toBe(1);
    expect(archiveEntries[0].review_id).toBe("rev_seed_0");

    // Zero data loss
    expect(activeEntries.length + archiveEntries.length).toBe(501);
  });

  it("rotates patterns.jsonl through report()", async () => {
    const patternsPath = join(tmpDir, ".canon", "patterns.jsonl");
    const archivePath = join(tmpDir, ".canon", "patterns.archive.jsonl");

    // Seed 503 patterns
    const lines: string[] = [];
    for (let i = 0; i < 503; i++) {
      lines.push(
        JSON.stringify({
          pattern_id: `pat_seed_${i}`,
          pattern: `pattern ${i}`,
          file_paths: ["src/a.ts"],
          context: "",
          timestamp: "2026-03-15T00:00:00Z",
        })
      );
    }
    await writeFile(patternsPath, lines.join("\n") + "\n", "utf-8");

    // Add the 504th via report()
    await report(
      {
        type: "pattern",
        pattern: "the final pattern",
        file_paths: ["src/final.ts"],
      },
      tmpDir
    );

    const activeEntries = await readJsonl<any>(patternsPath);
    expect(activeEntries.length).toBe(500);

    // Last entry is the one we reported
    expect(activeEntries[activeEntries.length - 1].pattern).toBe(
      "the final pattern"
    );

    // Archive has the 4 oldest
    const archiveEntries = await readJsonl<any>(archivePath);
    expect(archiveEntries.length).toBe(4);
    expect(archiveEntries[0].pattern_id).toBe("pat_seed_0");
    expect(archiveEntries[3].pattern_id).toBe("pat_seed_3");

    // Total preserved
    expect(activeEntries.length + archiveEntries.length).toBe(504);
  });
});
