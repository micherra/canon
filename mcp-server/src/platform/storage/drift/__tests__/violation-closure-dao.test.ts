/**
 * ViolationClosureDao tests (TDD — written before implementation)
 *
 * Tests the full public surface of ViolationClosureDao:
 *  - supersedeOpenViolations: per-pair resolution with false-close guards
 *  - resolveViolationsByPairs: idempotent batch resolution with counts
 *  - getViolationsByReviewId: status-aware read (default=open, opt-in=all)
 *  - countOpenViolations: scalar open count
 *
 * Uses in-memory SQLite (:memory:) via initDriftDb for full schema + migration.
 * Each test gets an isolated DB (beforeEach pattern or inline helpers).
 */

import type Database from "better-sqlite3";
import { beforeEach, describe, expect, test } from "vitest";
import { initDriftDb } from "../drift-schema.ts";
import { ViolationClosureDao } from "../violation-closure-dao.ts";

// ---- Test helpers ----

/** Create a fresh fully-migrated in-memory DB for each test. */
function freshDb(): Database.Database {
  return initDriftDb(":memory:");
}

/** Insert a review row (required for FK constraint on violations). */
function insertReview(db: Database.Database, reviewId: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO reviews (review_id, timestamp, files, honored, score, verdict)
     VALUES (?, '2026-01-01T00:00:00Z', '[]', '[]', '{}', 'BLOCKING')`,
  ).run(reviewId);
}

/** Insert a violation row with explicit status (defaults to 'open'). */
function insertViolation(
  db: Database.Database,
  opts: {
    reviewId: string;
    principleId: string;
    filePath?: string | null;
    status?: string;
  },
): number {
  const status = opts.status ?? "open";
  const filePath = opts.filePath === undefined ? null : opts.filePath;
  const result = db
    .prepare(
      `INSERT INTO violations (review_id, principle_id, severity, file_path, status)
       VALUES (?, ?, 'warning', ?, ?)`,
    )
    .run(opts.reviewId, opts.principleId, filePath, status);
  return Number(result.lastInsertRowid);
}

// ---- supersedeOpenViolations ----

describe("ViolationClosureDao.supersedeOpenViolations", () => {
  let db: Database.Database;
  let dao: ViolationClosureDao;

  beforeEach(() => {
    db = freshDb();
    dao = new ViolationClosureDao(db);
  });

  test("resolves (file_path, principle_id) when F∈files and P∈honored and no (F,P) violation in new review", () => {
    // Seed: open violation for (src/foo.ts, simplicity-first)
    insertReview(db, "rev-old");
    insertViolation(db, {
      reviewId: "rev-old",
      principleId: "simplicity-first",
      filePath: "src/foo.ts",
    });

    // New review: files=[src/foo.ts], honored=[simplicity-first], no violations
    insertReview(db, "rev-new");
    const ts = "2026-06-08T00:00:00Z";
    const count = dao.supersedeOpenViolations({
      reviewId: "rev-new",
      files: ["src/foo.ts"],
      honored: ["simplicity-first"],
      recordedViolations: [],
      timestamp: ts,
    });

    expect(count).toBe(1);
    // Row still exists (no delete)
    const row = db
      .prepare(
        `SELECT status, resolved_by_review_id, resolved_at, resolution_reason FROM violations WHERE review_id = 'rev-old'`,
      )
      .get() as {
      status: string;
      resolved_by_review_id: string;
      resolved_at: string;
      resolution_reason: string;
    };
    expect(row.status).toBe("resolved");
    expect(row.resolved_by_review_id).toBe("rev-new");
    expect(row.resolved_at).toBe(ts);
    expect(row.resolution_reason).toBe("superseded-by-clean-review");
  });

  test("does NOT resolve when principle_id NOT in honored (false-close guard)", () => {
    // Seed: open violation for (src/foo.ts, errors-are-values)
    insertReview(db, "rev-old");
    insertViolation(db, {
      reviewId: "rev-old",
      principleId: "errors-are-values",
      filePath: "src/foo.ts",
    });

    // New review honors Q=simplicity-first only, not errors-are-values
    insertReview(db, "rev-new");
    const count = dao.supersedeOpenViolations({
      reviewId: "rev-new",
      files: ["src/foo.ts"],
      honored: ["simplicity-first"], // honored does NOT include errors-are-values
      recordedViolations: [],
      timestamp: "2026-06-08T00:00:00Z",
    });

    expect(count).toBe(0);
    const row = db.prepare(`SELECT status FROM violations WHERE review_id = 'rev-old'`).get() as {
      status: string;
    };
    expect(row.status).toBe("open");
  });

  test("does NOT resolve when the new review records a violation for (F, P)", () => {
    // Seed: open violation for (src/foo.ts, simplicity-first)
    insertReview(db, "rev-old");
    insertViolation(db, {
      reviewId: "rev-old",
      principleId: "simplicity-first",
      filePath: "src/foo.ts",
    });

    // New review: honored includes simplicity-first BUT also records a violation for (src/foo.ts, simplicity-first)
    insertReview(db, "rev-new");
    const count = dao.supersedeOpenViolations({
      reviewId: "rev-new",
      files: ["src/foo.ts"],
      honored: ["simplicity-first"],
      recordedViolations: [{ principle_id: "simplicity-first", file_path: "src/foo.ts" }], // still violated in new review
      timestamp: "2026-06-08T00:00:00Z",
    });

    expect(count).toBe(0);
    const row = db.prepare(`SELECT status FROM violations WHERE review_id = 'rev-old'`).get() as {
      status: string;
    };
    expect(row.status).toBe("open");
  });

  test("does NOT resolve when file_path NOT in reviewed files", () => {
    // Seed: open violation for (src/bar.ts, simplicity-first)
    insertReview(db, "rev-old");
    insertViolation(db, {
      reviewId: "rev-old",
      principleId: "simplicity-first",
      filePath: "src/bar.ts",
    });

    // New review covers src/foo.ts, not src/bar.ts
    insertReview(db, "rev-new");
    const count = dao.supersedeOpenViolations({
      reviewId: "rev-new",
      files: ["src/foo.ts"], // src/bar.ts NOT in files
      honored: ["simplicity-first"],
      recordedViolations: [],
      timestamp: "2026-06-08T00:00:00Z",
    });

    expect(count).toBe(0);
    const row = db.prepare(`SELECT status FROM violations WHERE review_id = 'rev-old'`).get() as {
      status: string;
    };
    expect(row.status).toBe("open");
  });

  test("resolves NULL-file (process) violation when P∈honored and no P violation in new review", () => {
    // Seed: process violation (file_path=null) for errors-are-values
    insertReview(db, "rev-old");
    insertViolation(db, { reviewId: "rev-old", principleId: "errors-are-values", filePath: null });

    insertReview(db, "rev-new");
    const count = dao.supersedeOpenViolations({
      reviewId: "rev-new",
      files: [], // files irrelevant for null-file violations
      honored: ["errors-are-values"],
      recordedViolations: [], // no errors-are-values violation in new review
      timestamp: "2026-06-08T00:00:00Z",
    });

    expect(count).toBe(1);
    const row = db.prepare(`SELECT status FROM violations WHERE review_id = 'rev-old'`).get() as {
      status: string;
    };
    expect(row.status).toBe("resolved");
  });

  test("does NOT resolve NULL-file violation when new review records P violation", () => {
    insertReview(db, "rev-old");
    insertViolation(db, { reviewId: "rev-old", principleId: "errors-are-values", filePath: null });

    insertReview(db, "rev-new");
    const count = dao.supersedeOpenViolations({
      reviewId: "rev-new",
      files: [],
      honored: ["errors-are-values"],
      recordedViolations: [{ principle_id: "errors-are-values", file_path: null }], // P still violated
      timestamp: "2026-06-08T00:00:00Z",
    });

    expect(count).toBe(0);
  });

  test("is idempotent — already-resolved rows are not re-touched (status='open' guard)", () => {
    insertReview(db, "rev-old");
    insertViolation(db, {
      reviewId: "rev-old",
      principleId: "simplicity-first",
      filePath: "src/foo.ts",
    });

    insertReview(db, "rev-new");
    const ts = "2026-06-08T00:00:00Z";

    // First call resolves
    const first = dao.supersedeOpenViolations({
      reviewId: "rev-new",
      files: ["src/foo.ts"],
      honored: ["simplicity-first"],
      recordedViolations: [],
      timestamp: ts,
    });
    expect(first).toBe(1);

    // Second call finds no open rows → 0
    const second = dao.supersedeOpenViolations({
      reviewId: "rev-new",
      files: ["src/foo.ts"],
      honored: ["simplicity-first"],
      recordedViolations: [],
      timestamp: ts,
    });
    expect(second).toBe(0);
  });

  test("returns 0 when honored list is empty", () => {
    insertReview(db, "rev-old");
    insertViolation(db, {
      reviewId: "rev-old",
      principleId: "simplicity-first",
      filePath: "src/foo.ts",
    });

    insertReview(db, "rev-new");
    const count = dao.supersedeOpenViolations({
      reviewId: "rev-new",
      files: ["src/foo.ts"],
      honored: [],
      recordedViolations: [],
      timestamp: "2026-06-08T00:00:00Z",
    });
    expect(count).toBe(0);
  });

  test("does NOT issue DELETE — resolved row still exists in violations table", () => {
    insertReview(db, "rev-old");
    insertViolation(db, {
      reviewId: "rev-old",
      principleId: "simplicity-first",
      filePath: "src/foo.ts",
    });

    insertReview(db, "rev-new");
    dao.supersedeOpenViolations({
      reviewId: "rev-new",
      files: ["src/foo.ts"],
      honored: ["simplicity-first"],
      recordedViolations: [],
      timestamp: "2026-06-08T00:00:00Z",
    });

    const count = (
      db.prepare(`SELECT COUNT(*) as c FROM violations WHERE review_id = 'rev-old'`).get() as {
        c: number;
      }
    ).c;
    expect(count).toBe(1); // row exists, only status changed
  });
});

// ---- resolveViolationsByPairs ----

describe("ViolationClosureDao.resolveViolationsByPairs", () => {
  let db: Database.Database;
  let dao: ViolationClosureDao;

  beforeEach(() => {
    db = freshDb();
    dao = new ViolationClosureDao(db);
  });

  test("resolves open rows matching (file_path, principle_id) specs and returns resolved_count", () => {
    insertReview(db, "rev-old");
    insertViolation(db, {
      reviewId: "rev-old",
      principleId: "simplicity-first",
      filePath: "src/foo.ts",
    });

    const result = dao.resolveViolationsByPairs(
      [{ file_path: "src/foo.ts", principle_id: "simplicity-first" }],
      "stale-backfill",
      "2026-06-08T00:00:00Z",
    );

    expect(result.resolved_count).toBe(1);
    expect(result.already_resolved_count).toBe(0);

    const row = db
      .prepare(`SELECT status, resolution_reason FROM violations WHERE review_id = 'rev-old'`)
      .get() as { status: string; resolution_reason: string };
    expect(row.status).toBe("resolved");
    expect(row.resolution_reason).toBe("stale-backfill");
  });

  test("counts already-resolved rows in already_resolved_count (idempotency check)", () => {
    insertReview(db, "rev-old");
    insertViolation(db, {
      reviewId: "rev-old",
      principleId: "simplicity-first",
      filePath: "src/foo.ts",
      status: "resolved",
    });

    const result = dao.resolveViolationsByPairs(
      [{ file_path: "src/foo.ts", principle_id: "simplicity-first" }],
      "stale-backfill",
      "2026-06-08T00:00:00Z",
    );

    expect(result.resolved_count).toBe(0);
    expect(result.already_resolved_count).toBe(1);
  });

  test("second call returns resolved_count=0 and already_resolved_count>0 — no reopen", () => {
    insertReview(db, "rev-old");
    insertViolation(db, {
      reviewId: "rev-old",
      principleId: "simplicity-first",
      filePath: "src/foo.ts",
    });

    const specs = [{ file_path: "src/foo.ts", principle_id: "simplicity-first" }];
    const ts = "2026-06-08T00:00:00Z";

    const first = dao.resolveViolationsByPairs(specs, "stale-backfill", ts);
    expect(first.resolved_count).toBe(1);

    const second = dao.resolveViolationsByPairs(specs, "stale-backfill", ts);
    expect(second.resolved_count).toBe(0);
    expect(second.already_resolved_count).toBe(1);

    // Row must still be 'resolved', not reverted
    const row = db.prepare(`SELECT status FROM violations WHERE review_id = 'rev-old'`).get() as {
      status: string;
    };
    expect(row.status).toBe("resolved");
  });

  test("empty specs → { resolved_count: 0, already_resolved_count: 0 } (no error)", () => {
    const result = dao.resolveViolationsByPairs([], "stale-backfill", "2026-06-08T00:00:00Z");
    expect(result.resolved_count).toBe(0);
    expect(result.already_resolved_count).toBe(0);
  });

  test("matches null-file specs (file_path: null) against null-file rows", () => {
    insertReview(db, "rev-old");
    insertViolation(db, { reviewId: "rev-old", principleId: "errors-are-values", filePath: null });

    const result = dao.resolveViolationsByPairs(
      [{ file_path: null, principle_id: "errors-are-values" }],
      "stale-backfill",
      "2026-06-08T00:00:00Z",
    );

    expect(result.resolved_count).toBe(1);
  });

  test("does not match a file-path spec against null-file rows", () => {
    insertReview(db, "rev-old");
    insertViolation(db, { reviewId: "rev-old", principleId: "errors-are-values", filePath: null });

    const result = dao.resolveViolationsByPairs(
      [{ file_path: "src/foo.ts", principle_id: "errors-are-values" }], // file path given but row has null
      "stale-backfill",
      "2026-06-08T00:00:00Z",
    );

    expect(result.resolved_count).toBe(0);
  });
});

// ---- getViolationsByReviewId ----

describe("ViolationClosureDao.getViolationsByReviewId", () => {
  let db: Database.Database;
  let dao: ViolationClosureDao;

  beforeEach(() => {
    db = freshDb();
    dao = new ViolationClosureDao(db);
  });

  test("default (no opts) excludes resolved violations and returns only open ones", () => {
    insertReview(db, "rev-x");
    insertViolation(db, {
      reviewId: "rev-x",
      principleId: "simplicity-first",
      filePath: "src/a.ts",
    }); // open
    insertViolation(db, {
      reviewId: "rev-x",
      principleId: "errors-are-values",
      filePath: "src/b.ts",
      status: "resolved",
    }); // resolved

    const rows = dao.getViolationsByReviewId("rev-x");
    expect(rows.length).toBe(1);
    expect(rows[0]!.principle_id).toBe("simplicity-first");
  });

  test("includeResolved: true returns both open and resolved rows", () => {
    insertReview(db, "rev-x");
    insertViolation(db, {
      reviewId: "rev-x",
      principleId: "simplicity-first",
      filePath: "src/a.ts",
    });
    insertViolation(db, {
      reviewId: "rev-x",
      principleId: "errors-are-values",
      filePath: "src/b.ts",
      status: "resolved",
    });

    const rows = dao.getViolationsByReviewId("rev-x", { includeResolved: true });
    expect(rows.length).toBe(2);
  });

  test("returns empty array for an unknown reviewId (define-errors-out-of-existence)", () => {
    const rows = dao.getViolationsByReviewId("nonexistent");
    expect(rows).toEqual([]);
  });

  test("returned ViolationRow includes the status field", () => {
    insertReview(db, "rev-x");
    insertViolation(db, {
      reviewId: "rev-x",
      principleId: "simplicity-first",
      filePath: "src/a.ts",
    });

    const rows = dao.getViolationsByReviewId("rev-x", { includeResolved: true });
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("open");
  });
});

// ---- countOpenViolations ----

describe("ViolationClosureDao.countOpenViolations", () => {
  let db: Database.Database;
  let dao: ViolationClosureDao;

  beforeEach(() => {
    db = freshDb();
    dao = new ViolationClosureDao(db);
  });

  test("returns 0 when no violations exist", () => {
    expect(dao.countOpenViolations()).toBe(0);
  });

  test("counts only open violations", () => {
    insertReview(db, "rev-y");
    insertViolation(db, {
      reviewId: "rev-y",
      principleId: "simplicity-first",
      filePath: "src/a.ts",
    });
    insertViolation(db, {
      reviewId: "rev-y",
      principleId: "errors-are-values",
      filePath: "src/b.ts",
      status: "resolved",
    });

    expect(dao.countOpenViolations()).toBe(1);
  });

  test("decrements after resolution", () => {
    insertReview(db, "rev-y");
    insertViolation(db, {
      reviewId: "rev-y",
      principleId: "simplicity-first",
      filePath: "src/a.ts",
    });

    expect(dao.countOpenViolations()).toBe(1);

    dao.resolveViolationsByPairs(
      [{ file_path: "src/a.ts", principle_id: "simplicity-first" }],
      "stale-backfill",
      "2026-06-08T00:00:00Z",
    );

    expect(dao.countOpenViolations()).toBe(0);
  });
});
