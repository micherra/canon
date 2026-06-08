/**
 * Tests for cliff-event-sweep.ts
 *
 * Uses temporary filesystem fixtures with real SQLite databases — no mocks.
 * Pattern follows the archive-service tests: each test creates a real directory
 * tree under a vitest tmp dir, runs the sweep function, and asserts on the drift.db.
 *
 * Canon principles:
 * - fail-open: sweep never throws; tested with corrupt fixture and locked-out paths
 * - validate-at-trust-boundaries: malformed JSON in payload is skipped, not fatal
 * - observable-best-effort: skipped[] is populated for every failure
 */

import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriftDb } from "../../../../platform/storage/drift/drift-db.ts";
import { initDriftDb } from "../../../../platform/storage/drift/drift-schema.ts";
import { sweepCliffEvents } from "../cliff-event-sweep.ts";

// ---- Fixture helpers ----

/**
 * Create a minimal orchestration.db under:
 *   {projectDir}/.canon/workspaces/{branchDir}/{slug}/orchestration.db
 * The events table is seeded with the provided cliff_detected events.
 */
function createOrchestrationDb(
  projectDir: string,
  branchDir: string,
  slug: string,
  events: Array<{ payload: string; timestamp: string }>,
): string {
  const workspaceDir = join(projectDir, ".canon", "workspaces", branchDir, slug);
  mkdirSync(workspaceDir, { recursive: true });
  const dbPath = join(workspaceDir, "orchestration.db");

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      type      TEXT NOT NULL,
      payload   TEXT NOT NULL,
      timestamp TEXT NOT NULL
    )
  `);
  for (const evt of events) {
    db.prepare("INSERT INTO events (type, payload, timestamp) VALUES (?, ?, ?)").run(
      "cliff_detected",
      evt.payload,
      evt.timestamp,
    );
  }
  db.close();
  return dbPath;
}

/**
 * Open drift.db for the given projectDir, returning the DriftDb wrapper.
 * Creates (and migrates) the DB if it doesn't exist.
 */
function openDriftDb(projectDir: string): DriftDb {
  const driftDbPath = join(projectDir, ".canon", "drift.db");
  const raw = initDriftDb(driftDbPath);
  return new DriftDb(raw);
}

/**
 * Write a journal.json to {projectDir}/.canon/workspaces/{branchDir}/{slug}/journal.json
 * (live workspace path).
 */
function writeJournal(
  projectDir: string,
  branchDir: string,
  slug: string,
  steps: Array<{ step_id: string; agent_type?: string; status: string }>,
): void {
  const workspaceDir = join(projectDir, ".canon", "workspaces", branchDir, slug);
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, "journal.json"), JSON.stringify({ steps }));
}

/**
 * Write a journal.json to {projectDir}/.canon/history/{slug}/journal.json
 * (archived workspace path).
 */
function writeArchivedJournal(
  projectDir: string,
  slug: string,
  steps: Array<{ step_id: string; agent_type?: string; status: string }>,
): void {
  const historyDir = join(projectDir, ".canon", "history", slug);
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(join(historyDir, "journal.json"), JSON.stringify({ steps }));
}

// ---- Test setup ----

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `cliff-sweep-test-${randomUUID()}`);
  mkdirSync(tmpDir, { recursive: true });
  // Ensure .canon dir exists
  mkdirSync(join(tmpDir, ".canon"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---- Tests ----

describe("sweepCliffEvents", () => {
  it("returns zero-result for empty .canon/workspaces (AC4 zero-data tolerance)", () => {
    // No workspaces at all
    const result = sweepCliffEvents(tmpDir);

    expect(result.scanned_workspaces).toBe(0);
    expect(result.events_ingested).toBe(0);
    expect(result.outcomes_updated).toBe(0);
    expect(result.skipped).toEqual([]);
  });

  it("ingests legacy payload (incomplete_step_ids[] without steps[])", () => {
    // Mirror the real http-epic-phase2 event with 2 step ids
    const legacyPayload = JSON.stringify({
      workspace: "some-slug",
      incomplete_step_ids: ["implement", "verify"],
      needs_recovery: true,
      timestamp: "2026-06-01T10:00:00.000Z",
      source: "resume",
    });

    createOrchestrationDb(tmpDir, "branch-abc", "some-slug", [
      { payload: legacyPayload, timestamp: "2026-06-01T10:00:00.000Z" },
    ]);

    const result = sweepCliffEvents(tmpDir);

    expect(result.scanned_workspaces).toBe(1);
    expect(result.events_ingested).toBe(2); // 2 step ids → 2 rows
    expect(result.skipped).toEqual([]);

    const driftDb = openDriftDb(tmpDir);
    const rows = driftDb.getCliffEvents().getByWorkspace("some-slug");
    expect(rows).toHaveLength(2);

    const stepIds = rows.map((r) => r.step_id).sort();
    expect(stepIds).toEqual(["implement", "verify"]);

    // Legacy rows have null agent_type
    for (const row of rows) {
      expect(row.agent_type).toBeNull();
      expect(row.source).toBe("resume");
      expect(row.recovery_outcome).toBe("unknown");
    }

    driftDb.close();
  });

  it("ingests enriched payload (steps[] with agent_type and counts)", () => {
    const enrichedPayload = JSON.stringify({
      workspace: "enriched-slug",
      needs_recovery: true,
      timestamp: "2026-06-02T12:00:00.000Z",
      source: "post_subagent",
      steps: [
        {
          step_id: "implement",
          agent_type: "engineer",
          missing_count: 1,
          partial_count: 0,
        },
        {
          step_id: "review",
          agent_type: "reviewer",
          missing_count: 0,
          partial_count: 1,
        },
      ],
    });

    createOrchestrationDb(tmpDir, "branch-xyz", "enriched-slug", [
      { payload: enrichedPayload, timestamp: "2026-06-02T12:00:00.000Z" },
    ]);

    const result = sweepCliffEvents(tmpDir);

    expect(result.scanned_workspaces).toBe(1);
    expect(result.events_ingested).toBe(2);
    expect(result.skipped).toEqual([]);

    const driftDb = openDriftDb(tmpDir);
    const rows = driftDb.getCliffEvents().getByWorkspace("enriched-slug");
    expect(rows).toHaveLength(2);

    const implRow = rows.find((r) => r.step_id === "implement");
    expect(implRow?.agent_type).toBe("engineer");
    expect(implRow?.missing_count).toBe(1);
    expect(implRow?.partial_count).toBe(0);
    expect(implRow?.source).toBe("post_subagent");

    const reviewRow = rows.find((r) => r.step_id === "review");
    expect(reviewRow?.agent_type).toBe("reviewer");
    expect(reviewRow?.missing_count).toBe(0);
    expect(reviewRow?.partial_count).toBe(1);

    driftDb.close();
  });

  it("derives outcomes from journal: completed→recovered, skipped→abandoned, started→unresolved", () => {
    const payload = JSON.stringify({
      workspace: "outcome-slug",
      incomplete_step_ids: ["step-a", "step-b", "step-c"],
      needs_recovery: true,
      timestamp: "2026-06-03T08:00:00.000Z",
      source: "resume",
    });

    createOrchestrationDb(tmpDir, "branch-out", "outcome-slug", [
      { payload, timestamp: "2026-06-03T08:00:00.000Z" },
    ]);

    writeJournal(tmpDir, "branch-out", "outcome-slug", [
      { step_id: "step-a", agent_type: "engineer", status: "completed" },
      { step_id: "step-b", agent_type: "reviewer", status: "skipped" },
      { step_id: "step-c", agent_type: "tester", status: "started" },
    ]);

    const result = sweepCliffEvents(tmpDir);

    expect(result.events_ingested).toBe(3);
    expect(result.outcomes_updated).toBe(2); // completed→recovered + skipped→abandoned; started→unresolved stays

    const driftDb = openDriftDb(tmpDir);
    const rows = driftDb.getCliffEvents().getByWorkspace("outcome-slug");

    const stepA = rows.find((r) => r.step_id === "step-a");
    expect(stepA?.recovery_outcome).toBe("recovered");
    expect(stepA?.agent_type).toBe("engineer"); // recovered from journal

    const stepB = rows.find((r) => r.step_id === "step-b");
    expect(stepB?.recovery_outcome).toBe("abandoned");

    const stepC = rows.find((r) => r.step_id === "step-c");
    // started + journal found → unresolved
    expect(stepC?.recovery_outcome).toBe("unresolved");

    driftDb.close();
  });

  it("leaves recovery_outcome as 'unknown' when journal is not found", () => {
    const payload = JSON.stringify({
      workspace: "no-journal-slug",
      incomplete_step_ids: ["step-x"],
      needs_recovery: true,
      timestamp: "2026-06-04T09:00:00.000Z",
      source: "resume",
    });

    createOrchestrationDb(tmpDir, "branch-noj", "no-journal-slug", [
      { payload, timestamp: "2026-06-04T09:00:00.000Z" },
    ]);
    // No journal written

    const result = sweepCliffEvents(tmpDir);

    expect(result.events_ingested).toBe(1);
    expect(result.outcomes_updated).toBe(0); // journal absent → no update

    const driftDb = openDriftDb(tmpDir);
    const rows = driftDb.getCliffEvents().getByWorkspace("no-journal-slug");
    expect(rows[0]?.recovery_outcome).toBe("unknown");
    driftDb.close();
  });

  it("finds outcome from archived journal path (.canon/history/{slug}/journal.json)", () => {
    const slug = "archived-slug";
    const payload = JSON.stringify({
      workspace: slug,
      incomplete_step_ids: ["archive-step"],
      needs_recovery: true,
      timestamp: "2026-06-04T10:00:00.000Z",
      source: "resume",
    });

    createOrchestrationDb(tmpDir, "branch-arch", slug, [
      { payload, timestamp: "2026-06-04T10:00:00.000Z" },
    ]);

    // Write journal only to archived location (workspace dir has no journal.json)
    writeArchivedJournal(tmpDir, slug, [
      { step_id: "archive-step", agent_type: "engineer", status: "completed" },
    ]);

    const result = sweepCliffEvents(tmpDir);

    expect(result.events_ingested).toBe(1);
    expect(result.outcomes_updated).toBe(1);

    const driftDb = openDriftDb(tmpDir);
    const rows = driftDb.getCliffEvents().getByWorkspace(slug);
    expect(rows[0]?.recovery_outcome).toBe("recovered");
    driftDb.close();
  });

  it("skips corrupt DB file, still processes other workspaces", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      /* suppress console output during test */
    });

    // Create a corrupt file that is not a valid SQLite database
    const corruptDir = join(tmpDir, ".canon", "workspaces", "branch-bad", "corrupt-slug");
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(join(corruptDir, "orchestration.db"), "not a sqlite database at all");

    // Create a valid workspace alongside the corrupt one
    const validPayload = JSON.stringify({
      workspace: "valid-slug",
      incomplete_step_ids: ["step-1"],
      needs_recovery: true,
      timestamp: "2026-06-05T11:00:00.000Z",
      source: "resume",
    });
    createOrchestrationDb(tmpDir, "branch-bad", "valid-slug", [
      { payload: validPayload, timestamp: "2026-06-05T11:00:00.000Z" },
    ]);

    const result = sweepCliffEvents(tmpDir);

    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.path).toContain("corrupt-slug");
    expect(result.scanned_workspaces).toBe(2); // both dirs were visited
    expect(result.events_ingested).toBe(1); // valid workspace processed

    expect(warnSpy).toHaveBeenCalled();
  });

  it("does NOT modify the fixture orchestration.db bytes (readonly invariant)", () => {
    const payload = JSON.stringify({
      workspace: "readonly-slug",
      incomplete_step_ids: ["s1"],
      needs_recovery: true,
      timestamp: "2026-06-06T08:00:00.000Z",
      source: "resume",
    });

    const dbPath = createOrchestrationDb(tmpDir, "branch-ro", "readonly-slug", [
      { payload, timestamp: "2026-06-06T08:00:00.000Z" },
    ]);

    const beforeMtime = statSync(dbPath).mtimeMs;

    sweepCliffEvents(tmpDir);

    const afterMtime = statSync(dbPath).mtimeMs;
    // mtime should not change because we only read the DB
    expect(afterMtime).toBe(beforeMtime);
  });

  it("is idempotent: second sweep ingests 0 new rows and 0 outcome updates", () => {
    const payload = JSON.stringify({
      workspace: "idem-slug",
      incomplete_step_ids: ["step-a", "step-b"],
      needs_recovery: true,
      timestamp: "2026-06-06T09:00:00.000Z",
      source: "resume",
    });

    createOrchestrationDb(tmpDir, "branch-idem", "idem-slug", [
      { payload, timestamp: "2026-06-06T09:00:00.000Z" },
    ]);

    writeJournal(tmpDir, "branch-idem", "idem-slug", [
      { step_id: "step-a", status: "completed" },
      { step_id: "step-b", status: "skipped" },
    ]);

    // First sweep
    const first = sweepCliffEvents(tmpDir);
    expect(first.events_ingested).toBe(2);
    expect(first.outcomes_updated).toBe(2);

    // Second sweep — no new data
    const second = sweepCliffEvents(tmpDir);
    expect(second.events_ingested).toBe(0);
    expect(second.outcomes_updated).toBe(0);

    // Row count unchanged
    const driftDb = openDriftDb(tmpDir);
    const rows = driftDb.getCliffEvents().getByWorkspace("idem-slug");
    expect(rows).toHaveLength(2);
    driftDb.close();
  });

  it("processes multiple workspaces across multiple branch dirs", () => {
    const p1 = JSON.stringify({
      workspace: "ws1",
      incomplete_step_ids: ["a"],
      needs_recovery: true,
      timestamp: "2026-06-06T10:00:00.000Z",
      source: "resume",
    });
    const p2 = JSON.stringify({
      workspace: "ws2",
      incomplete_step_ids: ["b", "c"],
      needs_recovery: true,
      timestamp: "2026-06-06T11:00:00.000Z",
      source: "post_subagent",
    });

    createOrchestrationDb(tmpDir, "branch-1", "ws1", [
      { payload: p1, timestamp: "2026-06-06T10:00:00.000Z" },
    ]);
    createOrchestrationDb(tmpDir, "branch-2", "ws2", [
      { payload: p2, timestamp: "2026-06-06T11:00:00.000Z" },
    ]);

    const result = sweepCliffEvents(tmpDir);

    expect(result.scanned_workspaces).toBe(2);
    expect(result.events_ingested).toBe(3); // 1 + 2
    expect(result.skipped).toEqual([]);
  });

  it("absent workspaces dir is treated as normal (no warn, no skipped entry)", () => {
    // Use a non-existent projectDir — existsSync guard returns false silently
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      /* suppress console output during test */
    });

    const badProjectDir = join(tmpDir, "nonexistent-project");

    let result: ReturnType<typeof sweepCliffEvents> | undefined;
    expect(() => {
      result = sweepCliffEvents(badProjectDir);
    }).not.toThrow();

    // Returns empty result without warning (absent dir is not an error)
    expect(result?.scanned_workspaces).toBe(0);
    expect(result?.events_ingested).toBe(0);
    expect(result?.skipped).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("warns and records skipped[] when a branch dir is unreadable (observable-best-effort)", () => {
    // Create a valid workspace first so the workspaces root exists
    const validPayload = JSON.stringify({
      workspace: "readable-ws",
      incomplete_step_ids: ["step-1"],
      needs_recovery: true,
      timestamp: "2026-06-07T10:00:00.000Z",
      source: "resume",
    });
    createOrchestrationDb(tmpDir, "branch-readable", "readable-ws", [
      { payload: validPayload, timestamp: "2026-06-07T10:00:00.000Z" },
    ]);

    // Create an unreadable branch dir alongside the readable one
    const unreadableBranchDir = join(tmpDir, ".canon", "workspaces", "branch-unreadable");
    mkdirSync(unreadableBranchDir, { recursive: true });
    // Make the branch dir itself unreadable (chmod 000)
    chmodSync(unreadableBranchDir, 0o000);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
      /* suppress console output during test */
    });

    let result: ReturnType<typeof sweepCliffEvents> | undefined;
    try {
      expect(() => {
        result = sweepCliffEvents(tmpDir);
      }).not.toThrow();

      // The unreadable branch is recorded in skipped[]
      expect(result?.skipped.some((s) => s.path.includes("branch-unreadable"))).toBe(true);
      // The readable workspace was still processed
      expect(result?.events_ingested).toBe(1);
      // warn was called for the unreadable branch
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      // Restore permissions so cleanup can run
      chmodSync(unreadableBranchDir, 0o755);
      warnSpy.mockRestore();
    }
  });

  it("recovers agent_type from journal when legacy payload has null agent_type", () => {
    const payload = JSON.stringify({
      workspace: "agenttype-slug",
      incomplete_step_ids: ["step-1"],
      needs_recovery: true,
      timestamp: "2026-06-07T08:00:00.000Z",
      source: "resume",
    });

    createOrchestrationDb(tmpDir, "branch-at", "agenttype-slug", [
      { payload, timestamp: "2026-06-07T08:00:00.000Z" },
    ]);

    writeJournal(tmpDir, "branch-at", "agenttype-slug", [
      { step_id: "step-1", agent_type: "engineer", status: "started" },
    ]);

    sweepCliffEvents(tmpDir);

    const driftDb = openDriftDb(tmpDir);
    const rows = driftDb.getCliffEvents().getByWorkspace("agenttype-slug");
    // agent_type should be recovered from journal (COALESCE in DAO)
    // The sweep re-upserts with agent_type from journal
    expect(rows[0]?.agent_type).toBe("engineer");
    driftDb.close();
  });
});
