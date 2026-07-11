/**
 * Tests for reconcilePredictions() in prediction-tracker.ts
 *
 * Uses in-memory SQLite via initDriftDb() for full DAO round-trips.
 * Also tests fail-open behavior for DB errors and corrupt JSON.
 *
 * Integration tests verify writeReview() calls reconcilePredictions()
 * when a reconciler is provided, and remains backward-compatible without one.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutionStore } from "@domains/workspaces/execution-store-cache.ts";
import { DriftDbSignals } from "@platform/storage/drift/drift-db-signals.ts";
import { initDriftDb } from "@platform/storage/drift/drift-schema.ts";
import { assertOk } from "@shared/lib/tool-result.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WriteReviewInput } from "../../orchestration/tools/write-review.ts";
import { writeReview } from "../../orchestration/tools/write-review.ts";
import {
  type PredictionReconciler,
  type ReconcilePredictionsInput,
  reconcilePredictions,
} from "../services/prediction-tracker.ts";

// ---- Helpers ----

function makeDb(): { db: ReturnType<typeof initDriftDb>; signals: DriftDbSignals } {
  const db = initDriftDb(":memory:");
  const signals = new DriftDbSignals(db);
  return { db, signals };
}

/** Insert a prediction row and return its prediction_id */
function seedPrediction(
  signals: DriftDbSignals,
  opts: {
    predictionId?: string;
    filePaths: string[];
    principleIds: string[];
    resolved?: boolean;
  },
): string {
  const predictionId = opts.predictionId ?? `pred-${Math.random().toString(36).slice(2)}`;
  signals.insertPrediction({
    file_paths: JSON.stringify(opts.filePaths),
    flow_id: null,
    prediction_id: predictionId,
    principle_ids: JSON.stringify(opts.principleIds),
    signals_json: JSON.stringify({}),
    timestamp: new Date().toISOString(),
    workspace: null,
  });
  if (opts.resolved) {
    signals.resolvePrediction({
      outcome: JSON.stringify({ pairs: [] }),
      prediction_id: predictionId,
      resolved_at: new Date().toISOString(),
    });
  }
  return predictionId;
}

function makeBaseWriteReviewInput(tmpDir: string): WriteReviewInput {
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
  };
}

// ---- Unit Tests: reconcilePredictions ----

