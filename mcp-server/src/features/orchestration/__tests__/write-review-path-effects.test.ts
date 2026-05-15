/**
 * write-review-path-effects.test.ts
 *
 * Tests for updateFileViolationHistory helper and the optional projectDir
 * parameter on writeReview.
 *
 * Signal persistence tests use real temp directories with actual drift.db.
 * The non-blocking error test uses vi.spyOn to simulate getDriftDb failure.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as driftDbModule from "@platform/storage/drift/drift-db.ts";
import { DriftDb } from "@platform/storage/drift/drift-db.ts";
import { initDriftDb } from "@platform/storage/drift/drift-schema.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
  vi.restoreAllMocks();
  await rm(tmpDir, { force: true, recursive: true });
});

/**
 * Open a DriftDb from a real temp directory.
 * Ensures the .canon directory exists before opening the DB.
 * Note: getDriftDb caches by resolved path; we bypass the cache here
 * to read state written by updateFileViolationHistory.
 */
async function openDriftDbFromDir(dir: string): Promise<DriftDb> {
  const canonDir = join(dir, ".canon");
  await mkdir(canonDir, { recursive: true });
  const dbPath = join(canonDir, "drift.db");
  const db = initDriftDb(dbPath);
  return new DriftDb(db);
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
    updateFileViolationHistory(
      tmpDir,
      ["src/foo.ts"],
      [{ file_path: "src/foo.ts", principle_id: "simplicity-first", severity: "strong-opinion" }],
      "WARNING",
    );

    const driftDb = await openDriftDbFromDir(tmpDir);
    const rows = driftDb.getSignals().getFileViolationHistory(["src/foo.ts"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].principle_id).toBe("simplicity-first");
    expect(rows[0].violation_count).toBe(1);
    driftDb.close();
  });

  it("skips violations without file_path — no rows written", async () => {
    updateFileViolationHistory(
      tmpDir,
      ["src/foo.ts"],
      [{ principle_id: "simplicity-first", severity: "strong-opinion" }], // no file_path
      "WARNING",
    );

    const driftDb = await openDriftDbFromDir(tmpDir);
    const rows = driftDb.getSignals().getFileViolationHistory(["src/foo.ts"]);
    expect(rows).toHaveLength(0);
    driftDb.close();
  });

  it("increments violation_count on repeated calls for same (file, principle)", async () => {
    const violation = {
      file_path: "src/foo.ts",
      principle_id: "errors-are-values",
      severity: "rule",
    };

    updateFileViolationHistory(tmpDir, ["src/foo.ts"], [violation], "BLOCKING");
    updateFileViolationHistory(tmpDir, ["src/foo.ts"], [violation], "BLOCKING");

    const driftDb = await openDriftDbFromDir(tmpDir);
    const rows = driftDb.getSignals().getFileViolationHistory(["src/foo.ts"]);
    expect(rows).toHaveLength(1);
    expect(rows[0].violation_count).toBe(2);
    driftDb.close();
  });
});

// ---- updateFileViolationHistory — path_effects ----

