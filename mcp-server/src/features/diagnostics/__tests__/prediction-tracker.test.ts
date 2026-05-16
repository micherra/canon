/**
 * Tests for recordPrediction() in prediction-tracker.ts
 *
 * Uses in-memory SQLite via initDriftDb() for full DAO round-trips.
 * Also tests fail-open behavior with mocked DB errors.
 */

import { DriftDbSignals } from "@platform/storage/drift/drift-db-signals.ts";
import { initDriftDb } from "@platform/storage/drift/drift-schema.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordPredictionInput } from "../services/prediction-tracker.ts";
import { recordPrediction } from "../services/prediction-tracker.ts";
import type { FileSignals } from "../services/signal-compiler.ts";

// ---- Helpers ----

function makeDb(): { db: ReturnType<typeof initDriftDb>; driftDbSignals: DriftDbSignals } {
  const db = initDriftDb(":memory:");
  const driftDbSignals = new DriftDbSignals(db);
  return { db, driftDbSignals };
}

/** Build a FileSignals entry with a violation_history signal so principle IDs can be extracted. */
function makeFileSignalsWithViolation(
  filePath: string,
  principleId: string,
  count = 3,
): FileSignals {
  return {
    file_path: filePath,
    signals: [
      {
        priority: 8,
        text: `Principle "${principleId}" has been violated ${count} time(s) in this file. Last seen: 2026-05-01. First seen: 2026-04-01.`,
        type: "violation_history",
      },
    ],
  };
}

/** Build a FileSignals entry with only a path_effect signal (no principle ID extractable). */
function makeFileSignalsPathEffectOnly(filePath: string): FileSignals {
  return {
    file_path: filePath,
    signals: [
      {
        priority: 4,
        text: "Reviewed 3 time(s) with 2 violation(s). Current violation streak: 1.",
        type: "path_effect",
      },
    ],
  };
}

/** Build a FileSignals entry with no signals (empty). */
function makeEmptyFileSignals(filePath: string): FileSignals {
  return {
    file_path: filePath,
    signals: [],
  };
}

// ---- Tests ----

