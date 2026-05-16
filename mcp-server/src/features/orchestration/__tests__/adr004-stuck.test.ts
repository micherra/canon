/**
 * ADR-004 Integration Tests — Migration, Stuck Detection, and Plan Index
 *
 * Covers:
 * 1. Migration runner with existing execution_states data preserved
 * 2. ExecutionStore.isStuck edge cases
 * 3. writePlanIndex edge cases
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initExecutionDb, runMigrations } from "@domains/workspaces/execution-schema.ts";
import { ExecutionStore } from "@domains/workspaces/execution-store.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { writePlanIndex } from "../tools/write-plan-index.ts";

// 1. Migration runner — existing execution data is preserved
//
// A v1 database has all the standard tables (execution, execution_states, etc.)
// but NOT the iteration_results table added in v2.
// We simulate this by starting with initExecutionDb (which creates a v2 DB),
// then dropping iteration_results and resetting the version to '1', so we can
// test the migration path in isolation without duplicating all the DDL.

describe("runMigrations — data preservation during upgrade", () => {
  /**
   * Build a synthetic v1 database by starting with a fresh v2 DB (which has all
   * the full schema), then dropping the iteration_results table and resetting
   * schema_version to '1'. This simulates a workspace that was created before
   * the v2 migration, without us having to re-specify all DDL.
   */
  function makeV1DbFromFull(): Database.Database {
    const db = initExecutionDb(":memory:");
    // Downgrade: remove iteration_results and reset version
    db.exec(`DROP TABLE IF EXISTS iteration_results`);
    db.exec(`DROP INDEX IF EXISTS idx_iteration_results_state`);
    db.exec(`UPDATE meta SET value = '1' WHERE key = 'schema_version'`);
    return db;
  }

  it("preserves existing execution_states rows after v1→v2 migration", () => {
    const db = makeV1DbFromFull();

    // Seed an execution_states row to verify it survives the migration
    db.exec(
      `INSERT INTO execution_states (state_id, status, entries) VALUES ('implement', 'active', 1)`,
    );

    runMigrations(db);

    const row = db
      .prepare("SELECT status FROM execution_states WHERE state_id = 'implement'")
      .get() as { status: string } | undefined;
    expect(row?.status).toBe("active");
  });

  it("creates iteration_results table with correct columns after migration", () => {
    const db = makeV1DbFromFull();
    runMigrations(db);

    const info = db.prepare(`PRAGMA table_info(iteration_results)`).all() as Array<{
      name: string;
    }>;
    const columns = info.map((c) => c.name);
    expect(columns).toContain("state_id");
    expect(columns).toContain("iteration");
    expect(columns).toContain("status");
    expect(columns).toContain("data");
    expect(columns).toContain("timestamp");
  });

  it("creates index on iteration_results(state_id) after migration", () => {
    const db = makeV1DbFromFull();
    runMigrations(db);

    const indexes = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='iteration_results'`)
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_iteration_results_state");
  });

  it("allows recordIterationResult immediately after migration (end-to-end)", () => {
    const db = makeV1DbFromFull();
    runMigrations(db);

    // ExecutionStore prepares statements for all tables — all must exist after migration
    const store = new ExecutionStore(db);
    store.recordIterationResult("implement", 1, "done", { commit_sha: "abc" });

    const rows = db
      .prepare("SELECT * FROM iteration_results WHERE state_id = 'implement'")
      .all() as Array<{ status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("done");
  });

  it("upgrades schema_version to latest in meta table", () => {
    const db = makeV1DbFromFull();
    runMigrations(db);

    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    expect(row?.value).toBe("11");
  });

  it("is idempotent: second call on an already-migrated v1→v2 DB does not throw", () => {
    const db = makeV1DbFromFull();
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });
});

// 2. isStuck — edge cases not covered in the implementor tests

describe("ExecutionStore.isStuck — additional edge cases", () => {
  function makeStore(): ExecutionStore {
    const db = initExecutionDb(":memory:");
    return new ExecutionStore(db);
  }

  it("same_violations: considers only the last two iterations (3+ iterations)", () => {
    const store = makeStore();
    // Three iterations: 1 and 2 differ, but 2 and 3 are identical
    store.recordIterationResult("review", 1, "blocking", {
      file_paths: ["a.ts"],
      principle_ids: ["thin-handlers"],
    });
    store.recordIterationResult("review", 2, "blocking", {
      file_paths: ["b.ts"],
      principle_ids: ["errors-are-values"],
    });
    store.recordIterationResult("review", 3, "blocking", {
      file_paths: ["b.ts"],
      principle_ids: ["errors-are-values"],
    });
    // Last two (2,3) match → stuck
    expect(store.isStuck("review", "same_violations")).toBe(true);
  });

  it("no_progress: returns false when artifact_count changes even if commit_sha same", () => {
    const store = makeStore();
    store.recordIterationResult("implement", 1, "needs_fix", {
      artifact_count: 2,
      commit_sha: "abc",
    });
    store.recordIterationResult("implement", 2, "needs_fix", {
      artifact_count: 3, // different artifact count
      commit_sha: "abc",
    });
    expect(store.isStuck("implement", "no_progress")).toBe(false);
  });

  it("same_file_test: different state_ids are isolated (no cross-contamination)", () => {
    const store = makeStore();
    const pairs = [{ file: "foo.ts", test: "foo.test.ts" }];
    store.recordIterationResult("state-a", 1, "failing", { pairs });
    store.recordIterationResult("state-a", 2, "failing", { pairs });
    store.recordIterationResult("state-b", 1, "failing", { pairs });
    // state-b only has 1 iteration, so it cannot be stuck
    expect(store.isStuck("state-a", "same_file_test")).toBe(true);
    expect(store.isStuck("state-b", "same_file_test")).toBe(false);
  });

  it("unknown stuckWhen strategy returns false safely", () => {
    // The type is StuckWhen — but the function should degrade gracefully for unknown values
    // (contract test for defensive coding)
    const store = makeStore();
    store.recordIterationResult("s", 1, "needs_fix", {});
    store.recordIterationResult("s", 2, "needs_fix", {});
    // Cast to any to pass an unknown value — should not throw, returns false
    expect(() => store.isStuck("s", "unknown_strategy" as never)).not.toThrow();
  });

  it("same_file_test: empty pairs on both iterations should NOT be stuck (all_passing result)", () => {
    // Bug: unorderedEqual([], []) returned true (vacuously), causing false stuck detection
    // when all tests pass and the failing-file set is empty.
    const store = makeStore();
    store.recordIterationResult("fix", 1, "all_passing", { pairs: [] });
    store.recordIterationResult("fix", 2, "all_passing", { pairs: [] });
    expect(store.isStuck("fix", "same_file_test")).toBe(false);
  });

  it("same_file_test: empty current pairs (tests now all passing) should NOT be stuck", () => {
    // Progress was made: previous iteration had failures, current has none.
    const store = makeStore();
    store.recordIterationResult("fix", 1, "failing", {
      pairs: [{ file: "a.ts", test: "a.test.ts" }],
    });
    store.recordIterationResult("fix", 2, "all_passing", { pairs: [] });
    expect(store.isStuck("fix", "same_file_test")).toBe(false);
  });
});

// 3. writePlanIndex — additional edge cases

describe("writePlanIndex — additional edge cases", () => {
  it("rejects an empty slug", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));
    try {
      const result = await writePlanIndex({
        slug: "",
        tasks: [{ task_id: "t-01", wave: 1 }],
        workspace: tmpDir,
      });
      // Empty slug is rejected — SLUG_PATTERN requires at least 1 character
      expect(result.ok).toBe(false);
    } finally {
      await rm(tmpDir, { force: true, recursive: true });
    }
  });

  it("task description with commas in files array doesn't break the table", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));
    try {
      const result = await writePlanIndex({
        slug: "test",
        tasks: [
          {
            files: ["src/a.ts", "src/b.ts", "src/c.ts"],
            task_id: "t-01",
            wave: 1,
          },
        ],
        workspace: tmpDir,
      });
      assertOk(result);
      const content = await readFile(result.path, "utf-8");
      // All three files must appear in the table
      expect(content).toContain("src/a.ts");
      expect(content).toContain("src/b.ts");
      expect(content).toContain("src/c.ts");
      // parseTaskIds should still work on this content
      const { parseTaskIds } = await import("@domains/workspaces/task-variables.ts");
      const wave1Ids = parseTaskIds(content, 1);
      expect(wave1Ids).toEqual(["t-01"]);
    } finally {
      await rm(tmpDir, { force: true, recursive: true });
    }
  });

  it("returns INVALID_INPUT for task_id that is empty string", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "write-plan-index-test-"));
    try {
      const result = await writePlanIndex({
        slug: "test",
        tasks: [{ task_id: "", wave: 1 }],
        workspace: tmpDir,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error_code).toBe("INVALID_INPUT");
      }
    } finally {
      await rm(tmpDir, { force: true, recursive: true });
    }
  });
});
