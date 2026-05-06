/**
 * kg-tags.test.ts
 *
 * Tests for the 4-signal tag propagation functions in kg-tags.ts:
 *   computeDirectoryTags, computeImportDerivedTags, computeGraphRoleTags,
 *   computeCommunityDerivedTags, propagateAllTags
 */

import { KgQuery } from "@graph/kg-query.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import type { FileEdgeRow, FileRow } from "@graph/kg-types.ts";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  computeCommunityDerivedTags,
  computeDirectoryTags,
  computeGraphRoleTags,
  computeImportDerivedTags,
  propagateAllTags,
} from "../graph/kg-tags.ts";

// --- Helpers ---

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

function makeFileEdgeRow(
  overrides: Partial<Omit<FileEdgeRow, "file_edge_id">> = {},
): Omit<FileEdgeRow, "file_edge_id"> {
  return {
    confidence: 1.0,
    edge_type: "imports",
    evidence: null,
    relation: null,
    source_file_id: 0,
    target_file_id: 0,
    ...overrides,
  };
}

describe("computeDirectoryTags", () => {
  let db: Database.Database;
  let store: KgStore;
  let query: KgQuery;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
    query = new KgQuery(db);
  });

  afterEach(() => {
    store.close();
  });

  test("file in graph/ directory gets graph-infrastructure tag", () => {
    store.upsertFile(makeFileRow({ path: "src/graph/kg-query.ts" }));

    const tags = computeDirectoryTags(query);
    const graphTag = tags.find((t) => t.tag === "graph-infrastructure" && t.source === "directory");
    expect(graphTag).toBeDefined();
    expect(graphTag?.confidence).toBe(1.0);
  });

  test("file in features/orchestration/ directory gets orchestration tag", () => {
    store.upsertFile(makeFileRow({ path: "src/features/orchestration/drive-flow.ts" }));

    const tags = computeDirectoryTags(query);
    const orchTag = tags.find((t) => t.tag === "orchestration");
    expect(orchTag).toBeDefined();
  });

  test("file in features/principles/ directory gets principles tag", () => {
    store.upsertFile(makeFileRow({ path: "src/features/principles/get-principles.ts" }));

    const tags = computeDirectoryTags(query);
    const principlesTag = tags.find((t) => t.tag === "principles");
    expect(principlesTag).toBeDefined();
  });

  test("file in platform/ directory gets infrastructure tag", () => {
    store.upsertFile(makeFileRow({ path: "src/platform/adapters/git-adapter.ts" }));

    const tags = computeDirectoryTags(query);
    const infraTag = tags.find((t) => t.tag === "infrastructure");
    expect(infraTag).toBeDefined();
  });

  test("file in shared/ directory gets shared-kernel tag", () => {
    store.upsertFile(makeFileRow({ path: "src/shared/constants.ts" }));

    const tags = computeDirectoryTags(query);
    const sharedTag = tags.find((t) => t.tag === "shared-kernel");
    expect(sharedTag).toBeDefined();
  });

  test("file in ui/ directory gets frontend tag", () => {
    store.upsertFile(makeFileRow({ path: "src/ui/components/App.svelte" }));

    const tags = computeDirectoryTags(query);
    const frontendTag = tags.find((t) => t.tag === "frontend");
    expect(frontendTag).toBeDefined();
  });

  test("file with no matching directory pattern produces no tags", () => {
    store.upsertFile(makeFileRow({ path: "src/main.ts" }));

    const tags = computeDirectoryTags(query);
    expect(tags).toHaveLength(0);
  });

  test("returns empty array when no files in database", () => {
    const tags = computeDirectoryTags(query);
    expect(tags).toHaveLength(0);
  });
});

