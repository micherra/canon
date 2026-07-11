/**
 * applied-evolutions-dao-backfill.test.ts
 *
 * Tests for AppliedEvolutionsDao.backfillApplyingCommit — the Inc-3 null-only,
 * idempotent, counted UPDATE that populates `applying_commit` from parsed
 * `Canon-Evolution:` trailer pairs.
 *
 * Uses an in-memory SQLite DB (initDriftDb(':memory:')) to avoid file system
 * side effects — same pattern as applied-evolutions-dao.test.ts.
 *
 * Test plan (task Step 6, cases a-e):
 * (a) seed a row with applying_commit = null; backfill sets it and returns 1
 * (b) re-run returns 0 (idempotent)
 * (c) a row with a pre-existing non-null applying_commit is NOT clobbered
 * (d) empty pairs -> 0, no DB work
 * (e) unknown proposal_id -> 0
 */

import { describe, expect, it } from "vitest";
import {
  AppliedEvolutionsDao,
  type BackfillPair,
  type RecordAppliedEvolutionInput,
} from "../applied-evolutions-dao.ts";
import { initDriftDb } from "../drift-schema.ts";

function makeDb() {
  return initDriftDb(":memory:");
}

function baseInput(
  overrides: Partial<RecordAppliedEvolutionInput> = {},
): RecordAppliedEvolutionInput {
  return {
    after_hash: "sha-after",
    applied_at: "2026-07-10T12:00:00.000Z",
    artifact_class: "rule",
    before_hash: "sha-before",
    holdout_baseline: 10,
    holdout_candidate: 12,
    principle_id: "agent-tdd-required",
    proposal_id: "evolve-20260710-01",
    target_path: "rules/agent-tdd-required.md",
    ...overrides,
  };
}

describe("AppliedEvolutionsDao.backfillApplyingCommit", () => {
  it("(a) sets applying_commit on a null row and returns 1", () => {
    const db = makeDb();
    const dao = new AppliedEvolutionsDao(db);
    dao.record(baseInput());

    const pairs: BackfillPair[] = [
      { applying_commit: "abc123", proposal_id: "evolve-20260710-01" },
    ];
    const updated = dao.backfillApplyingCommit(pairs);

    expect(updated).toBe(1);
    const row = dao.getByProposalId("evolve-20260710-01");
    expect(row?.applying_commit).toBe("abc123");
  });

  it("(b) re-running the same backfill is idempotent — returns 0 on the second pass", () => {
    const db = makeDb();
    const dao = new AppliedEvolutionsDao(db);
    dao.record(baseInput());

    const pairs: BackfillPair[] = [
      { applying_commit: "abc123", proposal_id: "evolve-20260710-01" },
    ];
    expect(dao.backfillApplyingCommit(pairs)).toBe(1);
    expect(dao.backfillApplyingCommit(pairs)).toBe(0);
    expect(dao.getByProposalId("evolve-20260710-01")?.applying_commit).toBe("abc123");
  });

  it("(c) never clobbers a pre-existing non-null applying_commit", () => {
    const db = makeDb();
    const dao = new AppliedEvolutionsDao(db);
    dao.record(baseInput({ applying_commit: "already-set" }));

    const updated = dao.backfillApplyingCommit([
      { applying_commit: "new-value", proposal_id: "evolve-20260710-01" },
    ]);

    expect(updated).toBe(0);
    expect(dao.getByProposalId("evolve-20260710-01")?.applying_commit).toBe("already-set");
  });

  it("(d) empty pairs returns 0 with no DB work", () => {
    const db = makeDb();
    const dao = new AppliedEvolutionsDao(db);
    dao.record(baseInput());

    expect(dao.backfillApplyingCommit([])).toBe(0);
    expect(dao.getByProposalId("evolve-20260710-01")?.applying_commit).toBeNull();
  });

  it("(e) an unknown proposal_id updates 0 rows", () => {
    const db = makeDb();
    const dao = new AppliedEvolutionsDao(db);
    dao.record(baseInput());

    const updated = dao.backfillApplyingCommit([
      { applying_commit: "abc123", proposal_id: "nope-does-not-exist" },
    ]);

    expect(updated).toBe(0);
    expect(dao.getByProposalId("evolve-20260710-01")?.applying_commit).toBeNull();
  });

  it("processes multiple pairs in one transaction, summing per-row changes", () => {
    const db = makeDb();
    const dao = new AppliedEvolutionsDao(db);
    dao.record(baseInput({ proposal_id: "p-1" }));
    dao.record(baseInput({ proposal_id: "p-2" }));
    dao.record(baseInput({ applying_commit: "locked-in", proposal_id: "p-3" }));

    const updated = dao.backfillApplyingCommit([
      { applying_commit: "sha-1", proposal_id: "p-1" },
      { applying_commit: "sha-2", proposal_id: "p-2" },
      { applying_commit: "sha-3-ignored", proposal_id: "p-3" },
      { applying_commit: "sha-4", proposal_id: "nope" },
    ]);

    expect(updated).toBe(2);
    expect(dao.getByProposalId("p-1")?.applying_commit).toBe("sha-1");
    expect(dao.getByProposalId("p-2")?.applying_commit).toBe("sha-2");
    expect(dao.getByProposalId("p-3")?.applying_commit).toBe("locked-in");
  });
});
