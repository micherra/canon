/**
 * applied-evolutions-dao.test.ts
 *
 * Tests for AppliedEvolutionsDao — durable apply-provenance store (drift v12).
 * Uses an in-memory SQLite DB (initDriftDb(':memory:')) to avoid file system side effects.
 *
 * Test plan (from apply-provenance-T1 plan):
 * - migration: fresh :memory: DB migrates to v12 and creates the applied_evolutions table + indexes
 * - record then getByProposalId round-trips all fields
 * - re-record same proposal_id upserts (one row, updated values) — UNIQUE(proposal_id)
 * - listAppliedSince filters (applied_at >= iso) + orders by applied_at ASC
 * - migrating an existing v11 DB adds the table without touching other tables
 * - runDriftMigrations idempotent on a v12 DB
 */

import type Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AppliedEvolutionRow,
  AppliedEvolutionsDao,
  type RecordAppliedEvolutionInput,
} from "../applied-evolutions-dao.ts";
import { columnExists, initDriftDb, runDriftMigrations } from "../drift-schema.ts";

function makeDb() {
  return initDriftDb(":memory:");
}

function baseInput(
  overrides: Partial<RecordAppliedEvolutionInput> = {},
): RecordAppliedEvolutionInput {
  return {
    after_hash: "sha-after",
    applied_at: "2026-07-02T12:00:00.000Z",
    apply_base_commit: "abc123",
    artifact_class: "rule",
    before_hash: "sha-before",
    holdout_baseline: 10,
    holdout_candidate: 12,
    principle_id: "agent-tdd-required",
    proposal_id: "evolve-20260702-01",
    target_path: "rules/agent-tdd-required.md",
    ...overrides,
  };
}

// Helper: build a v11 DB (all migrations through v11, one short of v12)
function createV11Db(): Database.Database {
  const db = initDriftDb(":memory:");
  // initDriftDb runs all migrations including v12. To simulate a v11 DB we can't
  // easily "downgrade", so instead we assert the v12 migration is present on a
  // fresh DB and additionally test the version-gated path from a hand-rolled v11.
  return db;
}

describe("AppliedEvolutionsDao", () => {
  let db: ReturnType<typeof makeDb>;
  let dao: AppliedEvolutionsDao;

  beforeEach(() => {
    db = makeDb();
    dao = new AppliedEvolutionsDao(db);
  });

  describe("migration", () => {
    it("fresh DB has applied_evolutions table after initDriftDb", () => {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='applied_evolutions'")
        .all() as Array<{ name: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe("applied_evolutions");
    });

    it("applied_evolutions has all expected columns", () => {
      for (const col of [
        "id",
        "proposal_id",
        "target_path",
        "artifact_class",
        "principle_id",
        "before_hash",
        "after_hash",
        "holdout_baseline",
        "holdout_candidate",
        "apply_base_commit",
        "applying_commit",
        "applied_at",
      ]) {
        expect(columnExists(db, "applied_evolutions", col)).toBe(true);
      }
    });

    it("creates both indexes (applied + principle)", () => {
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='applied_evolutions' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      const names = indexes.map((i) => i.name);
      expect(names).toContain("idx_applied_evolutions_applied");
      expect(names).toContain("idx_applied_evolutions_principle");
    });

    it("schema_version is '12' on a fresh DB", () => {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      expect(row.value).toBe("12");
    });

    it("runDriftMigrations is idempotent on a v12 DB", () => {
      expect(() => runDriftMigrations(db)).not.toThrow();
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='applied_evolutions'")
        .all() as Array<{ name: string }>;
      expect(rows).toHaveLength(1);
    });

    it("migrating an existing v11 DB adds the table without touching other tables", () => {
      // Build a v11 DB directly by running migrations then forcing meta back to 11
      // and dropping applied_evolutions to simulate the pre-v12 state.
      const v11 = createV11Db();
      v11.exec("DROP TABLE IF EXISTS applied_evolutions");
      v11.exec("UPDATE meta SET value = '11' WHERE key = 'schema_version'");
      // Seed a craft_profiles row to prove other tables are untouched.
      v11.exec(
        `INSERT INTO craft_profiles (subsystem_key, source, ratings, created_at)
         VALUES ('features/x', 'audit', '[]', '2026-01-01')`,
      );

      runDriftMigrations(v11);

      const tables = v11
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='applied_evolutions'")
        .all() as Array<{ name: string }>;
      expect(tables).toHaveLength(1);
      const craft = v11.prepare("SELECT COUNT(*) as c FROM craft_profiles").get() as { c: number };
      expect(craft.c).toBe(1);
      const ver = v11.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      expect(ver.value).toBe("12");
      v11.close();
    });
  });

  describe("record / getByProposalId", () => {
    it("round-trips all fields", () => {
      dao.record(baseInput());
      const row = dao.getByProposalId("evolve-20260702-01");
      expect(row).not.toBeNull();
      const r = row as AppliedEvolutionRow;
      expect(r.proposal_id).toBe("evolve-20260702-01");
      expect(r.target_path).toBe("rules/agent-tdd-required.md");
      expect(r.artifact_class).toBe("rule");
      expect(r.principle_id).toBe("agent-tdd-required");
      expect(r.before_hash).toBe("sha-before");
      expect(r.after_hash).toBe("sha-after");
      expect(r.holdout_baseline).toBe(10);
      expect(r.holdout_candidate).toBe(12);
      expect(r.apply_base_commit).toBe("abc123");
      expect(r.applying_commit).toBeNull();
      expect(r.applied_at).toBe("2026-07-02T12:00:00.000Z");
    });

    it("returns null for an unknown proposal_id", () => {
      expect(dao.getByProposalId("nope")).toBeNull();
    });

    it("stores a null principle_id (agent-def cliff target)", () => {
      dao.record(baseInput({ principle_id: null, proposal_id: "evolve-agent-01" }));
      const row = dao.getByProposalId("evolve-agent-01");
      expect(row?.principle_id).toBeNull();
    });

    it("re-recording the same proposal_id upserts (one row, updated values)", () => {
      dao.record(baseInput());
      dao.record(
        baseInput({ after_hash: "sha-after-v2", holdout_candidate: 15, applying_commit: "def456" }),
      );

      const count = db
        .prepare("SELECT COUNT(*) as c FROM applied_evolutions WHERE proposal_id = ?")
        .get("evolve-20260702-01") as { c: number };
      expect(count.c).toBe(1);

      const row = dao.getByProposalId("evolve-20260702-01");
      expect(row?.after_hash).toBe("sha-after-v2");
      expect(row?.holdout_candidate).toBe(15);
      expect(row?.applying_commit).toBe("def456");
    });
  });

  describe("listAppliedSince", () => {
    beforeEach(() => {
      dao.record(baseInput({ proposal_id: "p-early", applied_at: "2026-07-01T00:00:00.000Z" }));
      dao.record(baseInput({ proposal_id: "p-mid", applied_at: "2026-07-02T00:00:00.000Z" }));
      dao.record(baseInput({ proposal_id: "p-late", applied_at: "2026-07-03T00:00:00.000Z" }));
    });

    it("filters to rows at or after the given iso, ordered by applied_at ASC", () => {
      const rows = dao.listAppliedSince("2026-07-02T00:00:00.000Z");
      expect(rows.map((r) => r.proposal_id)).toEqual(["p-mid", "p-late"]);
    });

    it("returns [] when nothing is at or after the iso", () => {
      expect(dao.listAppliedSince("2026-08-01T00:00:00.000Z")).toEqual([]);
    });
  });
});
