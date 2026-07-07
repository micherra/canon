/**
 * Tests for computeCliffEventsDimension — pure cliff_events dimension compute.
 *
 * AC4 (sparse-data contract):
 * - 0 events → status "no_data", tier "insufficient", all-zero aggregations
 * - 1–4 events → status "observed", tier "insufficient", verbatim counts
 * - 5+ events → status "observed", tier per deriveTier
 *
 * Purity: same input twice → deep-equal output; input array not mutated.
 *
 * Integration:
 * - analyzeCrossRunPatterns `since` cutoff excludes older cliff rows from counts
 */

import type { CliffEventRow } from "@platform/storage/drift/cliff-events-dao.ts";
import { describe, expect, it } from "vitest";
import { DriftDb } from "../../../../platform/storage/drift/drift-db.ts";
import { initDriftDb } from "../../../../platform/storage/drift/drift-schema.ts";
import { analyzeCrossRunPatterns } from "../cross-run-analyzer.ts";
import { computeCliffEventsDimension } from "../cross-run-cliff-events.ts";

// ---- Shared in-memory DB helper ----

function makeDb(): DriftDb {
  const raw = initDriftDb(":memory:");
  return new DriftDb(raw);
}

// ---- Fixture helpers ----

function makeRow(
  overrides: Partial<CliffEventRow> & {
    workspace_slug: string;
    step_id: string;
  },
): CliffEventRow {
  return {
    id: 1,
    agent_type: null,
    source: "post_subagent",
    detected_at: "2026-06-06T00:00:00.000Z",
    missing_count: 1,
    partial_count: 0,
    recovery_outcome: "unknown",
    recorded_at: "2026-06-06T00:00:00.000Z",
    transcript_path: null,
    transcript_uncaptured_reason: null,
    ...overrides,
  };
}

// ---- Tests ----

