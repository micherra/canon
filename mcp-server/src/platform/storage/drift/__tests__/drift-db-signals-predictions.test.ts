/**
 * DriftDbSignals prediction DAO tests
 *
 * Tests the v5 migration (predictions table) and all prediction CRUD methods.
 * Uses in-memory SQLite (:memory:) for speed and isolation.
 *
 * Test plan:
 * - v5 migration creates predictions table with correct columns
 * - insertPrediction() persists a record, getPredictionById() reads it back
 * - getUnresolvedPredictions() returns only unresolved predictions
 * - resolvePrediction() sets resolved=1, resolved_at, and outcome
 * - Double-apply v5 migration is idempotent (no errors)
 * - DRIFT_SCHEMA_VERSION equals "13"
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { InsertPredictionInput, ResolvePredictionInput } from "../drift-db-signals.ts";
import { DriftDbSignals } from "../drift-db-signals.ts";
import { DRIFT_SCHEMA_VERSION, initDriftDb, runDriftMigrations } from "../drift-schema.ts";

// Helper: create a fresh in-memory database with full schema applied
function makeDb(): { db: ReturnType<typeof initDriftDb>; signals: DriftDbSignals } {
  const db = initDriftDb(":memory:");
  const signals = new DriftDbSignals(db);
  return { db, signals };
}

// Helper: build a minimal InsertPredictionInput
function makePredictionInput(
  overrides: Partial<InsertPredictionInput> = {},
): InsertPredictionInput {
  return {
    file_paths: JSON.stringify(["src/foo.ts", "src/bar.ts"]),
    flow_id: "flow-abc",
    prediction_id: `pred_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    principle_ids: JSON.stringify(["deep-modules", "thin-handlers"]),
    signals_json: JSON.stringify({ score: 0.8, signals: [] }),
    timestamp: new Date().toISOString(),
    workspace: "test-workspace",
    ...overrides,
  };
}

// DRIFT_SCHEMA_VERSION

describe("DRIFT_SCHEMA_VERSION", () => {
  test("is '11'", () => {
    expect(DRIFT_SCHEMA_VERSION).toBe("13");
  });
});

// v5 migration — predictions table DDL

describe("v5 migration — predictions table", () => {
  test("creates predictions table on fresh DB", () => {
    const db = initDriftDb(":memory:");
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain("predictions");
    db.close();
  });

  test("predictions table has all expected columns", () => {
    const db = initDriftDb(":memory:");
    const cols = db.prepare(`PRAGMA table_info(predictions)`).all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("prediction_id");
    expect(colNames).toContain("workspace");
    expect(colNames).toContain("flow_id");
    expect(colNames).toContain("file_paths");
    expect(colNames).toContain("principle_ids");
    expect(colNames).toContain("signals_json");
    expect(colNames).toContain("timestamp");
    expect(colNames).toContain("resolved");
    expect(colNames).toContain("resolved_at");
    expect(colNames).toContain("outcome");
    db.close();
  });

  test("predictions table has indexes on resolved, timestamp, and prediction_id", () => {
    const db = initDriftDb(":memory:");
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='predictions' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_predictions_resolved");
    expect(indexNames).toContain("idx_predictions_ts");
    expect(indexNames).toContain("idx_predictions_pid");
    db.close();
  });

  test("schema_version is '10' after fresh DB init", () => {
    const db = initDriftDb(":memory:");
    const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as {
      value: string;
    };
    expect(row.value).toBe("13");
    db.close();
  });

  test("v5 migration is idempotent — running twice does not error", () => {
    const db = initDriftDb(":memory:");
    // Already at v5; running runDriftMigrations again is a no-op
    expect(() => runDriftMigrations(db)).not.toThrow();
    db.close();
  });

  test("v5 migration: CREATE TABLE IF NOT EXISTS is safe when table already exists", () => {
    const db = initDriftDb(":memory:");
    // Manually create the table again — should be a no-op
    expect(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS predictions (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        prediction_id   TEXT NOT NULL UNIQUE,
        workspace       TEXT,
        flow_id         TEXT,
        file_paths      TEXT NOT NULL,
        principle_ids   TEXT NOT NULL,
        signals_json    TEXT NOT NULL,
        timestamp       TEXT NOT NULL,
        resolved        INTEGER NOT NULL DEFAULT 0,
        resolved_at     TEXT,
        outcome         TEXT
      )`);
    }).not.toThrow();
    db.close();
  });
});

// insertPrediction + getPredictionById round-trip

describe("insertPrediction and getPredictionById", () => {
  let db: ReturnType<typeof initDriftDb>;
  let signals: DriftDbSignals;

  beforeEach(() => {
    ({ db, signals } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  test("round-trips a minimal prediction record", () => {
    const input = makePredictionInput({ prediction_id: "pred_001" });
    signals.insertPrediction(input);

    const row = signals.getPredictionById("pred_001");
    expect(row).toBeDefined();
    expect(row!.prediction_id).toBe("pred_001");
    expect(row!.workspace).toBe("test-workspace");
    expect(row!.flow_id).toBe("flow-abc");
    expect(row!.file_paths).toBe(input.file_paths);
    expect(row!.principle_ids).toBe(input.principle_ids);
    expect(row!.signals_json).toBe(input.signals_json);
    expect(row!.timestamp).toBe(input.timestamp);
    expect(row!.resolved).toBe(0);
    expect(row!.resolved_at).toBeNull();
    expect(row!.outcome).toBeNull();
  });

  test("round-trips a prediction with null workspace and flow_id", () => {
    const input = makePredictionInput({
      flow_id: null,
      prediction_id: "pred_002",
      workspace: null,
    });
    signals.insertPrediction(input);

    const row = signals.getPredictionById("pred_002");
    expect(row).toBeDefined();
    expect(row!.workspace).toBeNull();
    expect(row!.flow_id).toBeNull();
  });

  test("getPredictionById returns undefined when no matching record exists", () => {
    const row = signals.getPredictionById("pred_does_not_exist");
    expect(row).toBeUndefined();
  });

  test("row includes id field (INTEGER PRIMARY KEY)", () => {
    const input = makePredictionInput({ prediction_id: "pred_003" });
    signals.insertPrediction(input);

    const row = signals.getPredictionById("pred_003");
    expect(row).toBeDefined();
    expect(typeof row!.id).toBe("number");
    expect(row!.id).toBeGreaterThan(0);
  });
});

// getUnresolvedPredictions

describe("getUnresolvedPredictions", () => {
  let db: ReturnType<typeof initDriftDb>;
  let signals: DriftDbSignals;

  beforeEach(() => {
    ({ db, signals } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  test("returns empty array when no predictions exist", () => {
    const results = signals.getUnresolvedPredictions();
    expect(results).toEqual([]);
  });

  test("returns all unresolved predictions", () => {
    signals.insertPrediction(
      makePredictionInput({
        prediction_id: "pred_a",
        timestamp: "2026-01-01T10:00:00Z",
      }),
    );
    signals.insertPrediction(
      makePredictionInput({
        prediction_id: "pred_b",
        timestamp: "2026-01-02T10:00:00Z",
      }),
    );

    const results = signals.getUnresolvedPredictions();
    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.prediction_id);
    expect(ids).toContain("pred_a");
    expect(ids).toContain("pred_b");
  });

  test("excludes resolved predictions", () => {
    signals.insertPrediction(
      makePredictionInput({
        prediction_id: "pred_unresolved",
        timestamp: "2026-01-01T10:00:00Z",
      }),
    );
    signals.insertPrediction(
      makePredictionInput({
        prediction_id: "pred_resolved",
        timestamp: "2026-01-02T10:00:00Z",
      }),
    );

    // Resolve pred_resolved
    signals.resolvePrediction({
      outcome: JSON.stringify({ result: "pass" }),
      prediction_id: "pred_resolved",
      resolved_at: "2026-01-03T00:00:00Z",
    });

    const results = signals.getUnresolvedPredictions();
    expect(results).toHaveLength(1);
    expect(results[0].prediction_id).toBe("pred_unresolved");
  });

  test("returns results ordered by timestamp DESC", () => {
    signals.insertPrediction(
      makePredictionInput({
        prediction_id: "pred_early",
        timestamp: "2026-01-01T10:00:00Z",
      }),
    );
    signals.insertPrediction(
      makePredictionInput({
        prediction_id: "pred_late",
        timestamp: "2026-01-03T10:00:00Z",
      }),
    );
    signals.insertPrediction(
      makePredictionInput({
        prediction_id: "pred_mid",
        timestamp: "2026-01-02T10:00:00Z",
      }),
    );

    const results = signals.getUnresolvedPredictions();
    expect(results).toHaveLength(3);
    expect(results[0].prediction_id).toBe("pred_late");
    expect(results[1].prediction_id).toBe("pred_mid");
    expect(results[2].prediction_id).toBe("pred_early");
  });

  test("returns all rows as PredictionRow type with correct shape", () => {
    signals.insertPrediction(makePredictionInput({ prediction_id: "pred_shape_test" }));

    const results = signals.getUnresolvedPredictions();
    expect(results).toHaveLength(1);
    const row = results[0];
    expect(typeof row.id).toBe("number");
    expect(typeof row.prediction_id).toBe("string");
    expect(row.resolved).toBe(0);
    expect(row.resolved_at).toBeNull();
    expect(row.outcome).toBeNull();
  });
});

// resolvePrediction

describe("resolvePrediction", () => {
  let db: ReturnType<typeof initDriftDb>;
  let signals: DriftDbSignals;

  beforeEach(() => {
    ({ db, signals } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  test("sets resolved=1, resolved_at, and outcome on the target prediction", () => {
    signals.insertPrediction(makePredictionInput({ prediction_id: "pred_to_resolve" }));

    const resolveInput: ResolvePredictionInput = {
      outcome: JSON.stringify({ per_pair: [{ principle: "deep-modules", verdict: "pass" }] }),
      prediction_id: "pred_to_resolve",
      resolved_at: "2026-02-01T12:00:00Z",
    };
    signals.resolvePrediction(resolveInput);

    const row = signals.getPredictionById("pred_to_resolve");
    expect(row).toBeDefined();
    expect(row!.resolved).toBe(1);
    expect(row!.resolved_at).toBe("2026-02-01T12:00:00Z");
    expect(row!.outcome).toBe(resolveInput.outcome);
  });

  test("resolved prediction no longer appears in getUnresolvedPredictions", () => {
    signals.insertPrediction(makePredictionInput({ prediction_id: "pred_resolve_test" }));
    signals.resolvePrediction({
      outcome: JSON.stringify({}),
      prediction_id: "pred_resolve_test",
      resolved_at: "2026-02-01T00:00:00Z",
    });

    const unresolved = signals.getUnresolvedPredictions();
    expect(unresolved.map((r) => r.prediction_id)).not.toContain("pred_resolve_test");
  });

  test("resolvePrediction is a no-op for non-existent prediction_id", () => {
    // Should not throw
    expect(() => {
      signals.resolvePrediction({
        outcome: JSON.stringify({}),
        prediction_id: "no_such_prediction",
        resolved_at: "2026-02-01T00:00:00Z",
      });
    }).not.toThrow();
  });

  test("multiple predictions can be resolved independently", () => {
    signals.insertPrediction(makePredictionInput({ prediction_id: "pred_x" }));
    signals.insertPrediction(makePredictionInput({ prediction_id: "pred_y" }));
    signals.insertPrediction(makePredictionInput({ prediction_id: "pred_z" }));

    signals.resolvePrediction({
      outcome: JSON.stringify({ verdict: "x_pass" }),
      prediction_id: "pred_x",
      resolved_at: "2026-02-01T00:00:00Z",
    });

    const unresolved = signals.getUnresolvedPredictions();
    expect(unresolved).toHaveLength(2);
    expect(unresolved.map((r) => r.prediction_id)).not.toContain("pred_x");

    const rowX = signals.getPredictionById("pred_x");
    const rowY = signals.getPredictionById("pred_y");
    const rowZ = signals.getPredictionById("pred_z");
    expect(rowX!.resolved).toBe(1);
    expect(rowY!.resolved).toBe(0);
    expect(rowZ!.resolved).toBe(0);
  });
});

// getResolvedPredictions

describe("getResolvedPredictions", () => {
  let db: ReturnType<typeof initDriftDb>;
  let signals: DriftDbSignals;

  beforeEach(() => {
    ({ db, signals } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  /** Helper: insert and resolve a prediction with given principle_ids, file_paths, and resolved_at */
  function insertResolved(opts: {
    prediction_id: string;
    principle_ids: string[];
    file_paths?: string[];
    resolved_at: string;
    outcome?: string;
  }): void {
    signals.insertPrediction(
      makePredictionInput({
        file_paths: JSON.stringify(opts.file_paths ?? ["src/foo.ts"]),
        prediction_id: opts.prediction_id,
        principle_ids: JSON.stringify(opts.principle_ids),
      }),
    );
    signals.resolvePrediction({
      outcome: opts.outcome ?? JSON.stringify({ pairs: [] }),
      prediction_id: opts.prediction_id,
      resolved_at: opts.resolved_at,
    });
  }

  test("returns empty array when no resolved predictions exist", () => {
    const results = signals.getResolvedPredictions();
    expect(results).toEqual([]);
  });

  test("returns empty array for empty principleIds array", () => {
    insertResolved({
      prediction_id: "pred_r1",
      principle_ids: ["deep-modules"],
      resolved_at: "2026-03-01T00:00:00Z",
    });
    const results = signals.getResolvedPredictions([]);
    expect(results).toEqual([]);
  });

  test("returns all resolved predictions when no principleIds filter", () => {
    insertResolved({
      prediction_id: "pred_r1",
      principle_ids: ["deep-modules"],
      resolved_at: "2026-03-01T00:00:00Z",
    });
    insertResolved({
      prediction_id: "pred_r2",
      principle_ids: ["thin-handlers"],
      resolved_at: "2026-03-02T00:00:00Z",
    });
    const results = signals.getResolvedPredictions();
    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.prediction_id);
    expect(ids).toContain("pred_r1");
    expect(ids).toContain("pred_r2");
  });

  test("filters by principle ID correctly using json_each", () => {
    insertResolved({
      prediction_id: "pred_match",
      principle_ids: ["deep-modules", "thin-handlers"],
      resolved_at: "2026-03-01T00:00:00Z",
    });
    insertResolved({
      prediction_id: "pred_no_match",
      principle_ids: ["some-other-principle"],
      resolved_at: "2026-03-02T00:00:00Z",
    });

    const results = signals.getResolvedPredictions(["deep-modules"]);
    expect(results).toHaveLength(1);
    expect(results[0].prediction_id).toBe("pred_match");
  });

  test("deduplicates when a prediction matches multiple requested principle IDs", () => {
    insertResolved({
      prediction_id: "pred_multi",
      principle_ids: ["deep-modules", "thin-handlers"],
      resolved_at: "2026-03-01T00:00:00Z",
    });

    // Request both principles that match the same prediction
    const results = signals.getResolvedPredictions(["deep-modules", "thin-handlers"]);
    expect(results).toHaveLength(1);
    expect(results[0].prediction_id).toBe("pred_multi");
  });

  test("does not return unresolved predictions (resolved=0)", () => {
    // Insert a resolved one
    insertResolved({
      prediction_id: "pred_resolved",
      principle_ids: ["deep-modules"],
      resolved_at: "2026-03-01T00:00:00Z",
    });
    // Insert an unresolved one with same principle
    signals.insertPrediction(
      makePredictionInput({
        prediction_id: "pred_unresolved",
        principle_ids: JSON.stringify(["deep-modules"]),
      }),
    );

    const results = signals.getResolvedPredictions();
    expect(results).toHaveLength(1);
    expect(results[0].prediction_id).toBe("pred_resolved");
  });

  test("does not return resolved predictions without outcome (outcome IS NULL)", () => {
    // Manually insert a resolved prediction with NULL outcome via raw SQL
    db.prepare(
      `INSERT INTO predictions (prediction_id, file_paths, principle_ids, signals_json, timestamp, resolved, resolved_at, outcome)
       VALUES (?, ?, ?, ?, ?, 1, ?, NULL)`,
    ).run(
      "pred_null_outcome",
      JSON.stringify(["src/bar.ts"]),
      JSON.stringify(["deep-modules"]),
      JSON.stringify({ score: 0.5 }),
      new Date().toISOString(),
      "2026-03-01T00:00:00Z",
    );

    // Insert a valid resolved prediction
    insertResolved({
      prediction_id: "pred_with_outcome",
      principle_ids: ["deep-modules"],
      resolved_at: "2026-03-02T00:00:00Z",
    });

    const results = signals.getResolvedPredictions();
    expect(results).toHaveLength(1);
    expect(results[0].prediction_id).toBe("pred_with_outcome");
  });

  test("orders by resolved_at DESC", () => {
    insertResolved({
      prediction_id: "pred_early",
      principle_ids: ["deep-modules"],
      resolved_at: "2026-01-01T00:00:00Z",
    });
    insertResolved({
      prediction_id: "pred_late",
      principle_ids: ["deep-modules"],
      resolved_at: "2026-03-01T00:00:00Z",
    });
    insertResolved({
      prediction_id: "pred_mid",
      principle_ids: ["deep-modules"],
      resolved_at: "2026-02-01T00:00:00Z",
    });

    const results = signals.getResolvedPredictions();
    expect(results).toHaveLength(3);
    expect(results[0].prediction_id).toBe("pred_late");
    expect(results[1].prediction_id).toBe("pred_mid");
    expect(results[2].prediction_id).toBe("pred_early");
  });
});