describe("recordPrediction — happy path", () => {
  let db: ReturnType<typeof initDriftDb>;
  let driftDbSignals: DriftDbSignals;

  beforeEach(() => {
    ({ db, driftDbSignals } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  it("returns a prediction_id and persists a row to the predictions table", () => {
    const input: RecordPredictionInput = {
      compiledSignals: [makeFileSignalsWithViolation("src/foo.ts", "simplicity-first")],
      filePaths: ["src/foo.ts"],
      flowId: "flow-abc",
      workspace: "test-workspace",
    };

    const predictionId = recordPrediction(input, driftDbSignals);

    expect(predictionId).toBeDefined();
    expect(typeof predictionId).toBe("string");
    expect(predictionId!.length).toBeGreaterThan(0);

    // Verify it was persisted to the DB
    const row = driftDbSignals.getPredictionById(predictionId!);
    expect(row).toBeDefined();
    expect(row!.prediction_id).toBe(predictionId);
    expect(row!.workspace).toBe("test-workspace");
    expect(row!.flow_id).toBe("flow-abc");
    expect(row!.resolved).toBe(0);
  });

  it("serializes file_paths as a JSON array", () => {
    const input: RecordPredictionInput = {
      compiledSignals: [
        makeFileSignalsWithViolation("src/foo.ts", "simplicity-first"),
        makeFileSignalsWithViolation("src/bar.ts", "deep-modules"),
      ],
      filePaths: ["src/foo.ts", "src/bar.ts"],
    };

    const predictionId = recordPrediction(input, driftDbSignals);
    expect(predictionId).toBeDefined();

    const row = driftDbSignals.getPredictionById(predictionId!);
    expect(row).toBeDefined();

    // file_paths must be a valid JSON array
    const parsed = JSON.parse(row!.file_paths) as string[];
    expect(parsed).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("serializes principle_ids as a JSON array of extracted unique principle IDs", () => {
    const input: RecordPredictionInput = {
      compiledSignals: [
        makeFileSignalsWithViolation("src/foo.ts", "simplicity-first"),
        makeFileSignalsWithViolation("src/bar.ts", "deep-modules"),
      ],
      filePaths: ["src/foo.ts", "src/bar.ts"],
    };

    const predictionId = recordPrediction(input, driftDbSignals);
    expect(predictionId).toBeDefined();

    const row = driftDbSignals.getPredictionById(predictionId!);
    const principleIds = JSON.parse(row!.principle_ids) as string[];
    expect(principleIds).toContain("simplicity-first");
    expect(principleIds).toContain("deep-modules");
    expect(principleIds).toHaveLength(2);
  });

  it("deduplicates principle IDs that appear in multiple signals", () => {
    // Same principle in two different files
    const input: RecordPredictionInput = {
      compiledSignals: [
        makeFileSignalsWithViolation("src/foo.ts", "simplicity-first"),
        makeFileSignalsWithViolation("src/bar.ts", "simplicity-first"),
      ],
      filePaths: ["src/foo.ts", "src/bar.ts"],
    };

    const predictionId = recordPrediction(input, driftDbSignals);
    expect(predictionId).toBeDefined();

    const row = driftDbSignals.getPredictionById(predictionId!);
    const principleIds = JSON.parse(row!.principle_ids) as string[];
    expect(principleIds).toEqual(["simplicity-first"]); // deduplicated
    expect(principleIds).toHaveLength(1);
  });

  it("sets workspace and flow_id to null when not provided", () => {
    const input: RecordPredictionInput = {
      compiledSignals: [makeFileSignalsWithViolation("src/foo.ts", "simplicity-first")],
      filePaths: ["src/foo.ts"],
      // no workspace, no flowId
    };

    const predictionId = recordPrediction(input, driftDbSignals);
    expect(predictionId).toBeDefined();

    const row = driftDbSignals.getPredictionById(predictionId!);
    expect(row!.workspace).toBeNull();
    expect(row!.flow_id).toBeNull();
  });

  it("sets resolved=0 on newly inserted predictions", () => {
    const input: RecordPredictionInput = {
      compiledSignals: [makeFileSignalsWithViolation("src/foo.ts", "simplicity-first")],
      filePaths: ["src/foo.ts"],
    };

    const predictionId = recordPrediction(input, driftDbSignals);
    const row = driftDbSignals.getPredictionById(predictionId!);
    expect(row!.resolved).toBe(0);
    expect(row!.resolved_at).toBeNull();
    expect(row!.outcome).toBeNull();
  });
});

describe("recordPrediction — no-op cases", () => {
  let db: ReturnType<typeof initDriftDb>;
  let driftDbSignals: DriftDbSignals;

  beforeEach(() => {
    ({ db, driftDbSignals } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  it("returns undefined when compiledSignals is empty (nothing to predict)", () => {
    const input: RecordPredictionInput = {
      compiledSignals: [],
      filePaths: ["src/no-data.ts"],
    };

    const predictionId = recordPrediction(input, driftDbSignals);
    expect(predictionId).toBeUndefined();
  });

  it("returns undefined when all signals arrays are empty", () => {
    const input: RecordPredictionInput = {
      compiledSignals: [makeEmptyFileSignals("src/foo.ts"), makeEmptyFileSignals("src/bar.ts")],
      filePaths: ["src/foo.ts", "src/bar.ts"],
    };

    const predictionId = recordPrediction(input, driftDbSignals);
    expect(predictionId).toBeUndefined();
  });

  it("returns undefined when no principle IDs can be extracted (only path_effect signals)", () => {
    // path_effect signals do not contain principle IDs — extractPrincipleIds returns []
    const input: RecordPredictionInput = {
      compiledSignals: [makeFileSignalsPathEffectOnly("src/foo.ts")],
      filePaths: ["src/foo.ts"],
    };

    const predictionId = recordPrediction(input, driftDbSignals);
    expect(predictionId).toBeUndefined();
  });
});

describe("recordPrediction — fail-open behavior", () => {
  it("returns undefined (does not throw) when insertPrediction throws", () => {
    // Create a DriftDbSignals whose insertPrediction is stubbed to throw
    const db = initDriftDb(":memory:");
    const driftDbSignals = new DriftDbSignals(db);
    db.close(); // Close the DB so all operations throw SQLITE_MISUSE or similar

    const input: RecordPredictionInput = {
      compiledSignals: [makeFileSignalsWithViolation("src/foo.ts", "simplicity-first")],
      filePaths: ["src/foo.ts"],
    };

    // Must not throw — fail-open
    let predictionId: string | undefined;
    expect(() => {
      predictionId = recordPrediction(input, driftDbSignals);
    }).not.toThrow();

    expect(predictionId).toBeUndefined();
  });

  it("returns undefined when driftDbSignals.insertPrediction is mocked to throw", () => {
    const db = initDriftDb(":memory:");
    const driftDbSignals = new DriftDbSignals(db);

    // Mock insertPrediction to throw
    vi.spyOn(driftDbSignals, "insertPrediction").mockImplementation(() => {
      throw new Error("DB write error");
    });

    const input: RecordPredictionInput = {
      compiledSignals: [makeFileSignalsWithViolation("src/foo.ts", "simplicity-first")],
      filePaths: ["src/foo.ts"],
    };

    let predictionId: string | undefined;
    expect(() => {
      predictionId = recordPrediction(input, driftDbSignals);
    }).not.toThrow();

    expect(predictionId).toBeUndefined();
    db.close();
  });
});

describe("extractPrincipleIds — principle ID parsing", () => {
  // Test the extraction by observing recordPrediction's persisted principle_ids column

  let db: ReturnType<typeof initDriftDb>;
  let driftDbSignals: DriftDbSignals;

  beforeEach(() => {
    ({ db, driftDbSignals } = makeDb());
  });

  afterEach(() => {
    db.close();
  });

  it("extracts principle ID from violation_history signal text", () => {
    const signals: FileSignals[] = [
      {
        file_path: "src/foo.ts",
        signals: [
          {
            priority: 5,
            text: 'Principle "no-llm-calls-in-mcp-tools" has been violated 2 time(s) in this file. Last seen: 2026-05-01. First seen: 2026-04-01.',
            type: "violation_history",
          },
        ],
      },
    ];

    const predictionId = recordPrediction(
      { compiledSignals: signals, filePaths: ["src/foo.ts"] },
      driftDbSignals,
    );
    expect(predictionId).toBeDefined();

    const row = driftDbSignals.getPredictionById(predictionId!);
    const principleIds = JSON.parse(row!.principle_ids) as string[];
    expect(principleIds).toEqual(["no-llm-calls-in-mcp-tools"]);
  });

  it("returns undefined when signal text does not match principle ID format", () => {
    const signals: FileSignals[] = [
      {
        file_path: "src/foo.ts",
        signals: [
          {
            priority: 5,
            // This text does not start with 'Principle "..."'
            text: "Some other signal text that does not contain a principle ID.",
            type: "violation_history",
          },
        ],
      },
    ];

    const predictionId = recordPrediction(
      { compiledSignals: signals, filePaths: ["src/foo.ts"] },
      driftDbSignals,
    );
    // No principle IDs extracted → returns undefined
    expect(predictionId).toBeUndefined();
  });

  it("collects principle IDs from multiple violation_history signals across multiple files", () => {
    const signals: FileSignals[] = [
      makeFileSignalsWithViolation("src/a.ts", "principle-a"),
      makeFileSignalsWithViolation("src/b.ts", "principle-b"),
      {
        file_path: "src/c.ts",
        signals: [
          {
            priority: 5,
            text: 'Principle "principle-a" has been violated 1 time(s) in this file. Last seen: 2026-05-01. First seen: 2026-04-01.',
            type: "violation_history",
          },
          {
            priority: 3,
            text: 'Principle "principle-c" has been violated 1 time(s) in this file. Last seen: 2026-05-01. First seen: 2026-04-01.',
            type: "violation_history",
          },
        ],
      },
    ];

    const predictionId = recordPrediction(
      { compiledSignals: signals, filePaths: ["src/a.ts", "src/b.ts", "src/c.ts"] },
      driftDbSignals,
    );
    expect(predictionId).toBeDefined();

    const row = driftDbSignals.getPredictionById(predictionId!);
    const principleIds = JSON.parse(row!.principle_ids) as string[];
    // Order from Set iteration — deterministic: a, b, c
    expect(principleIds).toContain("principle-a");
    expect(principleIds).toContain("principle-b");
    expect(principleIds).toContain("principle-c");
    expect(principleIds).toHaveLength(3); // deduplicated
  });
});
