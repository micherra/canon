/**
 * kg-community.test.ts
 *
 * Tests for detectCommunities() in kg-community.ts.
 * Uses in-memory SQLite via initDatabase().
 */

import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import type { FileRow } from "@graph/kg-types.ts";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { detectCommunities } from "../graph/kg-community.ts";

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

describe("detectCommunities", () => {
  let db: Database.Database;
  let store: KgStore;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
  });

  afterEach(() => {
    store.close();
  });

  test("empty adjacency list returns { communityCount: 0, filesAssigned: 0 }", () => {
    const result = detectCommunities(new Map(), store);
    expect(result).toEqual({ communityCount: 0, filesAssigned: 0 });
  });

  test("linear chain A->B->C produces at least one community", () => {
    // Insert 3 files
    const fileA = store.upsertFile(makeFileRow({ path: "src/A.ts" }));
    const fileB = store.upsertFile(makeFileRow({ path: "src/B.ts" }));
    const fileC = store.upsertFile(makeFileRow({ path: "src/C.ts" }));

    const idA = fileA.file_id!;
    const idB = fileB.file_id!;
    const idC = fileC.file_id!;

    // A->B->C adjacency
    const adjacencyList = new Map<number, number[]>([
      [idA, [idB]],
      [idB, [idC]],
    ]);

    const result = detectCommunities(adjacencyList, store);

    expect(result.communityCount).toBeGreaterThanOrEqual(1);
    expect(result.filesAssigned).toBe(3);
  });

  test("two disconnected clusters produce >= 2 communities", () => {
    // Cluster 1: A <-> B (fully connected within cluster)
    // Cluster 2: C <-> D (fully connected within cluster)
    const fileA = store.upsertFile(makeFileRow({ path: "src/A.ts" }));
    const fileB = store.upsertFile(makeFileRow({ path: "src/B.ts" }));
    const fileC = store.upsertFile(makeFileRow({ path: "src/C.ts" }));
    const fileD = store.upsertFile(makeFileRow({ path: "src/D.ts" }));

    const idA = fileA.file_id!;
    const idB = fileB.file_id!;
    const idC = fileC.file_id!;
    const idD = fileD.file_id!;

    const adjacencyList = new Map<number, number[]>([
      [idA, [idB]],
      [idB, [idA]],
      [idC, [idD]],
      [idD, [idC]],
    ]);

    const result = detectCommunities(adjacencyList, store);

    expect(result.communityCount).toBeGreaterThanOrEqual(2);
    expect(result.filesAssigned).toBe(4);
  });

  test("community IDs are written to files table via store.updateCommunityId", () => {
    const fileA = store.upsertFile(makeFileRow({ path: "src/A.ts" }));
    const fileB = store.upsertFile(makeFileRow({ path: "src/B.ts" }));

    const idA = fileA.file_id!;
    const idB = fileB.file_id!;

    const adjacencyList = new Map<number, number[]>([[idA, [idB]]]);

    detectCommunities(adjacencyList, store);

    // After detection, query files table to check community_id is set
    const rowA = db.prepare("SELECT community_id FROM files WHERE file_id = ?").get(idA) as
      | { community_id: number | null }
      | undefined;
    const rowB = db.prepare("SELECT community_id FROM files WHERE file_id = ?").get(idB) as
      | { community_id: number | null }
      | undefined;

    expect(rowA?.community_id).not.toBeNull();
    expect(rowB?.community_id).not.toBeNull();
    // Both should be numbers
    expect(typeof rowA?.community_id).toBe("number");
    expect(typeof rowB?.community_id).toBe("number");
  });

  test("updateCommunityId is called once per node in the graph", () => {
    const fileA = store.upsertFile(makeFileRow({ path: "src/A.ts" }));
    const fileB = store.upsertFile(makeFileRow({ path: "src/B.ts" }));
    const fileC = store.upsertFile(makeFileRow({ path: "src/C.ts" }));

    const idA = fileA.file_id!;
    const idB = fileB.file_id!;
    const idC = fileC.file_id!;

    const spy = vi.spyOn(store, "updateCommunityId");

    const adjacencyList = new Map<number, number[]>([
      [idA, [idB]],
      [idB, [idC]],
    ]);

    detectCommunities(adjacencyList, store);

    // 3 nodes: A, B, C
    expect(spy).toHaveBeenCalledTimes(3);
  });

  test("stale community_id is cleared when file is absent from subsequent adjacency list", () => {
    // First run: A and B are connected — both get a community_id.
    const fileA = store.upsertFile(makeFileRow({ path: "src/A.ts" }));
    const fileB = store.upsertFile(makeFileRow({ path: "src/B.ts" }));

    const idA = fileA.file_id!;
    const idB = fileB.file_id!;

    detectCommunities(new Map([[idA, [idB]]]), store);

    // Confirm both files have a community_id after the first run.
    const afterFirst = (fileId: number) =>
      (
        db.prepare("SELECT community_id FROM files WHERE file_id = ?").get(fileId) as
          | {
              community_id: number | null;
            }
          | undefined
      )?.community_id;

    expect(afterFirst(idA)).not.toBeNull();
    expect(afterFirst(idB)).not.toBeNull();

    // Second run: only A is in the adjacency list (B has become isolated).
    // B's stale community_id should be cleared.
    detectCommunities(new Map([[idA, []]]), store);

    // A is still in the graph (sole node) — it gets a fresh community_id.
    expect(afterFirst(idA)).not.toBeNull();
    // B is no longer in the graph — its community_id must be NULL.
    expect(afterFirst(idB)).toBeNull();
  });
});
