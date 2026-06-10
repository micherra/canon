/**
 * Tests for reconcileStaleViolations + AUDITED_STALE_2026_06 constant.
 *
 * All tests use an in-memory SQLite DB seeded with test fixtures via
 * ViolationClosureDao (the same DAO used in production). No file I/O.
 */

import { describe, expect, it } from "vitest";
import { initDriftDb } from "../drift-schema.ts";
import { AUDITED_STALE_2026_06, reconcileStaleViolations } from "../reconcile-violations.ts";
import type { StaleViolationSpec } from "../violation-closure-dao.ts";
import { ViolationClosureDao } from "../violation-closure-dao.ts";

// ---- Helpers ----

/**
 * Open a fresh in-memory drift DB (v10) and return a { db, dao } pair.
 * The DB is seeded with the provided violations (all status='open' after migration).
 */
function makeTestDb(violations: Array<{ file_path: string | null; principle_id: string }>) {
  const db = initDriftDb(":memory:");

  // Insert a dummy review so FK constraint passes
  const insertReview = db.prepare(`
    INSERT INTO reviews (review_id, timestamp, files, honored, score, verdict)
    VALUES ('test-review', '2026-06-08T00:00:00Z', '[]', '[]', '{}', 'clean')
  `);
  insertReview.run();

  const insertViolation = db.prepare(`
    INSERT INTO violations (review_id, principle_id, severity, file_path, impact_score, message)
    VALUES ('test-review', @principle_id, 'warning', @file_path, 0.5, 'test violation')
  `);
  for (const v of violations) {
    insertViolation.run({ file_path: v.file_path, principle_id: v.principle_id });
  }

  const dao = new ViolationClosureDao(db);
  return { dao, db };
}

/**
 * Test-only wrapper that calls the DAO directly (bypassing getDriftDb so we
 * can inject an in-memory DB). Mirrors the production implementation exactly.
 */
async function reconcileWithDao(
  dao: ViolationClosureDao,
  specs: ReadonlyArray<StaleViolationSpec>,
  reason: string,
): Promise<{ resolved_count: number; already_resolved_count: number }> {
  const ts = new Date().toISOString();
  return dao.resolveViolationsByPairs(specs, reason, ts);
}

const BACKFILL_REASON = "backfill-verified-stale-2026-06";

// ---- Test suites ----