describe("computeCliffEventsDimension", () => {
  describe("AC4 — 0 events: no_data status, zero-confidence", () => {
    it("returns status no_data for empty input", () => {
      const result = computeCliffEventsDimension([]);
      expect(result.status).toBe("no_data");
    });

    it("returns total_cliffs: 0 for empty input", () => {
      const result = computeCliffEventsDimension([]);
      expect(result.total_cliffs).toBe(0);
    });

    it("returns workspaces_affected: 0 for empty input", () => {
      const result = computeCliffEventsDimension([]);
      expect(result.workspaces_affected).toBe(0);
    });

    it("returns empty buckets for all groupings for empty input", () => {
      const result = computeCliffEventsDimension([]);
      expect(result.by_agent_type).toEqual([]);
      expect(result.by_step_id).toEqual([]);
      expect(result.by_source).toEqual([]);
    });

    it("returns all-zero recovery_outcomes with all four keys for empty input", () => {
      const result = computeCliffEventsDimension([]);
      expect(result.recovery_outcomes).toEqual({
        recovered: 0,
        abandoned: 0,
        unresolved: 0,
        unknown: 0,
      });
    });

    it("returns tier: insufficient (zero-confidence) for empty input", () => {
      const result = computeCliffEventsDimension([]);
      expect(result.confidence.tier).toBe("insufficient");
      expect(result.confidence.sample_size).toBe(0);
    });

    it("never throws for empty input", () => {
      expect(() => computeCliffEventsDimension([])).not.toThrow();
    });
  });

  describe("AC4 — 2 events (sparse): status observed, tier insufficient", () => {
    const twoRows: CliffEventRow[] = [
      makeRow({
        workspace_slug: "ws-a",
        step_id: "test",
        source: "post_subagent",
        agent_type: null,
      }),
      makeRow({
        workspace_slug: "ws-a",
        step_id: "context-sync",
        source: "post_subagent",
        agent_type: null,
        id: 2,
      }),
    ];

    it("returns status observed for 2 rows", () => {
      const result = computeCliffEventsDimension(twoRows);
      expect(result.status).toBe("observed");
    });

    it("returns total_cliffs: 2 for 2 rows", () => {
      const result = computeCliffEventsDimension(twoRows);
      expect(result.total_cliffs).toBe(2);
    });

    it("returns tier: insufficient for sample_size < 5", () => {
      const result = computeCliffEventsDimension(twoRows);
      expect(result.confidence.tier).toBe("insufficient");
    });

    it("returns sample_size: 2 for 2 rows", () => {
      const result = computeCliffEventsDimension(twoRows);
      expect(result.confidence.sample_size).toBe(2);
    });

    it("buckets null agent_type as 'unknown'", () => {
      const result = computeCliffEventsDimension(twoRows);
      expect(result.by_agent_type).toEqual([{ key: "unknown", count: 2 }]);
    });

    it("all four recovery outcome keys present", () => {
      const result = computeCliffEventsDimension(twoRows);
      expect(Object.keys(result.recovery_outcomes).sort()).toEqual([
        "abandoned",
        "recovered",
        "unknown",
        "unresolved",
      ]);
    });
  });

  describe("6 rows across 3 workspaces — full reporting", () => {
    const sixRows: CliffEventRow[] = [
      makeRow({
        id: 1,
        workspace_slug: "ws-a",
        step_id: "implement",
        agent_type: "engineer",
        source: "resume",
        recovery_outcome: "recovered",
      }),
      makeRow({
        id: 2,
        workspace_slug: "ws-a",
        step_id: "review",
        agent_type: "reviewer",
        source: "resume",
        recovery_outcome: "abandoned",
      }),
      makeRow({
        id: 3,
        workspace_slug: "ws-b",
        step_id: "implement",
        agent_type: "engineer",
        source: "post_subagent",
        recovery_outcome: "recovered",
      }),
      makeRow({
        id: 4,
        workspace_slug: "ws-b",
        step_id: "verify",
        agent_type: null,
        source: "post_subagent",
        recovery_outcome: "unresolved",
      }),
      makeRow({
        id: 5,
        workspace_slug: "ws-c",
        step_id: "review",
        agent_type: "reviewer",
        source: "resume",
        recovery_outcome: "unknown",
      }),
      makeRow({
        id: 6,
        workspace_slug: "ws-c",
        step_id: "ship",
        agent_type: "engineer",
        source: "resume",
        recovery_outcome: "recovered",
      }),
    ];

    it("returns status observed for 6 rows", () => {
      const result = computeCliffEventsDimension(sixRows);
      expect(result.status).toBe("observed");
    });

    it("returns total_cliffs: 6", () => {
      const result = computeCliffEventsDimension(sixRows);
      expect(result.total_cliffs).toBe(6);
    });

    it("returns workspaces_affected: 3", () => {
      const result = computeCliffEventsDimension(sixRows);
      expect(result.workspaces_affected).toBe(3);
    });

    it("returns correct by_agent_type buckets sorted count desc, key asc", () => {
      const result = computeCliffEventsDimension(sixRows);
      // engineer: 3, reviewer: 2, unknown: 1
      expect(result.by_agent_type).toEqual([
        { key: "engineer", count: 3 },
        { key: "reviewer", count: 2 },
        { key: "unknown", count: 1 },
      ]);
    });

    it("returns correct by_step_id buckets sorted count desc, key asc", () => {
      const result = computeCliffEventsDimension(sixRows);
      // implement: 2, review: 2, ship: 1, verify: 1
      // When tied at count 2, implement < review alphabetically
      expect(result.by_step_id).toEqual([
        { key: "implement", count: 2 },
        { key: "review", count: 2 },
        { key: "ship", count: 1 },
        { key: "verify", count: 1 },
      ]);
    });

    it("returns correct by_source buckets sorted count desc, key asc", () => {
      const result = computeCliffEventsDimension(sixRows);
      // resume: 4, post_subagent: 2
      expect(result.by_source).toEqual([
        { key: "resume", count: 4 },
        { key: "post_subagent", count: 2 },
      ]);
    });

    it("returns all four recovery_outcome keys with correct counts", () => {
      const result = computeCliffEventsDimension(sixRows);
      expect(result.recovery_outcomes).toEqual({
        recovered: 3,
        abandoned: 1,
        unresolved: 1,
        unknown: 1,
      });
    });

    it("returns tier NOT insufficient for sample_size >= 5", () => {
      const result = computeCliffEventsDimension(sixRows);
      expect(result.confidence.tier).not.toBe("insufficient");
    });

    it("returns sample_size: 6", () => {
      const result = computeCliffEventsDimension(sixRows);
      expect(result.confidence.sample_size).toBe(6);
    });
  });

  describe("purity guarantees", () => {
    it("same input twice yields deep-equal output", () => {
      const rows: CliffEventRow[] = [
        makeRow({ workspace_slug: "ws-a", step_id: "implement", agent_type: "engineer" }),
        makeRow({
          id: 2,
          workspace_slug: "ws-b",
          step_id: "review",
          agent_type: null,
        }),
      ];

      const result1 = computeCliffEventsDimension(rows);
      const result2 = computeCliffEventsDimension(rows);
      expect(result1).toEqual(result2);
    });

    it("does not mutate the input array", () => {
      const rows: CliffEventRow[] = [
        makeRow({ workspace_slug: "ws-a", step_id: "implement" }),
        makeRow({ id: 2, workspace_slug: "ws-b", step_id: "review" }),
      ];
      const snapshot = JSON.stringify(rows);
      computeCliffEventsDimension(rows);
      expect(JSON.stringify(rows)).toBe(snapshot);
    });
  });
});

