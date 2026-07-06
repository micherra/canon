/**
 * cliff-events-dao.test.ts
 *
 * Tests for CliffEventsDao — durable cliff_detected event aggregation.
 * Uses an in-memory SQLite DB (initDriftDb(':memory:')) to avoid file system side effects.
 *
 * Test plan (from cliff-01 plan):
 * - migration: fresh DB has cliff_events table; v9→v10 migration is idempotent and preserves pre-existing data
 * - upsert inserts; second upsert same key updates in place (1 row); UNIQUE key enforced
 * - COALESCE semantics: null agent_type later enriched by non-null upsert
 * - known outcome never downgraded to "unknown"
 * - getAll / getByWorkspace / updateOutcome happy paths
 * - updateOutcome on absent row is a no-op
 * - unrecognized stored outcome string reads back as "unknown"
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  CLIFF_RECOVERY_OUTCOMES,
  type CliffEventRow,
  CliffEventsDao,
  type CliffRecoveryOutcome,
} from "../cliff-events-dao.ts";
import { initDriftDb, runDriftMigrations } from "../drift-schema.ts";

function makeDb() {
  return initDriftDb(":memory:");
}

describe("CliffEventsDao", () => {
  let db: ReturnType<typeof makeDb>;
  let dao: CliffEventsDao;

  beforeEach(() => {
    db = makeDb();
    dao = new CliffEventsDao(db);
  });

  // ---------------------------------------------------------------------------
  // Migration tests
  // ---------------------------------------------------------------------------

  describe("migration", () => {
    it("fresh DB has cliff_events table after initDriftDb", () => {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cliff_events'")
        .all() as Array<{ name: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("cliff_events");
    });

    it("v9→v10 migration is idempotent (run runDriftMigrations twice)", () => {
      // initDriftDb already ran migrations; running again should not throw
      expect(() => {
        runDriftMigrations(db);
      }).not.toThrow();

      // Table should still exist exactly once
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cliff_events'")
        .all() as Array<{ name: string }>;
      expect(rows).toHaveLength(1);
    });

    it("v9→v10 migration preserves pre-existing craft_profiles data", () => {
      // Insert a craft_profiles row on a v9-equivalent DB, then migrate to v10
      // We simulate by creating a DB that already has craft_profiles, then re-running migrations
      const dbV9 = initDriftDb(":memory:");

      // Manually set schema_version back to '9' to simulate a v9 DB
      dbV9.exec("UPDATE meta SET value = '9' WHERE key = 'schema_version'");
      // Insert a craft_profiles row to simulate pre-existing data
      dbV9.exec(`
        INSERT INTO craft_profiles (subsystem_key, source, ratings, created_at)
        VALUES ('test/area', 'audit', '[]', '2026-06-07T00:00:00.000Z')
      `);

      // Now migrate from v9 to v10
      runDriftMigrations(dbV9);

      // Pre-existing data must be intact
      const profiles = dbV9
        .prepare("SELECT * FROM craft_profiles WHERE subsystem_key = 'test/area'")
        .all() as Array<{ subsystem_key: string }>;
      expect(profiles).toHaveLength(1);
      expect(profiles[0].subsystem_key).toBe("test/area");

      // cliff_events table must exist
      const tables = dbV9
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cliff_events'")
        .all() as Array<{ name: string }>;
      expect(tables).toHaveLength(1);

      dbV9.close();
    });

    it("fresh DB initializes straight to the current schema version", () => {
      const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      expect(version.value).toBe("15");
    });
  });

  // ---------------------------------------------------------------------------
  // CLIFF_RECOVERY_OUTCOMES constant
  // ---------------------------------------------------------------------------

  describe("CLIFF_RECOVERY_OUTCOMES", () => {
    it("exports all four outcome values", () => {
      expect(CLIFF_RECOVERY_OUTCOMES).toEqual(
        expect.arrayContaining(["recovered", "abandoned", "unresolved", "unknown"]),
      );
      expect(CLIFF_RECOVERY_OUTCOMES).toHaveLength(4);
    });
  });

  // ---------------------------------------------------------------------------
  // upsert
  // ---------------------------------------------------------------------------

  describe("upsert", () => {
    it("inserts a new row on first call", () => {
      dao.upsert({
        workspace_slug: "my-workspace",
        step_id: "implement",
        source: "post_subagent",
        detected_at: "2026-06-07T10:00:00.000Z",
      });

      const rows = dao.getAll();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.workspace_slug).toBe("my-workspace");
      expect(row.step_id).toBe("implement");
      expect(row.source).toBe("post_subagent");
      expect(row.detected_at).toBe("2026-06-07T10:00:00.000Z");
      expect(row.recovery_outcome).toBe("unknown");
      expect(row.agent_type).toBeNull();
      expect(row.missing_count).toBeNull();
      expect(row.partial_count).toBeNull();
    });

    it("second upsert on same (workspace_slug, step_id) yields exactly one row", () => {
      dao.upsert({
        workspace_slug: "my-workspace",
        step_id: "implement",
        source: "post_subagent",
        detected_at: "2026-06-07T10:00:00.000Z",
      });

      dao.upsert({
        workspace_slug: "my-workspace",
        step_id: "implement",
        source: "resume",
        detected_at: "2026-06-07T11:00:00.000Z",
        missing_count: 2,
      });

      const rows = dao.getAll();
      expect(rows).toHaveLength(1);
      // Updated values
      expect(rows[0].detected_at).toBe("2026-06-07T11:00:00.000Z");
      expect(rows[0].source).toBe("resume");
      expect(rows[0].missing_count).toBe(2);
    });

    it("different step_ids produce separate rows", () => {
      dao.upsert({
        workspace_slug: "ws",
        step_id: "implement",
        source: "post_subagent",
        detected_at: "2026-06-07T10:00:00.000Z",
      });
      dao.upsert({
        workspace_slug: "ws",
        step_id: "review",
        source: "resume",
        detected_at: "2026-06-07T11:00:00.000Z",
      });

      const rows = dao.getAll();
      expect(rows).toHaveLength(2);
    });

    it("optional fields (agent_type, missing_count, partial_count) are stored when provided", () => {
      dao.upsert({
        workspace_slug: "ws",
        step_id: "verify",
        agent_type: "engineer",
        source: "resume",
        detected_at: "2026-06-07T10:00:00.000Z",
        missing_count: 1,
        partial_count: 0,
        recovery_outcome: "recovered",
      });

      const rows = dao.getAll();
      expect(rows).toHaveLength(1);
      expect(rows[0].agent_type).toBe("engineer");
      expect(rows[0].missing_count).toBe(1);
      expect(rows[0].partial_count).toBe(0);
      expect(rows[0].recovery_outcome).toBe("recovered");
    });
  });

  // ---------------------------------------------------------------------------
  // COALESCE semantics
  // ---------------------------------------------------------------------------

  describe("COALESCE semantics", () => {
    it("null agent_type is enriched by subsequent upsert with non-null agent_type", () => {
      // First upsert: no agent_type
      dao.upsert({
        workspace_slug: "ws",
        step_id: "implement",
        source: "post_subagent",
        detected_at: "2026-06-07T10:00:00.000Z",
      });

      let rows = dao.getAll();
      expect(rows[0].agent_type).toBeNull();

      // Second upsert: with agent_type
      dao.upsert({
        workspace_slug: "ws",
        step_id: "implement",
        agent_type: "engineer",
        source: "post_subagent",
        detected_at: "2026-06-07T11:00:00.000Z",
      });

      rows = dao.getAll();
      expect(rows).toHaveLength(1);
      expect(rows[0].agent_type).toBe("engineer");
    });

    it("non-null agent_type is NOT overwritten by null in subsequent upsert", () => {
      // First upsert: with agent_type
      dao.upsert({
        workspace_slug: "ws",
        step_id: "implement",
        agent_type: "engineer",
        source: "post_subagent",
        detected_at: "2026-06-07T10:00:00.000Z",
      });

      // Second upsert: no agent_type (omitted → null)
      dao.upsert({
        workspace_slug: "ws",
        step_id: "implement",
        source: "resume",
        detected_at: "2026-06-07T11:00:00.000Z",
      });

      const rows = dao.getAll();
      expect(rows).toHaveLength(1);
      // COALESCE: existing non-null preserved
      expect(rows[0].agent_type).toBe("engineer");
    });

    it("known outcome is NOT downgraded to 'unknown' by subsequent upsert", () => {
      dao.upsert({
        workspace_slug: "ws",
        step_id: "implement",
        source: "post_subagent",
        detected_at: "2026-06-07T10:00:00.000Z",
        recovery_outcome: "recovered",
      });

      // Upsert with no outcome (defaults to "unknown")
      dao.upsert({
        workspace_slug: "ws",
        step_id: "implement",
        source: "resume",
        detected_at: "2026-06-07T11:00:00.000Z",
      });

      const rows = dao.getAll();
      expect(rows).toHaveLength(1);
      // "recovered" must be preserved — not downgraded to "unknown"
      expect(rows[0].recovery_outcome).toBe("recovered");
    });

    it("known outcome can be overwritten by a different known outcome", () => {
      dao.upsert({
        workspace_slug: "ws",
        step_id: "implement",
        source: "post_subagent",
        detected_at: "2026-06-07T10:00:00.000Z",
        recovery_outcome: "unresolved",
      });

      dao.upsert({
        workspace_slug: "ws",
        step_id: "implement",
        source: "resume",
        detected_at: "2026-06-07T11:00:00.000Z",
        recovery_outcome: "recovered",
      });

      const rows = dao.getAll();
      expect(rows).toHaveLength(1);
      expect(rows[0].recovery_outcome).toBe("recovered");
    });

    it("missing_count COALESCE: null not overwritten by null; non-null enriches null", () => {
      dao.upsert({
        workspace_slug: "ws",
        step_id: "step-a",
        source: "post_subagent",
        detected_at: "2026-06-07T10:00:00.000Z",
        missing_count: 3,
      });

      // Upsert without missing_count — should preserve existing value
      dao.upsert({
        workspace_slug: "ws",
        step_id: "step-a",
        source: "resume",
        detected_at: "2026-06-07T11:00:00.000Z",
      });

      const rows = dao.getAll();
      expect(rows[0].missing_count).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // getAll
  // ---------------------------------------------------------------------------

  describe("getAll", () => {
    it("returns [] when no events exist (define-errors-out-of-existence)", () => {
      expect(dao.getAll()).toEqual([]);
    });

    it("returns all rows across workspaces", () => {
      dao.upsert({
        workspace_slug: "ws-a",
        step_id: "step-1",
        source: "post_subagent",
        detected_at: "2026-06-07T10:00:00.000Z",
      });
      dao.upsert({
        workspace_slug: "ws-b",
        step_id: "step-2",
        source: "resume",
        detected_at: "2026-06-07T11:00:00.000Z",
      });

      const rows = dao.getAll();
      expect(rows).toHaveLength(2);
      const slugs = rows.map((r) => r.workspace_slug);
      expect(slugs).toContain("ws-a");
      expect(slugs).toContain("ws-b");
    });

    it("returned rows have all CliffEventRow fields", () => {
      dao.upsert({
        workspace_slug: "ws",
        step_id: "step",
        agent_type: "engineer",
        source: "post_subagent",
        detected_at: "2026-06-07T10:00:00.000Z",
        missing_count: 1,
        partial_count: 2,
        recovery_outcome: "abandoned",
      });

      const rows = dao.getAll();
      expect(rows).toHaveLength(1);
      const row: CliffEventRow = rows[0];
      expect(typeof row.id).toBe("number");
      expect(row.workspace_slug).toBe("ws");
      expect(row.step_id).toBe("step");
      expect(row.agent_type).toBe("engineer");
      expect(row.source).toBe("post_subagent");
      expect(row.detected_at).toBe("2026-06-07T10:00:00.000Z");
      expect(row.missing_count).toBe(1);
      expect(row.partial_count).toBe(2);
      expect(row.recovery_outcome).toBe("abandoned");
      expect(typeof row.recorded_at).toBe("string");
    });
  });

  // ---------------------------------------------------------------------------
  // getByWorkspace
  // ---------------------------------------------------------------------------

  describe("getByWorkspace", () => {
    it("returns only rows for the given workspace_slug", () => {
      dao.upsert({
        workspace_slug: "ws-a",
        step_id: "step-1",
        source: "post_subagent",
        detected_at: "2026-06-07T10:00:00.000Z",
      });
      dao.upsert({
        workspace_slug: "ws-b",
        step_id: "step-2",
        source: "resume",
        detected_at: "2026-06-07T11:00:00.000Z",
      });

      const rowsA = dao.getByWorkspace("ws-a");
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0].workspace_slug).toBe("ws-a");

      const rowsB = dao.getByWorkspace("ws-b");
      expect(rowsB).toHaveLength(1);
      expect(rowsB[0].workspace_slug).toBe("ws-b");
    });

    it("returns [] for unknown workspace_slug (define-errors-out-of-existence)", () => {
      dao.upsert({
        workspace_slug: "ws-a",
        step_id: "step",
        source: "post_subagent",
        detected_at: "2026-06-07T10:00:00.000Z",
      });

      expect(dao.getByWorkspace("nonexistent")).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // updateOutcome
  // ---------------------------------------------------------------------------

  describe("updateOutcome", () => {
    it("updates recovery_outcome for an existing row", () => {
      dao.upsert({
        workspace_slug: "ws",
        step_id: "implement",
        source: "post_subagent",
        detected_at: "2026-06-07T10:00:00.000Z",
      });

      dao.updateOutcome("ws", "implement", "recovered");

      const rows = dao.getAll();
      expect(rows[0].recovery_outcome).toBe("recovered");
    });

    it("is a no-op when row is absent (define-errors-out-of-existence)", () => {
      // No rows inserted — updateOutcome on absent row must not throw
      expect(() => {
        dao.updateOutcome("nonexistent-ws", "nonexistent-step", "recovered");
      }).not.toThrow();

      expect(dao.getAll()).toEqual([]);
    });

    it("can set all valid outcome values", () => {
      const outcomes: CliffRecoveryOutcome[] = ["recovered", "abandoned", "unresolved", "unknown"];

      for (const outcome of outcomes) {
        const slug = `ws-${outcome}`;
        dao.upsert({
          workspace_slug: slug,
          step_id: "step",
          source: "post_subagent",
          detected_at: "2026-06-07T10:00:00.000Z",
        });
        dao.updateOutcome(slug, "step", outcome);

        const rows = dao.getByWorkspace(slug);
        expect(rows[0].recovery_outcome).toBe(outcome);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // transcript_path / transcript_uncaptured_reason (v15, cliff-transcript-01):
  // see the sibling cliff-events-dao-transcript.test.ts (split out 2026-07-06 to
  // keep both files under the 600-line biome noExcessiveLinesPerFile limit).
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Foreign data tolerance
  // ---------------------------------------------------------------------------

  describe("foreign data tolerance", () => {
    it("unrecognized stored outcome string reads back as 'unknown'", () => {
      // Bypass DAO to insert a row with an unrecognized outcome (simulating legacy/foreign data)
      db.exec(`
        INSERT INTO cliff_events (workspace_slug, step_id, source, detected_at, recovery_outcome, recorded_at)
        VALUES ('ws', 'step', 'resume', '2026-06-07T10:00:00.000Z', 'bogus_outcome', '2026-06-07T10:00:00.000Z')
      `);

      const rows = dao.getAll();
      expect(rows).toHaveLength(1);
      // Unrecognized value must be mapped to "unknown"
      expect(rows[0].recovery_outcome).toBe("unknown");
    });
  });
});
