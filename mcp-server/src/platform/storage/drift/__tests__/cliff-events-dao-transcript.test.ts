/**
 * cliff-events-dao-transcript.test.ts
 *
 * Tests for CliffEventsDao transcript_path / transcript_uncaptured_reason columns
 * (v15, cliff-transcript-01) — split out of cliff-events-dao.test.ts (2026-07-06)
 * to keep both files under the 600-line biome noExcessiveLinesPerFile limit.
 *
 * Covers:
 * - column presence after the v14→v15 migration
 * - storing transcript_path / transcript_uncaptured_reason independently
 * - legacy inserts with neither field
 * - the path-or-reason invariant: a resulting row with a transcript_path never
 *   also carries a transcript_uncaptured_reason, in both directions
 *   (marker-then-capture, capture-then-marker-upsert), plus the pre-existing
 *   count-only COALESCE-preservation behavior
 */

import { beforeEach, describe, expect, it } from "vitest";
import { CliffEventsDao } from "../cliff-events-dao.ts";
import { initDriftDb } from "../drift-schema.ts";

function makeDb() {
  return initDriftDb(":memory:");
}

describe("CliffEventsDao — transcript columns (v15)", () => {
  let db: ReturnType<typeof makeDb>;
  let dao: CliffEventsDao;

  beforeEach(() => {
    db = makeDb();
    dao = new CliffEventsDao(db);
  });

  it("v14→v15 migration adds transcript_path and transcript_uncaptured_reason columns", () => {
    const columns = db.prepare("PRAGMA table_info(cliff_events)").all() as Array<{
      name: string;
    }>;
    const names = columns.map((c) => c.name);
    expect(names).toContain("transcript_path");
    expect(names).toContain("transcript_uncaptured_reason");
  });

  it("stores transcript_path when provided", () => {
    dao.upsert({
      detected_at: "2026-07-06T10:00:00.000Z",
      source: "post_subagent",
      step_id: "implement",
      transcript_path: "/workspace/transcripts/implement--engineer--iso.jsonl",
      workspace_slug: "ws",
    });

    const rows = dao.getAll();
    expect(rows[0].transcript_path).toBe("/workspace/transcripts/implement--engineer--iso.jsonl");
    expect(rows[0].transcript_uncaptured_reason).toBeNull();
  });

  it("stores transcript_uncaptured_reason when provided", () => {
    dao.upsert({
      detected_at: "2026-07-06T10:00:00.000Z",
      source: "post_subagent",
      step_id: "implement",
      transcript_uncaptured_reason: "no_source_match",
      workspace_slug: "ws",
    });

    const rows = dao.getAll();
    expect(rows[0].transcript_path).toBeNull();
    expect(rows[0].transcript_uncaptured_reason).toBe("no_source_match");
  });

  it("legacy insert with no transcript fields still works (both columns null)", () => {
    dao.upsert({
      detected_at: "2026-07-06T10:00:00.000Z",
      source: "post_subagent",
      step_id: "legacy-step",
      workspace_slug: "ws",
    });

    const rows = dao.getAll();
    expect(rows[0].transcript_path).toBeNull();
    expect(rows[0].transcript_uncaptured_reason).toBeNull();
  });

  it("COALESCE preserves a previously-captured transcript_path across a later count-only upsert", () => {
    dao.upsert({
      detected_at: "2026-07-06T10:00:00.000Z",
      source: "post_subagent",
      step_id: "implement",
      transcript_path: "/workspace/transcripts/implement--engineer--iso.jsonl",
      workspace_slug: "ws",
    });

    // Later re-upsert (e.g. a repeated cliff-detection tick) with no transcript fields.
    dao.upsert({
      detected_at: "2026-07-06T11:00:00.000Z",
      missing_count: 1,
      source: "resume",
      step_id: "implement",
      workspace_slug: "ws",
    });

    const rows = dao.getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].transcript_path).toBe("/workspace/transcripts/implement--engineer--iso.jsonl");
    expect(rows[0].missing_count).toBe(1);
  });

  it("path-or-reason invariant: marker-then-capture clears the stale reason once a path lands", () => {
    // First upsert: absent-marker only (no fixture matched yet).
    dao.upsert({
      detected_at: "2026-07-06T10:00:00.000Z",
      source: "post_subagent",
      step_id: "implement",
      transcript_uncaptured_reason: "no_source_match",
      workspace_slug: "ws",
    });

    let rows = dao.getAll();
    expect(rows[0].transcript_path).toBeNull();
    expect(rows[0].transcript_uncaptured_reason).toBe("no_source_match");

    // Later reconcile succeeds in capturing the transcript.
    dao.upsert({
      detected_at: "2026-07-06T11:00:00.000Z",
      source: "resume",
      step_id: "implement",
      transcript_path: "/workspace/transcripts/implement--engineer--iso.jsonl",
      workspace_slug: "ws",
    });

    rows = dao.getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].transcript_path).toBe("/workspace/transcripts/implement--engineer--iso.jsonl");
    expect(rows[0].transcript_uncaptured_reason).toBeNull();
  });

  it("path-or-reason invariant: capture-then-marker-upsert preserves the path and does not let an incoming reason clobber it", () => {
    // First upsert: transcript already captured.
    dao.upsert({
      detected_at: "2026-07-06T10:00:00.000Z",
      source: "post_subagent",
      step_id: "implement",
      transcript_path: "/workspace/transcripts/implement--engineer--iso.jsonl",
      workspace_slug: "ws",
    });

    // A later upsert somehow carries an absent-marker reason alongside no path
    // (e.g. a stale caller re-running detection against an already-captured step).
    dao.upsert({
      detected_at: "2026-07-06T11:00:00.000Z",
      source: "resume",
      step_id: "implement",
      transcript_uncaptured_reason: "no_source_match",
      workspace_slug: "ws",
    });

    const rows = dao.getAll();
    expect(rows).toHaveLength(1);
    expect(rows[0].transcript_path).toBe("/workspace/transcripts/implement--engineer--iso.jsonl");
    expect(rows[0].transcript_uncaptured_reason).toBeNull();
  });
});