describe("reconcilePredictions — happy path", () => {
  let db: ReturnType<typeof initDriftDb>;
  let signals: DriftDbSignals;

  beforeEach(() => {
    ({ db, signals } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  it("resolves a prediction whose files overlap with reviewed files — marks correct pair as actual: true", () => {
    const predictionId = seedPrediction(signals, {
      filePaths: ["src/foo.ts"],
      principleIds: ["simplicity-first"],
    });

    const input: ReconcilePredictionsInput = {
      reviewedFiles: ["src/foo.ts"],
      violations: [{ file_path: "src/foo.ts", principle_id: "simplicity-first" }],
    };

    reconcilePredictions(input, signals);

    const row = signals.getPredictionById(predictionId);
    expect(row).toBeDefined();
    expect(row!.resolved).toBe(1);
    expect(row!.resolved_at).not.toBeNull();

    const outcome = JSON.parse(row!.outcome!) as {
      pairs: Array<{
        file_path: string;
        principle_id: string;
        predicted: boolean;
        actual: boolean;
      }>;
    };
    expect(outcome.pairs).toHaveLength(1);
    expect(outcome.pairs[0]!.file_path).toBe("src/foo.ts");
    expect(outcome.pairs[0]!.principle_id).toBe("simplicity-first");
    expect(outcome.pairs[0]!.predicted).toBe(true);
    expect(outcome.pairs[0]!.actual).toBe(true);
  });

  it("marks pair as actual: false when prediction exists but violation did not occur", () => {
    const predictionId = seedPrediction(signals, {
      filePaths: ["src/foo.ts"],
      principleIds: ["simplicity-first"],
    });

    const input: ReconcilePredictionsInput = {
      reviewedFiles: ["src/foo.ts"],
      violations: [], // no matching violation
    };

    reconcilePredictions(input, signals);

    const row = signals.getPredictionById(predictionId);
    expect(row!.resolved).toBe(1);

    const outcome = JSON.parse(row!.outcome!) as { pairs: Array<{ actual: boolean }> };
    expect(outcome.pairs[0]!.actual).toBe(false);
  });

  it("handles batch reconciliation — resolves multiple predictions in one call", () => {
    const id1 = seedPrediction(signals, {
      filePaths: ["src/a.ts"],
      principleIds: ["simplicity-first"],
    });
    const id2 = seedPrediction(signals, {
      filePaths: ["src/b.ts"],
      principleIds: ["deep-modules"],
    });

    reconcilePredictions(
      {
        reviewedFiles: ["src/a.ts", "src/b.ts"],
        violations: [{ file_path: "src/a.ts", principle_id: "simplicity-first" }],
      },
      signals,
    );

    const row1 = signals.getPredictionById(id1);
    const row2 = signals.getPredictionById(id2);

    expect(row1!.resolved).toBe(1);
    expect(row2!.resolved).toBe(1);

    const outcome1 = JSON.parse(row1!.outcome!) as { pairs: Array<{ actual: boolean }> };
    const outcome2 = JSON.parse(row2!.outcome!) as { pairs: Array<{ actual: boolean }> };

    expect(outcome1.pairs[0]!.actual).toBe(true);
    expect(outcome2.pairs[0]!.actual).toBe(false);
  });

  it("skips predictions with no file overlap — does not resolve them", () => {
    const predictionId = seedPrediction(signals, {
      filePaths: ["src/other.ts"],
      principleIds: ["simplicity-first"],
    });

    reconcilePredictions(
      {
        reviewedFiles: ["src/foo.ts"],
        violations: [],
      },
      signals,
    );

    const row = signals.getPredictionById(predictionId);
    expect(row!.resolved).toBe(0); // still unresolved
  });

  it("handles mixed outcomes — some pairs correct, some incorrect", () => {
    const predictionId = seedPrediction(signals, {
      filePaths: ["src/foo.ts"],
      principleIds: ["simplicity-first", "deep-modules"],
    });

    reconcilePredictions(
      {
        reviewedFiles: ["src/foo.ts"],
        violations: [{ file_path: "src/foo.ts", principle_id: "simplicity-first" }],
        // deep-modules NOT violated
      },
      signals,
    );

    const row = signals.getPredictionById(predictionId);
    expect(row!.resolved).toBe(1);

    const outcome = JSON.parse(row!.outcome!) as {
      pairs: Array<{ principle_id: string; actual: boolean }>;
    };
    expect(outcome.pairs).toHaveLength(2);

    const simplicityPair = outcome.pairs.find((p) => p.principle_id === "simplicity-first");
    const deepPair = outcome.pairs.find((p) => p.principle_id === "deep-modules");

    expect(simplicityPair!.actual).toBe(true);
    expect(deepPair!.actual).toBe(false);
  });

  it("is a no-op when no unresolved predictions exist", () => {
    // Seed one already-resolved prediction
    seedPrediction(signals, {
      filePaths: ["src/foo.ts"],
      principleIds: ["simplicity-first"],
      resolved: true,
    });

    // Should not throw, should not change anything
    expect(() => {
      reconcilePredictions(
        {
          reviewedFiles: ["src/foo.ts"],
          violations: [{ file_path: "src/foo.ts", principle_id: "simplicity-first" }],
        },
        signals,
      );
    }).not.toThrow();

    // The resolved row is still resolved with original outcome (empty pairs)
    const unresolvedAfter = signals.getUnresolvedPredictions();
    expect(unresolvedAfter).toHaveLength(0);
  });
});

describe("reconcilePredictions — fail-open behavior", () => {
  it("catches and silently ignores DB errors — does not throw", () => {
    const db = initDriftDb(":memory:");
    const signals = new DriftDbSignals(db);
    db.close(); // Force all DB operations to throw

    expect(() => {
      reconcilePredictions(
        {
          reviewedFiles: ["src/foo.ts"],
          violations: [],
        },
        signals,
      );
    }).not.toThrow();
  });

  it("skips predictions with corrupt JSON in file_paths — does not throw", () => {
    // Use a custom reconciler that returns a prediction with invalid JSON
    const corruptReconciler: PredictionReconciler = {
      getUnresolvedPredictions: () => [
        {
          file_paths: "NOT VALID JSON",
          flow_id: null,
          id: 1,
          outcome: null,
          prediction_id: "pred-corrupt",
          principle_ids: JSON.stringify(["simplicity-first"]),
          resolved: 0,
          resolved_at: null,
          signals_json: JSON.stringify({}),
          timestamp: new Date().toISOString(),
          workspace: null,
        },
      ],
      resolvePrediction: vi.fn(),
    };

    expect(() => {
      reconcilePredictions(
        {
          reviewedFiles: ["src/foo.ts"],
          violations: [],
        },
        corruptReconciler,
      );
    }).not.toThrow();

    // resolvePrediction should NOT have been called for the corrupt prediction
    expect(corruptReconciler.resolvePrediction).not.toHaveBeenCalled();
  });

  it("skips predictions with corrupt JSON in principle_ids — does not throw", () => {
    const corruptReconciler: PredictionReconciler = {
      getUnresolvedPredictions: () => [
        {
          file_paths: JSON.stringify(["src/foo.ts"]),
          flow_id: null,
          id: 1,
          outcome: null,
          prediction_id: "pred-corrupt2",
          principle_ids: "ALSO NOT VALID JSON",
          resolved: 0,
          resolved_at: null,
          signals_json: JSON.stringify({}),
          timestamp: new Date().toISOString(),
          workspace: null,
        },
      ],
      resolvePrediction: vi.fn(),
    };

    expect(() => {
      reconcilePredictions(
        {
          reviewedFiles: ["src/foo.ts"],
          violations: [],
        },
        corruptReconciler,
      );
    }).not.toThrow();

    expect(corruptReconciler.resolvePrediction).not.toHaveBeenCalled();
  });

  it("catches and silently ignores errors thrown by resolvePrediction", () => {
    const { db, signals } = makeDb();
    const _predictionId = seedPrediction(signals, {
      filePaths: ["src/foo.ts"],
      principleIds: ["simplicity-first"],
    });

    // Mock resolvePrediction to throw
    vi.spyOn(signals, "resolvePrediction").mockImplementation(() => {
      throw new Error("DB write error");
    });

    expect(() => {
      reconcilePredictions(
        {
          reviewedFiles: ["src/foo.ts"],
          violations: [{ file_path: "src/foo.ts", principle_id: "simplicity-first" }],
        },
        signals,
      );
    }).not.toThrow();

    db.close();
  });
});

// ---- Integration Tests: writeReview with reconciler ----

describe("writeReview + reconcilePredictions integration", () => {
  let tmpDir: string;
  let db: ReturnType<typeof initDriftDb>;
  let signals: DriftDbSignals;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "write-review-reconcile-test-"));
    const now = new Date().toISOString();
    getExecutionStore(tmpDir).initExecution({
      base_commit: "abc123",
      branch: "feat/test",
      created: now,
      current_state: "build",
      entry: "build",
      flow: "test-flow",
      flow_name: "test-flow",
      last_updated: now,
      sanitized: "feat-test",
      slug: "test-slug",
      started: now,
      task: "test task",
      tier: "medium",
    });
    ({ db, signals } = makeDb());
  });

  afterEach(async () => {
    db.close();
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("reconcilePredictions resolves predictions when called after writeReview", async () => {
    const predictionId = seedPrediction(signals, {
      filePaths: ["src/foo.ts"],
      principleIds: ["simplicity-first"],
    });

    const input: WriteReviewInput = {
      ...makeBaseWriteReviewInput(tmpDir),
      violations: [{ file_path: "src/foo.ts", principle_id: "simplicity-first", severity: "rule" }],
    };

    // App layer pattern: writeReview then reconcilePredictions
    const result = await writeReview(input, signals);
    assertOk(result);
    reconcilePredictions({ reviewedFiles: input.files, violations: input.violations }, signals);

    // Prediction should have been reconciled
    const row = signals.getPredictionById(predictionId);
    expect(row!.resolved).toBe(1);

    const outcome = JSON.parse(row!.outcome!) as { pairs: Array<{ actual: boolean }> };
    expect(outcome.pairs[0]!.actual).toBe(true);
  });

  it("writeReview succeeds when no predictions exist (reconciler called separately)", async () => {
    // No predictions seeded
    const input = makeBaseWriteReviewInput(tmpDir);
    const result = await writeReview(input, signals);
    assertOk(result);
    // App layer reconciliation — no-op when no unresolved predictions
    reconcilePredictions({ reviewedFiles: input.files, violations: [] }, signals);
    expect(result.verdict).toBe("CLEAN");
  });

  it("remains backward-compatible: writeReview without signals still works", async () => {
    // No signals argument — original behavior
    const result = await writeReview(makeBaseWriteReviewInput(tmpDir));
    assertOk(result);
    expect(result.verdict).toBe("CLEAN");
  });

  it("review write succeeds even if reconciliation would throw", async () => {
    // App layer calls reconcilePredictions after writeReview; fail-open in reconcilePredictions
    const errorReconciler: PredictionReconciler = {
      getUnresolvedPredictions: () => {
        throw new Error("Simulated DB failure");
      },
      resolvePrediction: vi.fn(),
    };

    const result = await writeReview(makeBaseWriteReviewInput(tmpDir), signals);
    // Review should succeed
    assertOk(result);
    expect(result.verdict).toBe("CLEAN");

    // reconcilePredictions is fail-open — should not throw even with error reconciler
    expect(() => {
      reconcilePredictions({ reviewedFiles: ["src/foo.ts"], violations: [] }, errorReconciler);
    }).not.toThrow();
  });
});