describe("computeImportDerivedTags", () => {
  let db: Database.Database;
  let store: KgStore;
  let query: KgQuery;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
    query = new KgQuery(db);
  });

  afterEach(() => {
    store.close();
  });

  test("file importing from lib/errors.ts gets error-handling tag", () => {
    const fileA = store.upsertFile(makeFileRow({ path: "src/features/my-tool.ts" }));
    const fileErrors = store.upsertFile(makeFileRow({ path: "src/shared/lib/errors.ts" }));

    store.insertFileEdge(
      makeFileEdgeRow({
        source_file_id: fileA.file_id!,
        target_file_id: fileErrors.file_id!,
      }),
    );

    const tags = computeImportDerivedTags(store, query);
    const errorTag = tags.find((t) => t.file_id === fileA.file_id! && t.tag === "error-handling");
    expect(errorTag).toBeDefined();
    expect(errorTag?.source).toBe("import");
    expect(errorTag?.confidence).toBe(0.8);
  });

  test("file importing from lib/tool-result.ts gets error-handling tag", () => {
    const fileA = store.upsertFile(makeFileRow({ path: "src/features/handler.ts" }));
    const fileToolResult = store.upsertFile(makeFileRow({ path: "src/shared/lib/tool-result.ts" }));

    store.insertFileEdge(
      makeFileEdgeRow({
        source_file_id: fileA.file_id!,
        target_file_id: fileToolResult.file_id!,
      }),
    );

    const tags = computeImportDerivedTags(store, query);
    const errorTag = tags.find((t) => t.file_id === fileA.file_id! && t.tag === "error-handling");
    expect(errorTag).toBeDefined();
  });

  test("file importing from drift/ path gets observability tag", () => {
    const fileA = store.upsertFile(makeFileRow({ path: "src/features/diagnostics/reporter.ts" }));
    const fileDrift = store.upsertFile(
      makeFileRow({ path: "src/platform/storage/drift/store.ts" }),
    );

    store.insertFileEdge(
      makeFileEdgeRow({
        source_file_id: fileA.file_id!,
        target_file_id: fileDrift.file_id!,
      }),
    );

    const tags = computeImportDerivedTags(store, query);
    const obsTags = tags.filter((t) => t.file_id === fileA.file_id! && t.tag === "observability");
    expect(obsTags.length).toBeGreaterThanOrEqual(1);
  });

  test("file importing from kg-store.ts gets graph-infrastructure tag", () => {
    const fileA = store.upsertFile(makeFileRow({ path: "src/features/kg/my-tool.ts" }));
    const fileKgStore = store.upsertFile(makeFileRow({ path: "src/graph/kg-store.ts" }));

    store.insertFileEdge(
      makeFileEdgeRow({
        source_file_id: fileA.file_id!,
        target_file_id: fileKgStore.file_id!,
      }),
    );

    const tags = computeImportDerivedTags(store, query);
    const kgTag = tags.find(
      (t) => t.file_id === fileA.file_id! && t.tag === "graph-infrastructure",
    );
    expect(kgTag).toBeDefined();
  });

  test("file with no recognized imports produces no tags", () => {
    const fileA = store.upsertFile(makeFileRow({ path: "src/some/other.ts" }));
    const fileB = store.upsertFile(makeFileRow({ path: "src/some/unrelated.ts" }));

    store.insertFileEdge(
      makeFileEdgeRow({
        source_file_id: fileA.file_id!,
        target_file_id: fileB.file_id!,
      }),
    );

    const tags = computeImportDerivedTags(store, query);
    expect(tags).toHaveLength(0);
  });
});

describe("computeGraphRoleTags", () => {
  let db: Database.Database;
  let store: KgStore;
  let query: KgQuery;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
    query = new KgQuery(db);
  });

  afterEach(() => {
    store.close();
  });

  test("file with in_degree >= 8 gets hub tag", () => {
    // Insert hub file and 8 files that import it
    const hub = store.upsertFile(makeFileRow({ path: "src/shared/constants.ts" }));
    const hubId = hub.file_id!;

    for (let i = 0; i < 8; i++) {
      const other = store.upsertFile(makeFileRow({ path: `src/feature${i}/index.ts` }));
      store.insertFileEdge(
        makeFileEdgeRow({
          source_file_id: other.file_id!,
          target_file_id: hubId,
        }),
      );
    }

    const tags = computeGraphRoleTags(query);
    const hubTag = tags.find((t) => t.file_id === hubId && t.tag === "hub");
    expect(hubTag).toBeDefined();
    expect(hubTag?.source).toBe("graph-role");
    expect(hubTag?.confidence).toBe(0.7);
  });

  test("file with in_degree 0 gets entry-point tag", () => {
    // Single file with no incoming edges, but with an outgoing edge
    const fileA = store.upsertFile(makeFileRow({ path: "src/index.ts" }));
    const fileB = store.upsertFile(makeFileRow({ path: "src/lib.ts" }));

    store.insertFileEdge(
      makeFileEdgeRow({
        source_file_id: fileA.file_id!,
        target_file_id: fileB.file_id!,
      }),
    );

    const tags = computeGraphRoleTags(query);

    // fileA has in_degree 0 (no one imports it)
    const entryTag = tags.find((t) => t.file_id === fileA.file_id! && t.tag === "entry-point");
    expect(entryTag).toBeDefined();
  });

  test("file with out_degree 0 gets leaf tag", () => {
    const fileA = store.upsertFile(makeFileRow({ path: "src/index.ts" }));
    const fileB = store.upsertFile(makeFileRow({ path: "src/lib.ts" }));

    // fileB is imported by fileA — out_degree 0 for fileB
    store.insertFileEdge(
      makeFileEdgeRow({
        source_file_id: fileA.file_id!,
        target_file_id: fileB.file_id!,
      }),
    );

    const tags = computeGraphRoleTags(query);

    // fileB has out_degree 0 (imports nothing)
    const leafTag = tags.find((t) => t.file_id === fileB.file_id! && t.tag === "leaf");
    expect(leafTag).toBeDefined();
  });

  test("returns empty array when no files appear in file_edges", () => {
    // Insert a file but no edges — it won't appear in degree maps
    store.upsertFile(makeFileRow({ path: "src/isolated.ts" }));
    const tags = computeGraphRoleTags(query);
    expect(tags).toHaveLength(0);
  });
});

