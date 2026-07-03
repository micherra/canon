/**
 * drift-db-leak-guard — trip-test for checkNoDriftDbGrowth.
 *
 * Drives the PURE comparison function directly with in-memory Maps — never
 * touches the real repo `.canon/drift.db` files. The integration guard
 * (`installDriftDbLeakGuard`) is wired globally via `vitest-setup-drift-guard.ts`
 * and is exercised implicitly by every other test in the suite; this file only
 * needs to prove the pure predicate's throw/pass behavior deterministically.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkNoDriftDbGrowth,
  DriftDbLeakError,
  snapshotFlowRunsCount,
} from "../drift-db-leak-guard.ts";

describe("checkNoDriftDbGrowth", () => {
  it("throws DriftDbLeakError naming the path when a protected DB's flow_runs count grew", () => {
    const baseline = new Map([["/repo/.canon/drift.db", 510]]);
    const current = new Map([["/repo/.canon/drift.db", 511]]);

    expect(() => checkNoDriftDbGrowth(baseline, current)).toThrow(DriftDbLeakError);
    try {
      checkNoDriftDbGrowth(baseline, current);
      throw new Error("expected checkNoDriftDbGrowth to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(DriftDbLeakError);
      expect((err as Error).message).toContain("/repo/.canon/drift.db");
      expect((err as Error).message).toContain("510");
      expect((err as Error).message).toContain("511");
    }
  });

  it("throws DriftDbLeakError when a protected path newly appears (was absent, now present)", () => {
    const baseline = new Map([["/repo/mcp-server/.canon/drift.db", -1]]); // sentinel: must-not-exist
    const current = new Map([["/repo/mcp-server/.canon/drift.db", 3]]);

    expect(() => checkNoDriftDbGrowth(baseline, current)).toThrow(DriftDbLeakError);
  });

  it("does not throw when current equals baseline for all protected paths", () => {
    const baseline = new Map([
      ["/repo/.canon/drift.db", 510],
      ["/repo/mcp-server/.canon/drift.db", 856],
    ]);
    const current = new Map([
      ["/repo/.canon/drift.db", 510],
      ["/repo/mcp-server/.canon/drift.db", 856],
    ]);

    expect(() => checkNoDriftDbGrowth(baseline, current)).not.toThrow();
  });

  it("does not throw when a protected path stays absent (both sentinel -1)", () => {
    const baseline = new Map([["/repo/.canon/drift.db", -1]]);
    const current = new Map([["/repo/.canon/drift.db", -1]]);

    expect(() => checkNoDriftDbGrowth(baseline, current)).not.toThrow();
  });
});

describe("snapshotFlowRunsCount (temp DB only — never touches real repo DBs)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { force: true, recursive: true });
  });

  it("returns the sentinel -1 for a missing DB file", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "drift-guard-snapshot-"));
    const dbPath = join(tmpDir, "does-not-exist.db");
    expect(snapshotFlowRunsCount(dbPath)).toBe(-1);
  });

  it("returns the real flow_runs count for an existing temp DB, and trips on growth", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "drift-guard-snapshot-"));
    const dbPath = join(tmpDir, "temp-drift.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE flow_runs (id INTEGER PRIMARY KEY, flow TEXT)`);
    db.close();

    const baseline = snapshotFlowRunsCount(dbPath);
    expect(baseline).toBe(0);

    const writer = new DatabaseSync(dbPath);
    writer.prepare(`INSERT INTO flow_runs (flow) VALUES (?)`).run("synthetic-test-row");
    writer.close();

    const current = snapshotFlowRunsCount(dbPath);
    expect(current).toBe(1);

    expect(() =>
      checkNoDriftDbGrowth(new Map([[dbPath, baseline]]), new Map([[dbPath, current]])),
    ).toThrow(DriftDbLeakError);
  });

  it("checkNoDriftDbGrowth does NOT throw for an unrelated temp DB whose count is stable", () => {
    // Guards that a legitimate, unchanged temp fixture DB (created and read via
    // node:sqlite, never better-sqlite3) never trips the guard.
    tmpDir = mkdtempSync(join(tmpdir(), "drift-guard-snapshot-"));
    const dbPath = join(tmpDir, "stable-temp.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE flow_runs (id INTEGER PRIMARY KEY, flow TEXT)`);
    db.prepare(`INSERT INTO flow_runs (flow) VALUES (?)`).run("pre-existing-row");
    db.close();

    const baseline = snapshotFlowRunsCount(dbPath);
    const current = snapshotFlowRunsCount(dbPath);
    expect(baseline).toBe(current);
    expect(() =>
      checkNoDriftDbGrowth(new Map([[dbPath, baseline]]), new Map([[dbPath, current]])),
    ).not.toThrow();
  });
});
