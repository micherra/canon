/**
 * DriftDb Archive Manifest Tests — build_archives table CRUD
 *
 * Uses in-memory SQLite (:memory:) for speed and isolation.
 * Each describe block gets a fresh DB via beforeEach.
 *
 * Tests: appendArchiveManifest, getArchiveManifests, getArchiveById,
 *        countArchives, round-trip serialization, migration.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ArchiveManifestEntry } from "../../../platform/storage/drift/drift-analytics-types.ts";
import { DriftDb } from "../../../platform/storage/drift/drift-db.ts";
import { initDriftDb } from "../../../platform/storage/drift/drift-schema.ts";

// ---- Helpers ----

function makeArchiveEntry(overrides: Partial<ArchiveManifestEntry> = {}): ArchiveManifestEntry {
  const id = `arc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    archive_id: id,
    archive_path: `/archives/${id}`,
    archived_at: new Date().toISOString(),
    artifact_types: ["plans", "decisions"],
    branch: "main",
    flow: "feature",
    has_run_summary: false,
    sanitized_branch: "main",
    slug: "my-feature",
    source_run_id: null,
    task: "Implement X",
    tier: "standard",
    ...overrides,
  };
}

function makeDb(): { db: ReturnType<typeof initDriftDb>; store: DriftDb } {
  const db = initDriftDb(":memory:");
  const store = new DriftDb(db);
  return { db, store };
}

// ---- Tests ----

describe("build_archives migration", () => {
  test("initDriftDb(:memory:) creates build_archives table", () => {
    const { db } = makeDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain("build_archives");
    db.close();
  });

  test("build_archives table has required columns", () => {
    const { db } = makeDb();
    const cols = db.prepare("PRAGMA table_info(build_archives)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("archive_id");
    expect(colNames).toContain("branch");
    expect(colNames).toContain("sanitized_branch");
    expect(colNames).toContain("slug");
    expect(colNames).toContain("flow");
    expect(colNames).toContain("tier");
    expect(colNames).toContain("task");
    expect(colNames).toContain("archived_at");
    expect(colNames).toContain("archive_path");
    expect(colNames).toContain("artifact_types");
    expect(colNames).toContain("has_run_summary");
    expect(colNames).toContain("source_run_id");
    db.close();
  });

  test("build_archives has indexes on sanitized_branch, archived_at, and flow", () => {
    const { db } = makeDb();
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='build_archives'")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_build_archives_branch");
    expect(indexNames).toContain("idx_build_archives_archived_at");
    expect(indexNames).toContain("idx_build_archives_flow");
    db.close();
  });

  test("schema_version is 10 after migration", () => {
    const { db } = makeDb();
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
      value: string;
    };
    expect(row.value).toBe("10");
    db.close();
  });
});

describe("appendArchiveManifest + getArchiveById", () => {
  let store: DriftDb;
  let db: ReturnType<typeof initDriftDb>;

  beforeEach(() => {
    ({ db, store } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  test("inserts a valid entry and retrieves it by archive_id", () => {
    const entry = makeArchiveEntry({ archive_id: "arc_001", branch: "feature/foo" });
    store.appendArchiveManifest(entry);

    const retrieved = store.getArchiveById("arc_001");
    expect(retrieved).not.toBeNull();
    expect(retrieved?.archive_id).toBe("arc_001");
    expect(retrieved?.branch).toBe("feature/foo");
    expect(retrieved?.slug).toBe("my-feature");
  });

  test("getArchiveById returns null for unknown archive_id", () => {
    const result = store.getArchiveById("arc_nonexistent");
    expect(result).toBeNull();
  });

  test("duplicate archive_id throws UNIQUE constraint error", () => {
    const entry = makeArchiveEntry({ archive_id: "arc_dup" });
    store.appendArchiveManifest(entry);
    expect(() => store.appendArchiveManifest(entry)).toThrow();
  });
});

describe("getArchiveManifests", () => {
  let store: DriftDb;
  let db: ReturnType<typeof initDriftDb>;

  beforeEach(() => {
    ({ db, store } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  test("no filter returns all entries ordered by archived_at DESC", () => {
    const early = makeArchiveEntry({
      archive_id: "arc_early",
      archived_at: "2026-01-01T00:00:00.000Z",
    });
    const late = makeArchiveEntry({
      archive_id: "arc_late",
      archived_at: "2026-06-01T00:00:00.000Z",
    });
    store.appendArchiveManifest(early);
    store.appendArchiveManifest(late);

    const results = store.getArchiveManifests();
    expect(results).toHaveLength(2);
    // DESC order: late first
    expect(results[0].archive_id).toBe("arc_late");
    expect(results[1].archive_id).toBe("arc_early");
  });

  test("branch filter returns only matching entries", () => {
    store.appendArchiveManifest(makeArchiveEntry({ archive_id: "arc_main", branch: "main" }));
    store.appendArchiveManifest(
      makeArchiveEntry({ archive_id: "arc_feat", branch: "feature/bar" }),
    );

    const results = store.getArchiveManifests({ branch: "main" });
    expect(results).toHaveLength(1);
    expect(results[0].archive_id).toBe("arc_main");
  });

  test("flow filter returns only matching entries", () => {
    store.appendArchiveManifest(
      makeArchiveEntry({ archive_id: "arc_feat", branch: "main", flow: "feature" }),
    );
    store.appendArchiveManifest(
      makeArchiveEntry({ archive_id: "arc_fp", branch: "main", flow: "fast-path" }),
    );

    const results = store.getArchiveManifests({ flow: "feature" });
    expect(results).toHaveLength(1);
    expect(results[0].archive_id).toBe("arc_feat");
  });

  test("limit returns at most N entries", () => {
    for (let i = 0; i < 5; i++) {
      store.appendArchiveManifest(
        makeArchiveEntry({
          archive_id: `arc_${i}`,
          archived_at: `2026-0${i + 1}-01T00:00:00.000Z`,
        }),
      );
    }
    const results = store.getArchiveManifests({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  test("branch + flow filters combined return only matching entries", () => {
    store.appendArchiveManifest(
      makeArchiveEntry({ archive_id: "arc_match", branch: "main", flow: "feature" }),
    );
    store.appendArchiveManifest(
      makeArchiveEntry({ archive_id: "arc_wrong_branch", branch: "dev", flow: "feature" }),
    );
    store.appendArchiveManifest(
      makeArchiveEntry({ archive_id: "arc_wrong_flow", branch: "main", flow: "fast-path" }),
    );

    const results = store.getArchiveManifests({ branch: "main", flow: "feature" });
    expect(results).toHaveLength(1);
    expect(results[0].archive_id).toBe("arc_match");
  });

  test("returns empty array when no entries match", () => {
    store.appendArchiveManifest(makeArchiveEntry({ archive_id: "arc_only", branch: "main" }));
    const results = store.getArchiveManifests({ branch: "nonexistent" });
    expect(results).toHaveLength(0);
  });
});

describe("countArchives", () => {
  let store: DriftDb;
  let db: ReturnType<typeof initDriftDb>;

  beforeEach(() => {
    ({ db, store } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  test("returns 0 when no archives exist", () => {
    expect(store.countArchives()).toBe(0);
  });

  test("returns correct count after insertions", () => {
    store.appendArchiveManifest(makeArchiveEntry({ archive_id: "arc_a" }));
    store.appendArchiveManifest(makeArchiveEntry({ archive_id: "arc_b" }));
    store.appendArchiveManifest(makeArchiveEntry({ archive_id: "arc_c" }));
    expect(store.countArchives()).toBe(3);
  });
});

describe("round-trip serialization", () => {
  let store: DriftDb;
  let db: ReturnType<typeof initDriftDb>;

  beforeEach(() => {
    ({ db, store } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  test("artifact_types array survives JSON serialization/deserialization", () => {
    const entry = makeArchiveEntry({
      archive_id: "arc_types",
      artifact_types: ["plans", "decisions", "reviews", "research"],
    });
    store.appendArchiveManifest(entry);

    const retrieved = store.getArchiveById("arc_types");
    expect(retrieved?.artifact_types).toEqual(["plans", "decisions", "reviews", "research"]);
  });

  test("empty artifact_types array round-trips correctly", () => {
    const entry = makeArchiveEntry({ archive_id: "arc_empty_types", artifact_types: [] });
    store.appendArchiveManifest(entry);

    const retrieved = store.getArchiveById("arc_empty_types");
    expect(retrieved?.artifact_types).toEqual([]);
  });

  test("has_run_summary true survives INTEGER conversion", () => {
    const entry = makeArchiveEntry({ archive_id: "arc_summary_true", has_run_summary: true });
    store.appendArchiveManifest(entry);

    const retrieved = store.getArchiveById("arc_summary_true");
    expect(retrieved?.has_run_summary).toBe(true);
  });

  test("has_run_summary false survives INTEGER conversion", () => {
    const entry = makeArchiveEntry({ archive_id: "arc_summary_false", has_run_summary: false });
    store.appendArchiveManifest(entry);

    const retrieved = store.getArchiveById("arc_summary_false");
    expect(retrieved?.has_run_summary).toBe(false);
  });

  test("source_run_id null survives round-trip", () => {
    const entry = makeArchiveEntry({ archive_id: "arc_no_run", source_run_id: null });
    store.appendArchiveManifest(entry);

    const retrieved = store.getArchiveById("arc_no_run");
    expect(retrieved?.source_run_id).toBeNull();
  });

  test("source_run_id string survives round-trip", () => {
    const entry = makeArchiveEntry({
      archive_id: "arc_with_run",
      source_run_id: "run_abc123",
    });
    store.appendArchiveManifest(entry);

    const retrieved = store.getArchiveById("arc_with_run");
    expect(retrieved?.source_run_id).toBe("run_abc123");
  });

  test("all fields survive a full round-trip", () => {
    const entry: ArchiveManifestEntry = {
      archive_id: "arc_full",
      archive_path: "/archives/2026/arc_full",
      archived_at: "2026-04-24T10:00:00.000Z",
      artifact_types: ["plans", "decisions"],
      branch: "feature/my-feature",
      flow: "feature",
      has_run_summary: true,
      sanitized_branch: "feature-my-feature",
      slug: "build-xyz",
      source_run_id: "run_xyz789",
      task: "Add archive manifest",
      tier: "complex",
    };
    store.appendArchiveManifest(entry);

    const retrieved = store.getArchiveById("arc_full");
    expect(retrieved).toEqual(entry);
  });
});
