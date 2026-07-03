/**
 * active-workspaces-dao.test.ts
 *
 * Tests for ActiveWorkspacesDao — project-level active-build discovery registry
 * (drift.db v12, table `active_workspaces`).
 * Uses an in-memory SQLite DB (initDriftDb(':memory:')) to avoid file system side effects.
 *
 * Test plan (Inc 0 plan, sub-part A):
 * - migration 11->12 adds active_workspaces table; fresh :memory: db reaches version 12
 * - register: insert -> status=live, started_at==last_seen
 * - register: re-register (UPSERT) -> status back to live, last_seen advances, started_at preserved
 * - markFinalized: status->finalized_on_disk, finalized_at set
 * - markReaped: status->reaped tombstone kept
 * - markFinalized / markReaped on absent row = no-op
 * - getByPath: null when absent
 * - list(): returns all rows ORDER BY started_at DESC
 * - list("live"): filters by status
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ActiveWorkspacesDao } from "../active-workspaces-dao.ts";
import { DRIFT_SCHEMA_VERSION, initDriftDb, runDriftMigrations } from "../drift-schema.ts";

function makeDb() {
  return initDriftDb(":memory:");
}

describe("ActiveWorkspacesDao", () => {
  let db: ReturnType<typeof makeDb>;
  let dao: ActiveWorkspacesDao;

  beforeEach(() => {
    db = makeDb();
    dao = new ActiveWorkspacesDao(db);
  });

  // ---------------------------------------------------------------------------
  // Migration tests
  // ---------------------------------------------------------------------------

  describe("migration", () => {
    it("fresh DB has active_workspaces table after initDriftDb", () => {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='active_workspaces'")
        .all() as Array<{ name: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("active_workspaces");
    });

    it("fresh :memory: db reaches schema version 12", () => {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      expect(row.value).toBe("12");
      expect(DRIFT_SCHEMA_VERSION).toBe("12");
    });

    it("v11->v12 migration is idempotent (run runDriftMigrations twice)", () => {
      expect(() => {
        runDriftMigrations(db);
      }).not.toThrow();

      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='active_workspaces'")
        .all() as Array<{ name: string }>;
      expect(rows).toHaveLength(1);
    });
  });

  // ---------------------------------------------------------------------------
  // register()
  // ---------------------------------------------------------------------------

  describe("register", () => {
    it("insert: status=live, started_at equals last_seen", () => {
      dao.register({
        base_commit: "abc123",
        job_id: "job1",
        session_id: "sess1",
        slug: "add-auth",
        workspace_path: "/proj/.canon/workspaces/main/add-auth",
      });

      const row = dao.getByPath("/proj/.canon/workspaces/main/add-auth");
      expect(row).not.toBeNull();
      expect(row?.status).toBe("live");
      expect(row?.slug).toBe("add-auth");
      expect(row?.session_id).toBe("sess1");
      expect(row?.job_id).toBe("job1");
      expect(row?.base_commit).toBe("abc123");
      expect(row?.started_at).toBe(row?.last_seen);
      expect(row?.finalized_at).toBeNull();
    });

    it("re-register (UPSERT): status back to live, last_seen advances, started_at preserved", async () => {
      dao.register({
        slug: "add-auth",
        workspace_path: "/proj/.canon/workspaces/main/add-auth",
      });
      const first = dao.getByPath("/proj/.canon/workspaces/main/add-auth");
      expect(first).not.toBeNull();
      const firstStartedAt = first?.started_at;

      // Ensure a measurable time delta between registrations.
      await new Promise((resolve) => setTimeout(resolve, 5));

      dao.register({
        slug: "add-auth",
        workspace_path: "/proj/.canon/workspaces/main/add-auth",
      });
      const second = dao.getByPath("/proj/.canon/workspaces/main/add-auth");
      expect(second).not.toBeNull();
      expect(second?.status).toBe("live");
      expect(second?.started_at).toBe(firstStartedAt);
      expect(new Date(second!.last_seen).getTime()).toBeGreaterThanOrEqual(
        new Date(first!.last_seen).getTime(),
      );
    });

    it("re-register after finalized/reaped flips status back to live (resume touch)", () => {
      dao.register({ slug: "s", workspace_path: "/ws/s" });
      dao.markReaped("/ws/s");
      expect(dao.getByPath("/ws/s")?.status).toBe("reaped");

      dao.register({ slug: "s", workspace_path: "/ws/s" });
      expect(dao.getByPath("/ws/s")?.status).toBe("live");
    });
  });

  // ---------------------------------------------------------------------------
  // markFinalized()
  // ---------------------------------------------------------------------------

  describe("markFinalized", () => {
    it("transitions status to finalized_on_disk and sets finalized_at", () => {
      dao.register({ slug: "s", workspace_path: "/ws/s" });
      dao.markFinalized("/ws/s");

      const row = dao.getByPath("/ws/s");
      expect(row?.status).toBe("finalized_on_disk");
      expect(row?.finalized_at).not.toBeNull();
    });

    it("is a no-op on an absent row", () => {
      expect(() => dao.markFinalized("/ws/does-not-exist")).not.toThrow();
      expect(dao.getByPath("/ws/does-not-exist")).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // markReaped()
  // ---------------------------------------------------------------------------

  describe("markReaped", () => {
    it("transitions status to reaped (tombstone kept, row not deleted)", () => {
      dao.register({ slug: "s", workspace_path: "/ws/s" });
      dao.markReaped("/ws/s");

      const row = dao.getByPath("/ws/s");
      expect(row).not.toBeNull();
      expect(row?.status).toBe("reaped");
    });

    it("is a no-op on an absent row", () => {
      expect(() => dao.markReaped("/ws/does-not-exist")).not.toThrow();
      expect(dao.getByPath("/ws/does-not-exist")).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // getByPath()
  // ---------------------------------------------------------------------------

  describe("getByPath", () => {
    it("returns null when absent", () => {
      expect(dao.getByPath("/ws/nope")).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // list()
  // ---------------------------------------------------------------------------

  describe("list", () => {
    it("returns [] when no rows exist", () => {
      expect(dao.list()).toEqual([]);
    });

    it("returns all rows ordered by started_at DESC", async () => {
      dao.register({ slug: "first", workspace_path: "/ws/first" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      dao.register({ slug: "second", workspace_path: "/ws/second" });

      const rows = dao.list();
      expect(rows).toHaveLength(2);
      expect(rows[0].slug).toBe("second");
      expect(rows[1].slug).toBe("first");
    });

    it("filters by status", () => {
      dao.register({ slug: "a", workspace_path: "/ws/a" });
      dao.register({ slug: "b", workspace_path: "/ws/b" });
      dao.markReaped("/ws/b");

      const live = dao.list("live");
      expect(live).toHaveLength(1);
      expect(live[0].slug).toBe("a");

      const reaped = dao.list("reaped");
      expect(reaped).toHaveLength(1);
      expect(reaped[0].slug).toBe("b");
    });
  });
});
