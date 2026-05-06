/**
 * kg-store.test.ts
 *
 * Tests for new KgStore methods added in schema v5:
 * upsertFileTag, deleteFileTagsByFile, getFileTagsByFileId,
 * bulkUpsertFileTags, updateCommunityId.
 */

import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import type { FileRow } from "@graph/kg-types.ts";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

// --- Setup helpers ---

function makeFileRow(overrides: Partial<Omit<FileRow, "file_id">> = {}): Omit<FileRow, "file_id"> {
  return {
    content_hash: "abc123",
    language: "typescript",
    last_indexed_at: Date.now(),
    layer: "domain",
    mtime_ms: 1700000000000,
    path: "src/A.ts",
    ...overrides,
  };
}

describe("KgStore — file_tags CRUD (schema v5)", () => {
  let db: Database.Database;
  let store: KgStore;
  let file: FileRow;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
    file = store.upsertFile(makeFileRow());
  });

  afterEach(() => {
    store.close();
  });

  // --- upsertFileTag ---

  test("upsertFileTag inserts a tag and getFileTagsByFileId returns it", () => {
    store.upsertFileTag({
      confidence: 0.9,
      file_id: file.file_id!,
      source: "louvain",
      tag: "backend",
    });

    const tags = store.getFileTagsByFileId(file.file_id!);
    expect(tags).toHaveLength(1);
    expect(tags[0]?.tag).toBe("backend");
    expect(tags[0]?.source).toBe("louvain");
    expect(tags[0]?.confidence).toBeCloseTo(0.9);
  });

  test("upsertFileTag with same (file_id, tag) replaces existing row", () => {
    store.upsertFileTag({
      confidence: 0.5,
      file_id: file.file_id!,
      source: "louvain",
      tag: "backend",
    });
    store.upsertFileTag({
      confidence: 0.95,
      file_id: file.file_id!,
      source: "manual",
      tag: "backend",
    });

    const tags = store.getFileTagsByFileId(file.file_id!);
    expect(tags).toHaveLength(1);
    expect(tags[0]?.confidence).toBeCloseTo(0.95);
    expect(tags[0]?.source).toBe("manual");
  });

  // --- deleteFileTagsByFile ---

  test("deleteFileTagsByFile removes all tags for a file", () => {
    store.upsertFileTag({
      confidence: 1.0,
      file_id: file.file_id!,
      source: "louvain",
      tag: "backend",
    });
    store.upsertFileTag({
      confidence: 1.0,
      file_id: file.file_id!,
      source: "louvain",
      tag: "api",
    });

    store.deleteFileTagsByFile(file.file_id!);

    const tags = store.getFileTagsByFileId(file.file_id!);
    expect(tags).toHaveLength(0);
  });

  test("deleteFileTagsByFile on file with no tags is a no-op", () => {
    expect(() => store.deleteFileTagsByFile(file.file_id!)).not.toThrow();
    expect(store.getFileTagsByFileId(file.file_id!)).toHaveLength(0);
  });

  // --- getFileTagsByFileId ---

  test("getFileTagsByFileId returns empty array for file with no tags", () => {
    const tags = store.getFileTagsByFileId(file.file_id!);
    expect(tags).toEqual([]);
  });

  test("getFileTagsByFileId returns empty array for nonexistent file_id", () => {
    const tags = store.getFileTagsByFileId(99999);
    expect(tags).toEqual([]);
  });

  test("getFileTagsByFileId returns only tags for the specified file", () => {
    const fileB = store.upsertFile(makeFileRow({ path: "src/B.ts" }));

    store.upsertFileTag({
      confidence: 1.0,
      file_id: file.file_id!,
      source: "louvain",
      tag: "alpha",
    });
    store.upsertFileTag({
      confidence: 1.0,
      file_id: fileB.file_id!,
      source: "louvain",
      tag: "beta",
    });

    const tagsA = store.getFileTagsByFileId(file.file_id!);
    const tagsB = store.getFileTagsByFileId(fileB.file_id!);

    expect(tagsA).toHaveLength(1);
    expect(tagsA[0]?.tag).toBe("alpha");
    expect(tagsB).toHaveLength(1);
    expect(tagsB[0]?.tag).toBe("beta");
  });

  // --- bulkUpsertFileTags ---

  test("bulkUpsertFileTags inserts multiple tags in a transaction", () => {
    store.bulkUpsertFileTags([
      { confidence: 0.8, file_id: file.file_id!, source: "louvain", tag: "api" },
      { confidence: 0.9, file_id: file.file_id!, source: "louvain", tag: "auth" },
      { confidence: 0.7, file_id: file.file_id!, source: "louvain", tag: "db" },
    ]);

    const tags = store.getFileTagsByFileId(file.file_id!);
    expect(tags).toHaveLength(3);
    const tagNames = tags.map((t) => t.tag).sort();
    expect(tagNames).toEqual(["api", "auth", "db"]);
  });

  test("bulkUpsertFileTags with empty array is a no-op", () => {
    expect(() => store.bulkUpsertFileTags([])).not.toThrow();
    expect(store.getFileTagsByFileId(file.file_id!)).toHaveLength(0);
  });

  test("bulkUpsertFileTags replaces existing tags", () => {
    store.upsertFileTag({ confidence: 0.5, file_id: file.file_id!, source: "old", tag: "api" });

    store.bulkUpsertFileTags([
      { confidence: 0.99, file_id: file.file_id!, source: "new", tag: "api" },
    ]);

    const tags = store.getFileTagsByFileId(file.file_id!);
    expect(tags).toHaveLength(1);
    expect(tags[0]?.confidence).toBeCloseTo(0.99);
    expect(tags[0]?.source).toBe("new");
  });

  // --- updateCommunityId ---

  test("updateCommunityId sets community_id on a file row", () => {
    store.updateCommunityId(file.file_id!, 42);

    const updated = db
      .prepare(`SELECT community_id FROM files WHERE file_id = ?`)
      .get(file.file_id!) as { community_id: number | null };
    expect(updated.community_id).toBe(42);
  });

  test("updateCommunityId can update community_id to a different value", () => {
    store.updateCommunityId(file.file_id!, 1);
    store.updateCommunityId(file.file_id!, 99);

    const updated = db
      .prepare(`SELECT community_id FROM files WHERE file_id = ?`)
      .get(file.file_id!) as { community_id: number | null };
    expect(updated.community_id).toBe(99);
  });

  test("updateCommunityId on nonexistent file_id is a no-op", () => {
    // Should not throw for a missing file
    expect(() => store.updateCommunityId(99999, 1)).not.toThrow();
  });
});
