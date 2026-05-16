/**
 * write-review-path-effects.test.ts
 *
 * Tests for updateFileViolationHistory helper and the optional signals
 * parameter on writeReview.
 *
 * Signal persistence tests use real temp directories with actual drift.db
 * via DriftDbSignals obtained from DriftDb.getSignals().
 * The non-blocking error test passes a mock SignalWriter that throws.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriftDb } from "@platform/storage/drift/drift-db.ts";
import { initDriftDb } from "@platform/storage/drift/drift-schema.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type SignalWriter,
  updateFileViolationHistory,
  type WriteReviewInput,
  writeReview,
} from "../tools/write-review.ts";

// ---- Test setup ----

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "write-review-path-effects-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { force: true, recursive: true });
});

/**
 * Open a DriftDb from a real temp directory and return its SignalWriter.
 * Ensures the .canon directory exists before opening the DB.
 * Note: getDriftDb caches by resolved path; we bypass the cache here
 * to read state written by updateFileViolationHistory.
 */
async function openSignalsFromDir(dir: string): Promise<{ signals: SignalWriter; db: DriftDb }> {
  const canonDir = join(dir, ".canon");
  await mkdir(canonDir, { recursive: true });
  const dbPath = join(canonDir, "drift.db");
  const rawDb = initDriftDb(dbPath);
  const db = new DriftDb(rawDb);
  return { db, signals: db.getSignals() };
}

function makeReviewInput(overrides: Partial<WriteReviewInput> = {}): WriteReviewInput {
  return {
    files: ["src/foo.ts"],
    honored: ["simplicity-first"],
    score: {
      conventions: { passed: 1, total: 1 },
      opinions: { passed: 1, total: 1 },
      rules: { passed: 1, total: 1 },
    },
    slug: "test-slug",
    verdict: "approved",
    violations: [],
    workspace: tmpDir,
    ...overrides,
  };
}

// ---- updateFileViolationHistory — file_violation_history ----

describe("updateFileViolationHistory — file_violation_history", () => {
  it("creates file_violation_history rows for violations with file_path", async () => {
    const { signals, db } = await openSignalsFromDir(tmpDir);

    updateFileViolationHistory(
      signals,
      ["src/foo.ts"],
      [{ file_path: "src/foo.ts", principle_id: "simplicity-first", severity: "strong-opinion" }],
      "WARNING",
    );

    // Re-read signals from the same db instance (same underlying connection)
    const rows = db.getSignals().getFileViolationHistory(["src/foo.ts"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].principle_id).toBe("simplicity-first");
    expect(rows[0].violation_count).toBe(1);
    db.close();
  });

  it("skips violations without file_path — no rows written", async () => {
    const { signals, db } = await openSignalsFromDir(tmpDir);

    updateFileViolationHistory(
      signals,
      ["src/foo.ts"],
      [{ principle_id: "simplicity-first", severity: "strong-opinion" }], // no file_path
      "WARNING",
    );

    const rows = db.getSignals().getFileViolationHistory(["src/foo.ts"]);
    expect(rows).toHaveLength(0);
    db.close();
  });

  it("increments violation_count on repeated calls for same (file, principle)", async () => {
    const { signals, db } = await openSignalsFromDir(tmpDir);

    const violation = {
      file_path: "src/foo.ts",
      principle_id: "errors-are-values",
      severity: "rule",
    };

    updateFileViolationHistory(signals, ["src/foo.ts"], [violation], "BLOCKING");
    updateFileViolationHistory(signals, ["src/foo.ts"], [violation], "BLOCKING");

    const rows = db.getSignals().getFileViolationHistory(["src/foo.ts"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].violation_count).toBe(2);
    db.close();
  });
});

// ---- updateFileViolationHistory — path_effects ----

describe("updateFileViolationHistory — path_effects", () => {
  it("creates path_effects rows for all reviewed files", async () => {
    const { signals, db } = await openSignalsFromDir(tmpDir);

    updateFileViolationHistory(signals, ["src/foo.ts", "src/bar.ts"], [], "CLEAN");

    const rows = db.getSignals().getPathEffects(["src/foo.ts", "src/bar.ts"]);
    expect(rows).toHaveLength(2);
    const paths = rows.map((r) => r.file_path);
    expect(paths).toContain("src/foo.ts");
    expect(paths).toContain("src/bar.ts");
    db.close();
  });

  it("increments total_reviews on each call", async () => {
    const { signals, db } = await openSignalsFromDir(tmpDir);

    updateFileViolationHistory(signals, ["src/foo.ts"], [], "CLEAN");
    updateFileViolationHistory(signals, ["src/foo.ts"], [], "CLEAN");

    const rows = db.getSignals().getPathEffects(["src/foo.ts"]);
    expect(rows[0].total_reviews).toBe(2);
    db.close();
  });

  it("sets clean_streak to 0 when file has violations", async () => {
    const { signals, db } = await openSignalsFromDir(tmpDir);

    // Establish a clean streak first
    updateFileViolationHistory(signals, ["src/foo.ts"], [], "CLEAN");
    updateFileViolationHistory(signals, ["src/foo.ts"], [], "CLEAN");

    // Then review with a violation
    updateFileViolationHistory(
      signals,
      ["src/foo.ts"],
      [{ file_path: "src/foo.ts", principle_id: "p1", severity: "rule" }],
      "BLOCKING",
    );

    const rows = db.getSignals().getPathEffects(["src/foo.ts"]);
    expect(rows[0].clean_streak).toBe(0);
    expect(rows[0].violation_streak).toBe(1);
    db.close();
  });

  it("increments clean_streak when file has no violations", async () => {
    const { signals, db } = await openSignalsFromDir(tmpDir);

    updateFileViolationHistory(signals, ["src/foo.ts"], [], "CLEAN");
    updateFileViolationHistory(signals, ["src/foo.ts"], [], "CLEAN");
    updateFileViolationHistory(signals, ["src/foo.ts"], [], "CLEAN");

    const rows = db.getSignals().getPathEffects(["src/foo.ts"]);
    expect(rows[0].clean_streak).toBe(3);
    expect(rows[0].violation_streak).toBe(0);
    db.close();
  });
});

