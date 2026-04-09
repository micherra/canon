/**
 * Tests for flow lineage tracking — recordFlowLineage, getFlowLineage, getLatestFlowForBranch
 *
 * Tests:
 * 1. recordFlowLineage inserts entry and getFlowLineage retrieves it
 * 2. getFlowLineage filters by branch (does not return entries for other branches)
 * 3. getFlowLineage returns entries ordered by completed_at DESC
 * 4. getLatestFlowForBranch returns the most recent entry
 * 5. getLatestFlowForBranch returns null for unknown branch
 * 6. Migration v10 creates flow_lineage table (run on fresh DB)
 * 7. Migration v10 is idempotent (run twice without error)
 * 8. recordFlowLineage does not throw on duplicate entries
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initExecutionDb, SCHEMA_VERSION } from "../execution-schema.ts";
import { ExecutionStore } from "../execution-store.ts";
import type { FlowLineageEntry } from "../execution-store.ts";

let tmpFiles: string[] = [];

function makeTmpDb(prefix = "flow-lineage-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpFiles.push(dir);
  return join(dir, "orchestration.db");
}

function makeEntry(overrides: Partial<FlowLineageEntry> = {}): FlowLineageEntry {
  return {
    workspace_path: "/workspace/test",
    flow_name: "fast-path",
    branch: "main",
    status: "completed",
    completed_at: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of tmpFiles) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpFiles = [];
});

// 1. recordFlowLineage inserts entry and getFlowLineage retrieves it

describe("recordFlowLineage and getFlowLineage basic usage", () => {
  it("inserts an entry and retrieves it by branch", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);
    const store = new ExecutionStore(db);

    const entry = makeEntry();
    store.recordFlowLineage(entry);

    const results = store.getFlowLineage("main");
    expect(results).toHaveLength(1);
    expect(results[0].workspace_path).toBe(entry.workspace_path);
    expect(results[0].flow_name).toBe(entry.flow_name);
    expect(results[0].branch).toBe(entry.branch);
    expect(results[0].status).toBe(entry.status);
    expect(results[0].completed_at).toBe(entry.completed_at);

    db.close();
  });

  it("stores and retrieves optional task and slug fields", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);
    const store = new ExecutionStore(db);

    const entry = makeEntry({ task: "Build auth module", slug: "build-auth-module" });
    store.recordFlowLineage(entry);

    const results = store.getFlowLineage("main");
    expect(results).toHaveLength(1);
    expect(results[0].task).toBe("Build auth module");
    expect(results[0].slug).toBe("build-auth-module");

    db.close();
  });

  it("stores entry without optional fields (task and slug are undefined)", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);
    const store = new ExecutionStore(db);

    const entry = makeEntry();
    store.recordFlowLineage(entry);

    const results = store.getFlowLineage("main");
    expect(results).toHaveLength(1);
    expect(results[0].task).toBeUndefined();
    expect(results[0].slug).toBeUndefined();

    db.close();
  });
});

// 2. getFlowLineage filters by branch

describe("getFlowLineage branch filtering", () => {
  it("returns only entries for the requested branch", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);
    const store = new ExecutionStore(db);

    store.recordFlowLineage(makeEntry({ branch: "main", flow_name: "fast-path" }));
    store.recordFlowLineage(makeEntry({ branch: "feature/x", flow_name: "feature" }));
    store.recordFlowLineage(makeEntry({ branch: "main", flow_name: "refactor" }));

    const mainResults = store.getFlowLineage("main");
    expect(mainResults).toHaveLength(2);
    expect(mainResults.every((r) => r.branch === "main")).toBe(true);

    const featureResults = store.getFlowLineage("feature/x");
    expect(featureResults).toHaveLength(1);
    expect(featureResults[0].flow_name).toBe("feature");

    db.close();
  });

  it("returns empty array for unknown branch", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);
    const store = new ExecutionStore(db);

    store.recordFlowLineage(makeEntry({ branch: "main" }));

    const results = store.getFlowLineage("no-such-branch");
    expect(results).toEqual([]);

    db.close();
  });

  it("returns empty array when no entries exist at all", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);
    const store = new ExecutionStore(db);

    const results = store.getFlowLineage("main");
    expect(results).toEqual([]);

    db.close();
  });
});

// 3. getFlowLineage returns entries ordered by completed_at DESC

describe("getFlowLineage ordering", () => {
  it("returns entries ordered by completed_at DESC (newest first)", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);
    const store = new ExecutionStore(db);

    const t1 = "2026-01-01T10:00:00.000Z";
    const t2 = "2026-01-02T10:00:00.000Z";
    const t3 = "2026-01-03T10:00:00.000Z";

    store.recordFlowLineage(makeEntry({ flow_name: "first", completed_at: t1 }));
    store.recordFlowLineage(makeEntry({ flow_name: "third", completed_at: t3 }));
    store.recordFlowLineage(makeEntry({ flow_name: "second", completed_at: t2 }));

    const results = store.getFlowLineage("main");
    expect(results).toHaveLength(3);
    expect(results[0].flow_name).toBe("third"); // newest
    expect(results[1].flow_name).toBe("second");
    expect(results[2].flow_name).toBe("first"); // oldest

    db.close();
  });
});

// 4. getLatestFlowForBranch returns the most recent entry

describe("getLatestFlowForBranch", () => {
  it("returns the most recent entry for the branch", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);
    const store = new ExecutionStore(db);

    const t1 = "2026-01-01T10:00:00.000Z";
    const t2 = "2026-01-02T10:00:00.000Z";

    store.recordFlowLineage(makeEntry({ flow_name: "older", completed_at: t1 }));
    store.recordFlowLineage(makeEntry({ flow_name: "newer", completed_at: t2 }));

    const latest = store.getLatestFlowForBranch("main");
    expect(latest).not.toBeNull();
    expect(latest!.flow_name).toBe("newer");
    expect(latest!.completed_at).toBe(t2);

    db.close();
  });

  it("returns the single entry when only one exists", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);
    const store = new ExecutionStore(db);

    store.recordFlowLineage(makeEntry({ flow_name: "only-one" }));

    const latest = store.getLatestFlowForBranch("main");
    expect(latest).not.toBeNull();
    expect(latest!.flow_name).toBe("only-one");

    db.close();
  });

  it("returns latest for specific branch (not from other branches)", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);
    const store = new ExecutionStore(db);

    const t1 = "2026-01-01T10:00:00.000Z";
    const t2 = "2026-01-05T10:00:00.000Z";

    store.recordFlowLineage(makeEntry({ branch: "feature/y", flow_name: "feature-flow", completed_at: t2 }));
    store.recordFlowLineage(makeEntry({ branch: "main", flow_name: "main-flow", completed_at: t1 }));

    const latest = store.getLatestFlowForBranch("main");
    expect(latest).not.toBeNull();
    expect(latest!.flow_name).toBe("main-flow");

    db.close();
  });
});

// 5. getLatestFlowForBranch returns null for unknown branch

describe("getLatestFlowForBranch null for unknown branch", () => {
  it("returns null when no entries exist for the branch", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);
    const store = new ExecutionStore(db);

    const latest = store.getLatestFlowForBranch("no-such-branch");
    expect(latest).toBeNull();

    db.close();
  });

  it("returns null on empty database", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);
    const store = new ExecutionStore(db);

    const latest = store.getLatestFlowForBranch("main");
    expect(latest).toBeNull();

    db.close();
  });
});

// 6. Migration v10 creates flow_lineage table

describe("migration v10: flow_lineage table creation", () => {
  it("fresh DB has flow_lineage table after init", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);

    const tableRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='flow_lineage'")
      .get() as { name: string } | undefined;

    expect(tableRow).toBeDefined();
    expect(tableRow!.name).toBe("flow_lineage");

    db.close();
  });

  it("flow_lineage table has branch index after init", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);

    const indexRow = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_flow_lineage_branch'")
      .get() as { name: string } | undefined;

    expect(indexRow).toBeDefined();

    db.close();
  });

  it("SCHEMA_VERSION is bumped to 10", () => {
    expect(SCHEMA_VERSION).toBe("10");
  });
});

// 7. Migration v10 is idempotent

describe("migration v10 idempotency", () => {
  it("calling initExecutionDb twice does not throw (migration is idempotent)", () => {
    const dbPath = makeTmpDb();

    const db1 = initExecutionDb(dbPath);
    db1.close();

    expect(() => {
      const db2 = initExecutionDb(dbPath);
      db2.close();
    }).not.toThrow();
  });

  it("schema_version is '10' after two consecutive inits", () => {
    const dbPath = makeTmpDb();

    const db1 = initExecutionDb(dbPath);
    db1.close();

    const db2 = initExecutionDb(dbPath);
    const row = db2.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;

    expect(row?.value).toBe("10");
    db2.close();
  });
});

// 8. recordFlowLineage does not throw on invalid/duplicate entries (errors-are-values)

describe("recordFlowLineage error tolerance", () => {
  it("multiple insertions of same entry do not throw (no unique constraint violation)", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);
    const store = new ExecutionStore(db);

    const entry = makeEntry({ flow_name: "fast-path", completed_at: "2026-01-01T10:00:00.000Z" });

    expect(() => {
      store.recordFlowLineage(entry);
      store.recordFlowLineage(entry); // same data again — no unique constraint
    }).not.toThrow();

    db.close();
  });

  it("can insert many entries for the same branch", () => {
    const dbPath = makeTmpDb();
    const db = initExecutionDb(dbPath);
    const store = new ExecutionStore(db);

    for (let i = 0; i < 5; i++) {
      store.recordFlowLineage(makeEntry({ flow_name: `flow-${i}` }));
    }

    const results = store.getFlowLineage("main");
    expect(results).toHaveLength(5);

    db.close();
  });
});