describe("computeCommunityDerivedTags", () => {
  let db: Database.Database;
  let store: KgStore;
  let query: KgQuery;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
    query = new KgQuery(db);
  });

  afterEach(() => {
    store.close();
  });

  test("tag present on 3/4 community members propagates to 4th", () => {
    // Insert 4 files in the same community
    const files: FileRow[] = [];
    for (let i = 0; i < 4; i++) {
      const f = store.upsertFile(makeFileRow({ path: `src/file${i}.ts` }));
      // Set community_id=1 for all 4 files
      store.updateCommunityId(f.file_id!, 1);
      files.push(f);
    }

    // Add tag to 3 of 4 files
    for (let i = 0; i < 3; i++) {
      store.upsertFileTag({
        confidence: 0.8,
        file_id: files[i]!.file_id!,
        source: "directory",
        tag: "graph-infrastructure",
      });
    }

    const tags = computeCommunityDerivedTags(store, query);

    // Should propagate "graph-infrastructure" to the 4th file
    const propagatedTag = tags.find(
      (t) => t.file_id === files[3]!.file_id! && t.tag === "graph-infrastructure",
    );
    expect(propagatedTag).toBeDefined();
    expect(propagatedTag?.source).toBe("community");
    expect(propagatedTag?.confidence).toBe(0.6);
  });

  test("tag present on 1/4 members does NOT propagate (below 50% threshold)", () => {
    const files: FileRow[] = [];
    for (let i = 0; i < 4; i++) {
      const f = store.upsertFile(makeFileRow({ path: `src/file${i}.ts` }));
      store.updateCommunityId(f.file_id!, 1);
      files.push(f);
    }

    // Add tag to only 1 of 4 files (25% — below threshold)
    store.upsertFileTag({
      confidence: 0.9,
      file_id: files[0]!.file_id!,
      source: "directory",
      tag: "rare-tag",
    });

    const tags = computeCommunityDerivedTags(store, query);

    // Should NOT propagate to any of the other 3 files
    const propagatedTags = tags.filter((t) => t.tag === "rare-tag");
    expect(propagatedTags).toHaveLength(0);
  });

  test("returns empty array when no files have community_id set", () => {
    store.upsertFile(makeFileRow({ path: "src/uncommunity.ts" }));
    const tags = computeCommunityDerivedTags(store, query);
    expect(tags).toHaveLength(0);
  });

  test("does not produce duplicate tags for files already tagged", () => {
    const files = [];
    for (let i = 0; i < 4; i++) {
      const f = store.upsertFile(makeFileRow({ path: `src/file${i}.ts` }));
      store.updateCommunityId(f.file_id!, 1);
      files.push(f);
    }

    // Tag all 4 files with the same tag (100% coverage)
    for (const f of files) {
      store.upsertFileTag({
        confidence: 0.9,
        file_id: f.file_id!,
        source: "directory",
        tag: "shared-kernel",
      });
    }

    const tags = computeCommunityDerivedTags(store, query);

    // Files already tagged should not appear in propagated tags
    // (propagation only targets members without the tag)
    expect(tags.filter((t) => t.tag === "shared-kernel")).toHaveLength(0);
  });
});

describe("propagateAllTags", () => {
  let db: Database.Database;
  let store: KgStore;
  let query: KgQuery;

  beforeEach(() => {
    db = initDatabase(":memory:");
    store = new KgStore(db);
    query = new KgQuery(db);
  });

  afterEach(() => {
    store.close();
  });

  test("returns counts for all 4 sources", () => {
    // Add a file in graph/ to trigger at least one directory tag
    store.upsertFile(makeFileRow({ path: "src/graph/kg-store.ts" }));

    const result = propagateAllTags(store, query);

    expect(result).toHaveProperty("totalTags");
    expect(result).toHaveProperty("bySource");
    expect(typeof result.totalTags).toBe("number");
    expect(result.bySource).toHaveProperty("directory");
    expect(result.bySource).toHaveProperty("import");
    expect(result.bySource).toHaveProperty("graph-role");
    expect(result.bySource).toHaveProperty("community");
  });

  test("directory source count matches file count with matching paths", () => {
    store.upsertFile(makeFileRow({ path: "src/graph/kg-query.ts" }));
    store.upsertFile(makeFileRow({ path: "src/graph/kg-store.ts" }));
    store.upsertFile(makeFileRow({ path: "src/platform/adapters/git.ts" }));

    const result = propagateAllTags(store, query);

    // 2 graph files + 1 platform file = 3 total directory tags
    expect(result.bySource.directory).toBe(3);
    expect(result.totalTags).toBeGreaterThanOrEqual(3);
  });

  test("clears existing file_tags before recomputing", () => {
    const file = store.upsertFile(makeFileRow({ path: "src/graph/kg-store.ts" }));

    // Pre-populate with a stale tag
    store.upsertFileTag({
      confidence: 1.0,
      file_id: file.file_id!,
      source: "directory",
      tag: "stale-tag",
    });

    propagateAllTags(store, query);

    // Stale tag should be gone after full recompute
    const tags = store.getFileTagsByFileId(file.file_id!);
    const staleTag = tags.find((t) => t.tag === "stale-tag");
    expect(staleTag).toBeUndefined();
  });
});