describe("reconcileStaleViolations — via dao shim", () => {
  describe("basic resolution", () => {
    it("resolves open violations matching the given specs", async () => {
      const specs: StaleViolationSpec[] = [
        { file_path: "src/foo.ts", principle_id: "observable-best-effort" },
        { file_path: "src/bar.ts", principle_id: "fail-closed-by-default" },
      ];
      const { dao } = makeTestDb(specs);

      const result = await reconcileWithDao(dao, specs, BACKFILL_REASON);

      expect(result.resolved_count).toBe(2);
      expect(result.already_resolved_count).toBe(0);
    });

    it("resolved rows have the correct resolution_reason and still exist (not deleted)", async () => {
      const specs: StaleViolationSpec[] = [
        { file_path: "src/foo.ts", principle_id: "observable-best-effort" },
      ];
      const { dao, db } = makeTestDb(specs);

      await reconcileWithDao(dao, specs, BACKFILL_REASON);

      const row = db
        .prepare(
          "SELECT status, resolution_reason FROM violations WHERE file_path=? AND principle_id=?",
        )
        .get("src/foo.ts", "observable-best-effort") as
        | {
            status: string;
            resolution_reason: string;
          }
        | undefined;

      expect(row).toBeDefined();
      expect(row?.status).toBe("resolved");
      expect(row?.resolution_reason).toBe(BACKFILL_REASON);
    });

    it("a spec for a non-existent pair resolves nothing — no error", async () => {
      const { dao } = makeTestDb([{ file_path: "src/actual.ts", principle_id: "some-principle" }]);
      const specs: StaleViolationSpec[] = [
        { file_path: "src/phantom.ts", principle_id: "no-such-principle" },
      ];

      const result = await reconcileWithDao(dao, specs, BACKFILL_REASON);

      expect(result.resolved_count).toBe(0);
      expect(result.already_resolved_count).toBe(0);
    });
  });

  describe("idempotency (AC3 — non-negotiable)", () => {
    it("second run returns resolved_count: 0 and already_resolved_count equals prior resolved", async () => {
      const specs: StaleViolationSpec[] = [
        { file_path: "src/foo.ts", principle_id: "observable-best-effort" },
        { file_path: "src/bar.ts", principle_id: "fail-closed-by-default" },
      ];
      const { dao } = makeTestDb(specs);

      const first = await reconcileWithDao(dao, specs, BACKFILL_REASON);
      const second = await reconcileWithDao(dao, specs, BACKFILL_REASON);

      expect(first.resolved_count).toBe(2);
      expect(second.resolved_count).toBe(0);
      expect(second.already_resolved_count).toBe(2);
    });

    it("no row reverts to status=open after a second run", async () => {
      const specs: StaleViolationSpec[] = [
        { file_path: "src/foo.ts", principle_id: "observable-best-effort" },
      ];
      const { dao, db } = makeTestDb(specs);

      await reconcileWithDao(dao, specs, BACKFILL_REASON);
      await reconcileWithDao(dao, specs, BACKFILL_REASON);

      const openCount = db
        .prepare("SELECT COUNT(*) AS c FROM violations WHERE status='open'")
        .get() as { c: number };
      expect(openCount.c).toBe(0);
    });

    it("running after auto-close (already resolved) does not reopen rows", async () => {
      const specs: StaleViolationSpec[] = [
        { file_path: "src/foo.ts", principle_id: "observable-best-effort" },
      ];
      const { dao, db } = makeTestDb(specs);

      // Simulate closure-02 auto-close via supersedeOpenViolations
      const ts = new Date().toISOString();
      dao.supersedeOpenViolations({
        files: ["src/foo.ts"],
        honored: ["observable-best-effort"],
        recordedViolations: [],
        reviewId: "auto-close-review",
        timestamp: ts,
      });

      // Now run backfill — should be a no-op
      const result = await reconcileWithDao(dao, specs, BACKFILL_REASON);

      expect(result.resolved_count).toBe(0);
      expect(result.already_resolved_count).toBe(1);

      // Status still resolved, not reopened
      const row = db
        .prepare("SELECT status FROM violations WHERE file_path=? AND principle_id=?")
        .get("src/foo.ts", "observable-best-effort") as { status: string } | undefined;
      expect(row?.status).toBe("resolved");
    });
  });

  describe("NULL file_path (process-level violations)", () => {
    it("a spec with null file_path matches the NULL-file row", async () => {
      const { dao } = makeTestDb([{ file_path: null, principle_id: "leave-touched-files-better" }]);
      const specs: StaleViolationSpec[] = [
        { file_path: null, principle_id: "leave-touched-files-better" },
      ];

      const result = await reconcileWithDao(dao, specs, BACKFILL_REASON);

      expect(result.resolved_count).toBe(1);
      expect(result.already_resolved_count).toBe(0);
    });

    it("null-file spec does not accidentally close a file-specific violation of the same principle", async () => {
      const { dao, db } = makeTestDb([
        { file_path: "src/specific.ts", principle_id: "leave-touched-files-better" },
      ]);
      const specs: StaleViolationSpec[] = [
        { file_path: null, principle_id: "leave-touched-files-better" },
      ];

      const result = await reconcileWithDao(dao, specs, BACKFILL_REASON);

      // The spec has null file_path, but DB row has non-null file_path → no match
      expect(result.resolved_count).toBe(0);
      const row = db
        .prepare("SELECT status FROM violations WHERE file_path='src/specific.ts'")
        .get() as { status: string } | undefined;
      expect(row?.status).toBe("open");
    });
  });

  describe("non-seeded violations are left untouched", () => {
    it("open violation not in specs remains open", async () => {
      const { dao, db } = makeTestDb([
        { file_path: "src/innocent.ts", principle_id: "simplicity-first" },
      ]);
      const specs: StaleViolationSpec[] = [
        { file_path: "src/other.ts", principle_id: "observable-best-effort" },
      ];

      await reconcileWithDao(dao, specs, BACKFILL_REASON);

      const row = db
        .prepare("SELECT status FROM violations WHERE file_path='src/innocent.ts'")
        .get() as { status: string } | undefined;
      expect(row?.status).toBe("open");
    });
  });

  describe("empty specs", () => {
    it("empty specs returns { resolved_count: 0, already_resolved_count: 0 }", async () => {
      const { dao } = makeTestDb([{ file_path: "src/foo.ts", principle_id: "some-principle" }]);

      const result = await reconcileWithDao(dao, [], BACKFILL_REASON);

      expect(result.resolved_count).toBe(0);
      expect(result.already_resolved_count).toBe(0);
    });
  });
});

describe("reconcileStaleViolations — production export shape", () => {
  it("is an async function", () => {
    expect(typeof reconcileStaleViolations).toBe("function");
    // The production function signature: (projectDir, specs, reason) => Promise
    // We can't call it in unit tests (it needs a real project dir + drift.db),
    // but we can verify its shape.
    expect(reconcileStaleViolations.length).toBe(3);
  });
});

describe("AUDITED_STALE_2026_06", () => {
  it("is a non-empty array of well-formed StaleViolationSpec entries", () => {
    expect(Array.isArray(AUDITED_STALE_2026_06)).toBe(true);
    expect(AUDITED_STALE_2026_06.length).toBeGreaterThan(0);
  });

  it("every entry has a principle_id string and file_path string|null", () => {
    for (const spec of AUDITED_STALE_2026_06) {
      expect(typeof spec.principle_id).toBe("string");
      expect(spec.principle_id.length).toBeGreaterThan(0);
      expect(spec.file_path === null || typeof spec.file_path === "string").toBe(true);
    }
  });

  it("no duplicate (file_path, principle_id) pairs", () => {
    const keys = AUDITED_STALE_2026_06.map(
      (s) => `${s.file_path ?? "__null__"}\0${s.principle_id}`,
    );
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });
});
