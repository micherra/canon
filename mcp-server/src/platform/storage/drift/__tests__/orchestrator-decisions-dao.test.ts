/**
 * orchestrator-decisions-dao.test.ts
 *
 * Tests for OrchestratorDecisionsDao — the durable, cross-workspace decisions
 * corpus table (drift.db v14, table `orchestrator_decisions`, ADR-0040).
 * Uses an in-memory SQLite DB (initDriftDb(':memory:')) to avoid file system
 * side effects.
 *
 * Test plan (T-01-PLAN.md):
 * - migration v13->v14 creates the table; fresh :memory: db reaches schema_version 14
 * - persistMany inserts N rows
 * - persistMany is idempotent: double-persist with the same records -> still N rows
 * - refs round-trips via refs_json
 * - getBySlug filters by source_slug
 * - getAll returns everything, ordered
 */

import type { DecisionRecord } from "@shared/lib/decision-event-reader.ts";
import { beforeEach, describe, expect, it } from "vitest";
import { DRIFT_SCHEMA_VERSION, initDriftDb } from "../drift-schema.ts";
import { OrchestratorDecisionsDao } from "../orchestrator-decisions-dao.ts";

function makeDb() {
  return initDriftDb(":memory:");
}

function makeRecord(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    decided_at: "2026-07-01T10:00:00.000Z",
    decision_type: "hitl_gate",
    source_event_id: 1,
    summary: "Approved the plan",
    ...overrides,
  };
}

describe("OrchestratorDecisionsDao", () => {
  let db: ReturnType<typeof makeDb>;
  let dao: OrchestratorDecisionsDao;

  beforeEach(() => {
    db = makeDb();
    dao = new OrchestratorDecisionsDao(db);
  });

  describe("migration", () => {
    it("fresh DB has orchestrator_decisions table after initDriftDb", () => {
      const rows = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='orchestrator_decisions'",
        )
        .all() as Array<{ name: string }>;
      expect(rows).toHaveLength(1);
    });

    it("fresh :memory: db reaches schema version 14", () => {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      expect(row.value).toBe("14");
      expect(DRIFT_SCHEMA_VERSION).toBe("14");
    });
  });

  describe("persistMany", () => {
    it("inserts N rows for a slug", () => {
      dao.persistMany("slug-a", [
        makeRecord({ source_event_id: 1, summary: "first" }),
        makeRecord({ source_event_id: 2, summary: "second" }),
      ]);

      const rows = dao.getBySlug("slug-a");
      expect(rows).toHaveLength(2);
    });

    it("is idempotent: persisting the same records twice still yields N rows", () => {
      const records = [
        makeRecord({ source_event_id: 1, summary: "first" }),
        makeRecord({ source_event_id: 2, summary: "second" }),
      ];
      dao.persistMany("slug-b", records);
      dao.persistMany("slug-b", records);

      const rows = dao.getBySlug("slug-b");
      expect(rows).toHaveLength(2);
    });

    it("round-trips refs via refs_json", () => {
      dao.persistMany("slug-c", [makeRecord({ refs: ["DESIGN.md", "AC#3"], source_event_id: 1 })]);

      const rows = dao.getBySlug("slug-c");
      expect(rows[0].refs).toEqual(["DESIGN.md", "AC#3"]);
    });

    it("persists an absent refs field as an empty array on read", () => {
      dao.persistMany("slug-d", [makeRecord({ source_event_id: 1 })]);

      const rows = dao.getBySlug("slug-d");
      expect(rows[0].refs).toEqual([]);
    });

    it("carries the gate column through, distinct from decision_type", () => {
      dao.persistMany("slug-e", [
        makeRecord({ decision_type: "hitl_gate", gate: "review_verdict", source_event_id: 1 }),
      ]);

      const rows = dao.getBySlug("slug-e");
      expect(rows[0].decision_type).toBe("hitl_gate");
      expect(rows[0].gate).toBe("review_verdict");
    });

    it("stamps persisted_at at insert time", () => {
      const before = new Date().toISOString();
      dao.persistMany("slug-f", [makeRecord({ source_event_id: 1 })]);
      const after = new Date().toISOString();

      const rows = dao.getBySlug("slug-f");
      expect(rows[0].persisted_at >= before).toBe(true);
      expect(rows[0].persisted_at <= after).toBe(true);
    });
  });

  describe("getBySlug", () => {
    it("filters to only the requested slug", () => {
      dao.persistMany("slug-x", [makeRecord({ source_event_id: 1 })]);
      dao.persistMany("slug-y", [makeRecord({ source_event_id: 1 })]);

      expect(dao.getBySlug("slug-x")).toHaveLength(1);
      expect(dao.getBySlug("slug-y")).toHaveLength(1);
      expect(dao.getBySlug("slug-nonexistent")).toEqual([]);
    });
  });

  describe("getAll", () => {
    it("returns rows across every slug", () => {
      dao.persistMany("slug-1", [makeRecord({ source_event_id: 1 })]);
      dao.persistMany("slug-2", [makeRecord({ source_event_id: 1 })]);

      expect(dao.getAll()).toHaveLength(2);
    });

    it("returns [] when the table is empty", () => {
      expect(dao.getAll()).toEqual([]);
    });
  });
});
