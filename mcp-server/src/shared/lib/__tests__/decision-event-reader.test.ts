/**
 * decision-event-reader.test.ts
 *
 * Tests for readDecisionEvents — the raw readonly reader for
 * `orchestrator_decision` events, shared by the janitor's reap-time persist
 * path and (in a later build) the cross-workspace corpus reader.
 *
 * Test plan (T-01-PLAN.md):
 * - happy path: fixture store with 2 decisions -> 2 records, fields mapped incl. gate/refs
 * - missing file -> []
 * - db with no `events` table -> []
 * - readonly guarantee: no write on open (no schema_version bump / mtime change; file
 *   remains deletable immediately after)
 * - malformed payload row skipped-safe (other rows still returned)
 */

import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { readDecisionEvents } from "../decision-event-reader.ts";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "decision-event-reader-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

/** Build a minimal orchestration-store-shaped events table with given rows. */
function makeEventsDb(
  dbPath: string,
  rows: Array<{ type: string; payload: string; timestamp: string }>,
): void {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    timestamp TEXT NOT NULL
  )`);
  const insert = db.prepare("INSERT INTO events (type, payload, timestamp) VALUES (?, ?, ?)");
  for (const row of rows) {
    insert.run(row.type, row.payload, row.timestamp);
  }
  db.close();
}

describe("readDecisionEvents — happy path", () => {
  it("reads 2 decisions from a fixture store, mapping all fields incl. gate/refs", () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, "orchestration.db");
    makeEventsDb(dbPath, [
      {
        payload: JSON.stringify({
          decision_type: "hitl_gate",
          gate: "plan_approval",
          outcome: "approved",
          rationale: "design looked sound",
          refs: ["DESIGN.md"],
          summary: "Approved the plan",
          timestamp: "2026-07-01T10:00:00.000Z",
        }),
        timestamp: "2026-07-01T10:00:00.000Z",
        type: "orchestrator_decision",
      },
      {
        payload: JSON.stringify({
          decision_type: "scope_cut",
          outcome: "descoped",
          summary: "Cut the reader tool from this wave",
          timestamp: "2026-07-01T11:00:00.000Z",
        }),
        timestamp: "2026-07-01T11:00:00.000Z",
        type: "orchestrator_decision",
      },
      {
        payload: JSON.stringify({ decision_type: "other", summary: "irrelevant type" }),
        timestamp: "2026-07-01T09:00:00.000Z",
        type: "some_other_event",
      },
    ]);

    const records = readDecisionEvents(dbPath);

    expect(records).toHaveLength(2);
    expect(records[0].source_event_id).toBe(1);
    expect(records[0].decision_type).toBe("hitl_gate");
    expect(records[0].gate).toBe("plan_approval");
    expect(records[0].outcome).toBe("approved");
    expect(records[0].rationale).toBe("design looked sound");
    expect(records[0].refs).toEqual(["DESIGN.md"]);
    expect(records[0].decided_at).toBe("2026-07-01T10:00:00.000Z");
    expect(records[1].source_event_id).toBe(2);
    expect(records[1].decision_type).toBe("scope_cut");
    expect(records[1].gate).toBeUndefined();
    expect(records[1].refs).toBeUndefined();
  });

  it("falls back to the row's timestamp when payload.timestamp is absent", () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, "orchestration.db");
    makeEventsDb(dbPath, [
      {
        payload: JSON.stringify({ decision_type: "other", summary: "no payload timestamp" }),
        timestamp: "2026-07-02T08:00:00.000Z",
        type: "orchestrator_decision",
      },
    ]);

    const records = readDecisionEvents(dbPath);

    expect(records).toHaveLength(1);
    expect(records[0].decided_at).toBe("2026-07-02T08:00:00.000Z");
  });
});

describe("readDecisionEvents — fail-open on abnormal stores", () => {
  it("returns [] when the file does not exist", () => {
    const dir = makeTmpDir();
    const records = readDecisionEvents(join(dir, "does-not-exist.db"));
    expect(records).toEqual([]);
  });

  it("returns [] when the db has no events table", () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, "no-events-table.db");
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE unrelated (id INTEGER PRIMARY KEY)`);
    db.close();

    const records = readDecisionEvents(dbPath);
    expect(records).toEqual([]);
  });

  it("skips a malformed-payload row but still returns the well-formed ones", () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, "malformed.db");
    makeEventsDb(dbPath, [
      {
        payload: "not json{{{",
        timestamp: "2026-07-01T10:00:00.000Z",
        type: "orchestrator_decision",
      },
      {
        payload: JSON.stringify({ decision_type: "other", summary: "well formed" }),
        timestamp: "2026-07-01T11:00:00.000Z",
        type: "orchestrator_decision",
      },
    ]);

    const records = readDecisionEvents(dbPath);
    expect(records).toHaveLength(1);
    expect(records[0].summary).toBe("well formed");
  });
});

describe("readDecisionEvents — readonly guarantee", () => {
  it("never writes to the store on open (no mtime change; file deletable immediately after)", () => {
    const dir = makeTmpDir();
    const dbPath = join(dir, "readonly-check.db");
    makeEventsDb(dbPath, [
      {
        payload: JSON.stringify({ decision_type: "other", summary: "x" }),
        timestamp: "2026-07-01T10:00:00.000Z",
        type: "orchestrator_decision",
      },
    ]);
    const mtimeBefore = statSync(dbPath).mtimeMs;

    readDecisionEvents(dbPath);

    expect(existsSync(dbPath)).toBe(true);
    expect(statSync(dbPath).mtimeMs).toBe(mtimeBefore);

    // The file must be immediately deletable — no lingering write handle.
    expect(() => unlinkSync(dbPath)).not.toThrow();
  });
});
