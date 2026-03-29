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

  it("returns empty array for nonexistent reviews file", async () => {
    expect(await store.getReviews()).toEqual([]);
  });

  it("rotates reviews.jsonl exceeding 500 entries", async () => {
    const reviewsPath = join(tmpDir, ".canon", "reviews.jsonl");
    const archivePath = join(tmpDir, ".canon", "reviews.archive.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 510; i++) {
      lines.push(
        JSON.stringify({
          review_id: `rev_${i}`,
          files: ["src/foo.ts"],
          violations: [],
          honored: ["p1"],
          score: { rules: { passed: 1, total: 1 }, opinions: { passed: 0, total: 0 }, conventions: { passed: 0, total: 0 } },
          verdict: "CLEAN",
          timestamp: "2026-03-15T00:00:00Z",
        })
      );
    }
    await writeFile(reviewsPath, lines.join("\n") + "\n", "utf-8");

    // Trigger rotation by appending one more
    await store.appendReview({
      review_id: "rev_trigger",
      files: ["src/bar.ts"],
      violations: [],
      honored: [],
      score: { rules: { passed: 1, total: 1 }, opinions: { passed: 0, total: 0 }, conventions: { passed: 0, total: 0 } },
      verdict: "CLEAN",
      timestamp: "2026-03-15T00:00:00Z",
    });

    // Active file should have exactly 500 most-recent entries
    const activeEntries = await readJsonl<any>(reviewsPath);
    expect(activeEntries.length).toBe(500);

    // The active file's first entry should be entry 11 (the 500 most recent of 511)
    expect(activeEntries[0].review_id).toBe("rev_11");
    // The active file's last entry should be the trigger entry
    expect(activeEntries[activeEntries.length - 1].review_id).toBe("rev_trigger");

    // Archive file should exist with the 11 oldest entries
    const archiveEntries = await readJsonl<any>(archivePath);
    expect(archiveEntries.length).toBe(11);
    expect(archiveEntries[0].review_id).toBe("rev_0");
    expect(archiveEntries[archiveEntries.length - 1].review_id).toBe("rev_10");

    // Total entries preserved: no data loss
    expect(activeEntries.length + archiveEntries.length).toBe(511);
  });

  it("does not rotate reviews.jsonl at or below 500 entries", async () => {
    const reviewsPath = join(tmpDir, ".canon", "reviews.jsonl");
    const archivePath = join(tmpDir, ".canon", "reviews.archive.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 499; i++) {
      lines.push(
        JSON.stringify({
          review_id: `rev_${i}`,
          files: ["src/foo.ts"],
          violations: [],
          honored: [],
          score: { rules: { passed: 1, total: 1 }, opinions: { passed: 0, total: 0 }, conventions: { passed: 0, total: 0 } },
          verdict: "CLEAN",
          timestamp: "2026-03-15T00:00:00Z",
        })
      );
    }
    await writeFile(reviewsPath, lines.join("\n") + "\n", "utf-8");

    // Append one more (total = 500, should not rotate)
    await store.appendReview({
      review_id: "rev_500",
      files: ["src/bar.ts"],
      violations: [],
      honored: [],
      score: { rules: { passed: 1, total: 1 }, opinions: { passed: 0, total: 0 }, conventions: { passed: 0, total: 0 } },
      verdict: "CLEAN",
      timestamp: "2026-03-15T00:00:00Z",
    });

    const entries = await readJsonl<any>(reviewsPath);
    expect(entries.length).toBe(500);

    // No archive file should exist
    await expect(access(archivePath)).rejects.toThrow();
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
});