// ---- `since` filter integration ----

describe("analyzeCrossRunPatterns — cliff_events since filter", () => {
  it("excludes cliff rows older than `since` from total_cliffs", () => {
    const store = makeDb();
    const cliffDao = store.getCliffEvents();

    // Two rows: one old (before cutoff), one recent (after cutoff)
    cliffDao.upsert({
      workspace_slug: "ws-old",
      step_id: "implement",
      source: "post_subagent",
      detected_at: "2026-01-01T00:00:00.000Z",
    });
    cliffDao.upsert({
      workspace_slug: "ws-new",
      step_id: "review",
      source: "resume",
      detected_at: "2026-06-01T00:00:00.000Z",
    });

    const cutoff = "2026-03-01T00:00:00.000Z";
    const result = analyzeCrossRunPatterns(store, [], { since: cutoff });

    // Only the 2026-06-01 row survives the cutoff — total_cliffs must be 1
    expect(result.cliff_events.total_cliffs).toBe(1);
  });

  it("returns total_cliffs: 0 when all rows are older than `since`", () => {
    const store = makeDb();
    const cliffDao = store.getCliffEvents();

    cliffDao.upsert({
      workspace_slug: "ws-old",
      step_id: "implement",
      source: "post_subagent",
      detected_at: "2025-12-01T00:00:00.000Z",
    });

    const cutoff = "2026-01-01T00:00:00.000Z";
    const result = analyzeCrossRunPatterns(store, [], { since: cutoff });

    expect(result.cliff_events.total_cliffs).toBe(0);
    expect(result.cliff_events.status).toBe("no_data");
  });

  it("returns all rows when `since` is not provided", () => {
    const store = makeDb();
    const cliffDao = store.getCliffEvents();

    cliffDao.upsert({
      workspace_slug: "ws-a",
      step_id: "implement",
      source: "post_subagent",
      detected_at: "2025-06-01T00:00:00.000Z",
    });
    cliffDao.upsert({
      workspace_slug: "ws-b",
      step_id: "review",
      source: "resume",
      detected_at: "2026-06-01T00:00:00.000Z",
    });

    const result = analyzeCrossRunPatterns(store, []);

    expect(result.cliff_events.total_cliffs).toBe(2);
  });
});