// ---- updateFileViolationHistory — non-blocking guarantee ----

describe("updateFileViolationHistory — non-blocking error guarantee", () => {
  it("does not throw when the signals instance throws internally", () => {
    // Pass a mock SignalWriter that always throws
    const throwingSignals: SignalWriter = {
      getFileViolationHistory: () => {
        throw new Error("Simulated DB failure");
      },
      getPathEffects: () => {
        throw new Error("Simulated DB failure");
      },
      upsertFileViolation: () => {
        throw new Error("Simulated DB failure");
      },
      upsertPathEffect: () => {
        throw new Error("Simulated DB failure");
      },
    };

    // updateFileViolationHistory must swallow the error — must not throw
    expect(() => {
      updateFileViolationHistory(
        throwingSignals,
        ["src/foo.ts"],
        [{ file_path: "src/foo.ts", principle_id: "p1", severity: "rule" }],
        "BLOCKING",
      );
    }).not.toThrow();
  });
});

// ---- writeReview — backward compatibility ----

describe("writeReview — backward compatibility (no signals)", () => {
  it("writeReview without signals succeeds and does not create drift.db", async () => {
    const result = await writeReview(makeReviewInput());
    assertOk(result);
    expect(result.verdict).toBe("CLEAN");
    expect(result.violation_count).toBe(0);

    // .canon/drift.db must NOT have been created (no signals → no DB call)
    const dbPath = join(tmpDir, ".canon", "drift.db");
    expect(existsSync(dbPath)).toBe(false);
  });
});

// ---- updateFileViolationHistory — violation count propagation ----

describe("updateFileViolationHistory — violation count propagation", () => {
  it("increments total_violations by 3 when a file has 3 violations in one review", async () => {
    const { signals, db } = await openSignalsFromDir(tmpDir);

    // 3 violations for the same file in one review call
    updateFileViolationHistory(
      signals,
      ["src/foo.ts"],
      [
        { file_path: "src/foo.ts", principle_id: "p1", severity: "rule" },
        { file_path: "src/foo.ts", principle_id: "p2", severity: "strong-opinion" },
        { file_path: "src/foo.ts", principle_id: "p3", severity: "convention" },
      ],
      "BLOCKING",
    );

    const rows = db.getSignals().getPathEffects(["src/foo.ts"]);
    expect(rows).toHaveLength(1);
    // total_violations must be 3 (one per violation), not 1 (boolean had/hadn't)
    expect(rows[0].total_violations).toBe(3);
    db.close();
  });

  it("accumulates total_violations correctly across multiple reviews", async () => {
    const { signals, db } = await openSignalsFromDir(tmpDir);

    // First review: 2 violations
    updateFileViolationHistory(
      signals,
      ["src/foo.ts"],
      [
        { file_path: "src/foo.ts", principle_id: "p1", severity: "rule" },
        { file_path: "src/foo.ts", principle_id: "p2", severity: "strong-opinion" },
      ],
      "BLOCKING",
    );

    // Second review: 1 violation
    updateFileViolationHistory(
      signals,
      ["src/foo.ts"],
      [{ file_path: "src/foo.ts", principle_id: "p3", severity: "convention" }],
      "WARNING",
    );

    const rows = db.getSignals().getPathEffects(["src/foo.ts"]);
    expect(rows[0].total_violations).toBe(3);
    db.close();
  });
});

// ---- writeReview — with signals calls updateFileViolationHistory ----

describe("writeReview — with signals", () => {
  it("writeReview with signals creates signal data in drift.db", async () => {
    // Use a separate projectDir to avoid collision with the workspace tmpDir
    const projectTmpDir = await mkdtemp(join(tmpdir(), "write-review-project-"));

    try {
      const { signals, db } = await openSignalsFromDir(projectTmpDir);

      const result = await writeReview(
        makeReviewInput({
          files: ["src/foo.ts"],
          verdict: "changes_required",
          violations: [
            {
              file_path: "src/foo.ts",
              principle_id: "simplicity-first",
              severity: "strong-opinion",
            },
          ],
        }),
        signals,
      );

      assertOk(result);
      expect(result.verdict).toBe("WARNING");

      // Verify signal data was persisted
      const pathEffects = db.getSignals().getPathEffects(["src/foo.ts"]);
      expect(pathEffects).toHaveLength(1);
      expect(pathEffects[0].total_reviews).toBe(1);
      expect(pathEffects[0].total_violations).toBe(1);
      db.close();
    } finally {
      await rm(projectTmpDir, { force: true, recursive: true });
    }
  });
});
