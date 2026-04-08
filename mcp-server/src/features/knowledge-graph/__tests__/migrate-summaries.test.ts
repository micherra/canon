/**
 * migrate-summaries.ts — unit tests
 *
 * Uses a temp directory for each test case. No in-memory DB trick needed since
 * the KG DB is initialized with initDatabase() which supports `:memory:` only
 * when called directly — here we use a real temp file path so migrations can
 * also rename the source file.
 */

import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSummaries } from "@features/knowledge-graph/services/migrate-summaries.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(
    tmpdir(),
    `migrate-summaries-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(join(tmpDir, ".canon"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { force: true, recursive: true });
});

// ---- helpers ----

function summariesPath(): string {
  return join(tmpDir, ".canon", "summaries.json");
}

function migratedPath(): string {
  return `${summariesPath()}.migrated`;
}

async function writeSummariesJson(content: unknown): Promise<void> {
  await writeFile(summariesPath(), JSON.stringify(content), "utf-8");
}

// ---- tests ----

describe("migrateSummaries", () => {
  test("returns null when summaries.json does not exist", async () => {
    const result = await migrateSummaries(tmpDir);
    expect(result).toBeNull();
  });

  test("migrates entries and renames file to .migrated", async () => {
    await writeSummariesJson({
      "src/bar.ts": { summary: "does the bar thing" },
      "src/foo.ts": { summary: "does the foo thing", updated_at: "2024-01-01T00:00:00.000Z" },
    });

    const result = await migrateSummaries(tmpDir);

    expect(result).not.toBeNull();
    expect(result?.migrated).toBe(2);
    expect(result?.skipped).toBe(0);

    // Original file renamed to .migrated
    expect(existsSync(summariesPath())).toBe(false);
    expect(existsSync(migratedPath())).toBe(true);

    // Summaries written to DB
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    try {
      const fooFile = store.getFile("src/foo.ts");
      expect(fooFile).toBeDefined();
      expect(fooFile?.file_id).toBeDefined();
      const fooSummary = store.getSummaryByFile(fooFile!.file_id!);
      expect(fooSummary?.summary).toBe("does the foo thing");

      const barFile = store.getFile("src/bar.ts");
      expect(barFile).toBeDefined();
      const barSummary = store.getSummaryByFile(barFile!.file_id!);
      expect(barSummary?.summary).toBe("does the bar thing");
    } finally {
      db.close();
    }
  });

  test("supports plain string values in legacy format", async () => {
    await writeSummariesJson({
      "src/plain.ts": "plain string summary",
    });

    const result = await migrateSummaries(tmpDir);

    expect(result?.migrated).toBe(1);
    expect(result?.skipped).toBe(0);

    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    try {
      const fileRow = store.getFile("src/plain.ts");
      const summaryRow = store.getSummaryByFile(fileRow!.file_id!);
      expect(summaryRow?.summary).toBe("plain string summary");
    } finally {
      db.close();
    }
  });

  test("returns null (does not throw) when file is malformed JSON", async () => {
    await writeFile(summariesPath(), "{ this is not valid json }", "utf-8");

    const result = await migrateSummaries(tmpDir);

    expect(result).toBeNull();
    // Original file not renamed — migration was aborted
    expect(existsSync(summariesPath())).toBe(true);
    expect(existsSync(migratedPath())).toBe(false);
  });

  test("skips entries that already exist in DB", async () => {
    // Pre-populate DB with a summary for src/existing.ts
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    const fileRow = store.upsertFile({
      content_hash: "abc",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "domain",
      mtime_ms: Date.now(),
      path: "src/existing.ts",
    });
    store.upsertSummary({
      content_hash: fileRow.content_hash,
      entity_id: null,
      file_id: fileRow.file_id!,
      model: null,
      scope: "file",
      summary: "original summary",
      updated_at: new Date().toISOString(),
    });
    db.close();

    await writeSummariesJson({
      "src/existing.ts": { summary: "new summary from json" },
      "src/new.ts": { summary: "brand new file" },
    });

    const result = await migrateSummaries(tmpDir);

    expect(result?.migrated).toBe(1);
    expect(result?.skipped).toBe(1);

    // Existing entry should NOT be overwritten
    const db2 = initDatabase(dbPath);
    const store2 = new KgStore(db2);
    try {
      const existingFile = store2.getFile("src/existing.ts");
      const existingSummary = store2.getSummaryByFile(existingFile!.file_id!);
      expect(existingSummary?.summary).toBe("original summary");

      // New entry should be written
      const newFile = store2.getFile("src/new.ts");
      const newSummary = store2.getSummaryByFile(newFile!.file_id!);
      expect(newSummary?.summary).toBe("brand new file");
    } finally {
      db2.close();
    }
  });

  test("returns null (does not throw) when an unexpected error occurs", async () => {
    // Write a valid summaries.json but make the DB directory unwritable by
    // writing a file where the DB should be. The KgStore init will fail.
    await writeSummariesJson({ "src/a.ts": { summary: "hello" } });
    // Write a plain file at the DB path so initDatabase fails to open it properly
    await writeFile(join(tmpDir, ".canon", "knowledge-graph.db"), "not a real sqlite db", "utf-8");

    // Should return null, not throw
    await expect(migrateSummaries(tmpDir)).resolves.toBeNull();
  });
});