describe("updateFileViolationHistory — path_effects", () => {
  it("creates path_effects rows for all reviewed files", async () => {
    updateFileViolationHistory(tmpDir, ["src/foo.ts", "src/bar.ts"], [], "CLEAN");

    const driftDb = await openDriftDbFromDir(tmpDir);
    const rows = driftDb.getSignals().getPathEffects(["src/foo.ts", "src/bar.ts"]);
    expect(rows).toHaveLength(2);
    const paths = rows.map((r) => r.file_path);
    expect(paths).toContain("src/foo.ts");
    expect(paths).toContain("src/bar.ts");
    driftDb.close();
  });

  it("increments total_reviews on each call", async () => {
    updateFileViolationHistory(tmpDir, ["src/foo.ts"], [], "CLEAN");
    updateFileViolationHistory(tmpDir, ["src/foo.ts"], [], "CLEAN");

    const driftDb = await openDriftDbFromDir(tmpDir);
    const rows = driftDb.getSignals().getPathEffects(["src/foo.ts"]);
    expect(rows[0].total_reviews).toBe(2);
    driftDb.close();
  });

  it("sets clean_streak to 0 when file has violations", async () => {
    // Establish a clean streak first
    updateFileViolationHistory(tmpDir, ["src/foo.ts"], [], "CLEAN");
    updateFileViolationHistory(tmpDir, ["src/foo.ts"], [], "CLEAN");

    // Then review with a violation
    updateFileViolationHistory(
      tmpDir,
      ["src/foo.ts"],
      [{ file_path: "src/foo.ts", principle_id: "p1", severity: "rule" }],
      "BLOCKING",
    );

    const driftDb = await openDriftDbFromDir(tmpDir);
    const rows = driftDb.getSignals().getPathEffects(["src/foo.ts"]);
    expect(rows[0].clean_streak).toBe(0);
    expect(rows[0].violation_streak).toBe(1);
    driftDb.close();
  });

  it("increments clean_streak when file has no violations", async () => {
    updateFileViolationHistory(tmpDir, ["src/foo.ts"], [], "CLEAN");
    updateFileViolationHistory(tmpDir, ["src/foo.ts"], [], "CLEAN");
    updateFileViolationHistory(tmpDir, ["src/foo.ts"], [], "CLEAN");

    const driftDb = await openDriftDbFromDir(tmpDir);
    const rows = driftDb.getSignals().getPathEffects(["src/foo.ts"]);
    expect(rows[0].clean_streak).toBe(3);
    expect(rows[0].violation_streak).toBe(0);
    driftDb.close();
  });
});

// ---- updateFileViolationHistory — non-blocking guarantee ----

describe("updateFileViolationHistory — non-blocking error guarantee", () => {
  it("does not throw when getDriftDb throws internally", () => {
    // Spy on getDriftDb and make it throw
    vi.spyOn(driftDbModule, "getDriftDb").mockImplementation(() => {
      throw new Error("Simulated DB failure");
    });

    // updateFileViolationHistory must swallow the error — must not throw
    expect(() => {
      updateFileViolationHistory(
        tmpDir,
        ["src/foo.ts"],
        [{ file_path: "src/foo.ts", principle_id: "p1", severity: "rule" }],
        "BLOCKING",
      );
    }).not.toThrow();
  });
});

// ---- writeReview — backward compatibility ----

describe("writeReview — backward compatibility (no projectDir)", () => {
  it("writeReview without projectDir succeeds and does not create drift.db", async () => {
    const result = await writeReview(makeReviewInput());
    assertOk(result);
    expect(result.verdict).toBe("CLEAN");
    expect(result.violation_count).toBe(0);

    // .canon/drift.db must NOT have been created (no getDriftDb call without projectDir)
    const dbPath = join(tmpDir, ".canon", "drift.db");
    expect(existsSync(dbPath)).toBe(false);
  });
});

// ---- writeReview — with projectDir calls updateFileViolationHistory ----

describe("writeReview — with projectDir", () => {
  it("writeReview with projectDir creates drift.db with signal data", async () => {
    // Use a separate projectDir to avoid collision with the workspace tmpDir
    const projectTmpDir = await mkdtemp(join(tmpdir(), "write-review-project-"));

    try {
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
        projectTmpDir,
      );

      assertOk(result);
      expect(result.verdict).toBe("WARNING");

      // getDriftDb creates .canon/drift.db in the projectDir
      const dbPath = join(projectTmpDir, ".canon", "drift.db");
      expect(existsSync(dbPath)).toBe(true);

      // Open a second connection to verify signal data was persisted
      const driftDb = await openDriftDbFromDir(projectTmpDir);
      const pathEffects = driftDb.getSignals().getPathEffects(["src/foo.ts"]);
      expect(pathEffects).toHaveLength(1);
      expect(pathEffects[0].total_reviews).toBe(1);
      expect(pathEffects[0].total_violations).toBe(1);
      driftDb.close();
    } finally {
      await rm(projectTmpDir, { force: true, recursive: true });
    }
  });
});
