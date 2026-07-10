/**
 * reconcile-cliff-events.test.ts
 *
 * Tests for the one-shot audited cleanup of the 14 historical false-positive
 * context-sync cliff_events rows (fix-reconcileworkspace-so-a-never-dispatched-
 * planned-step-startedat, task-02).
 *
 * Uses an isolated `mkdtemp` projectDir + `getDriftDb(tempDir)` seeded with
 * fixture rows via `getCliffEvents().upsert(...)` (drift-db-leak-guard
 * convention — never the repo's real `.canon/drift.db`). `evictDriftDbForScope`
 * in afterEach.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evictDriftDbForScope, getDriftDb } from "@platform/storage/drift/drift-db-cache.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliffEventDeleteSpec } from "../cliff-events-dao.ts";
import { CliffEventsDao } from "../cliff-events-dao.ts";
import { initDriftDb } from "../drift-schema.ts";
import {
  AUDITED_FALSE_CLIFF_CONTEXT_SYNC_2026_07,
  reconcileFalseCliffEvents,
} from "../reconcile-cliff-events.ts";

// One excluded (no-archive) row — id 55, preserved.
const EXCLUDED_NO_ARCHIVE: CliffEventDeleteSpec = {
  detected_at: "2026-06-29T23:25:42.663Z",
  step_id: "context-sync",
  workspace_slug: "workflow-integration-epic-increment-0-canon-probe-canary-workflow-ci",
};

// Non-context-sync rows — unaudited, must be left untouched.
const NON_CONTEXT_SYNC_ROWS: CliffEventDeleteSpec[] = [
  { detected_at: "2026-06-20T10:00:00.000Z", step_id: "implement", workspace_slug: "some-build" },
  { detected_at: "2026-06-21T11:00:00.000Z", step_id: "review", workspace_slug: "another-build" },
];

let projectDir: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "canon-reconcile-cliff-events-"));
});

afterEach(async () => {
  evictDriftDbForScope(projectDir);
  await rm(projectDir, { force: true, recursive: true });
});

/** Seed the fixture drift.db with the 14 audited rows + excluded + non-context-sync rows. */
function seedFixtureRows(): void {
  const dao = getDriftDb(projectDir).getCliffEvents();
  const allSpecs: CliffEventDeleteSpec[] = [
    ...AUDITED_FALSE_CLIFF_CONTEXT_SYNC_2026_07,
    EXCLUDED_NO_ARCHIVE,
    ...NON_CONTEXT_SYNC_ROWS,
  ];
  for (const spec of allSpecs) {
    dao.upsert({
      detected_at: spec.detected_at,
      source: "post_subagent",
      step_id: spec.step_id,
      workspace_slug: spec.workspace_slug,
    });
  }
}

describe("reconcileFalseCliffEvents — audited one-shot cleanup", () => {
  it("removes exactly the 14 audited rows", () => {
    seedFixtureRows();

    const result = reconcileFalseCliffEvents(projectDir, AUDITED_FALSE_CLIFF_CONTEXT_SYNC_2026_07);

    expect(result).toEqual({ deleted: 14, not_found: 0 });

    const remaining = getDriftDb(projectDir).getCliffEvents().getAll();
    const remainingKeys = new Set(
      remaining.map((r) => `${r.workspace_slug}\0${r.step_id}\0${r.detected_at}`),
    );
    for (const spec of AUDITED_FALSE_CLIFF_CONTEXT_SYNC_2026_07) {
      expect(
        remainingKeys.has(`${spec.workspace_slug}\0${spec.step_id}\0${spec.detected_at}`),
      ).toBe(false);
    }
  });

  it("preserves the excluded no-archive row and all non-context-sync rows", () => {
    seedFixtureRows();

    reconcileFalseCliffEvents(projectDir, AUDITED_FALSE_CLIFF_CONTEXT_SYNC_2026_07);

    const remaining = getDriftDb(projectDir).getCliffEvents().getAll();
    const remainingKeys = new Set(
      remaining.map((r) => `${r.workspace_slug}\0${r.step_id}\0${r.detected_at}`),
    );
    expect(
      remainingKeys.has(
        `${EXCLUDED_NO_ARCHIVE.workspace_slug}\0${EXCLUDED_NO_ARCHIVE.step_id}\0${EXCLUDED_NO_ARCHIVE.detected_at}`,
      ),
    ).toBe(true);
    for (const row of NON_CONTEXT_SYNC_ROWS) {
      expect(remainingKeys.has(`${row.workspace_slug}\0${row.step_id}\0${row.detected_at}`)).toBe(
        true,
      );
    }
  });

  it("idempotent — a second run returns { deleted: 0, not_found: 14 } and leaves the table unchanged", () => {
    seedFixtureRows();

    reconcileFalseCliffEvents(projectDir, AUDITED_FALSE_CLIFF_CONTEXT_SYNC_2026_07);
    const before = getDriftDb(projectDir).getCliffEvents().getAll();

    const second = reconcileFalseCliffEvents(projectDir, AUDITED_FALSE_CLIFF_CONTEXT_SYNC_2026_07);

    expect(second).toEqual({ deleted: 0, not_found: 14 });
    const after = getDriftDb(projectDir).getCliffEvents().getAll();
    expect(after).toEqual(before);
  });

  it("a row with the same (workspace_slug, step_id) but a DIFFERENT detected_at is NOT deleted (future genuine re-detection guard)", () => {
    const dao = getDriftDb(projectDir).getCliffEvents();
    const spec = AUDITED_FALSE_CLIFF_CONTEXT_SYNC_2026_07[0];
    // Re-detected with a NEW detected_at (upsert overwrites the row's detected_at
    // in place — UNIQUE(workspace_slug, step_id) — simulating a genuine re-cliff).
    dao.upsert({
      detected_at: "2099-01-01T00:00:00.000Z",
      source: "post_subagent",
      step_id: spec.step_id,
      workspace_slug: spec.workspace_slug,
    });

    const result = reconcileFalseCliffEvents(projectDir, [spec]);

    expect(result).toEqual({ deleted: 0, not_found: 1 });
    const remaining = getDriftDb(projectDir).getCliffEvents().getAll();
    expect(remaining.find((r) => r.workspace_slug === spec.workspace_slug)?.detected_at).toBe(
      "2099-01-01T00:00:00.000Z",
    );
  });
});

describe("CliffEventsDao.deleteByExactIdentity — DAO unit", () => {
  it("empty specs → { deleted: 0, not_found: 0 } with no DB work", () => {
    const db = initDriftDb(":memory:");
    const dao = new CliffEventsDao(db);

    const result = dao.deleteByExactIdentity([]);

    expect(result).toEqual({ deleted: 0, not_found: 0 });
  });
});

describe("AUDITED_FALSE_CLIFF_CONTEXT_SYNC_2026_07", () => {
  it("has exactly 14 entries, all well-formed", () => {
    expect(AUDITED_FALSE_CLIFF_CONTEXT_SYNC_2026_07).toHaveLength(14);
    for (const spec of AUDITED_FALSE_CLIFF_CONTEXT_SYNC_2026_07) {
      expect(typeof spec.workspace_slug).toBe("string");
      expect(spec.workspace_slug.length).toBeGreaterThan(0);
      expect(spec.step_id === "context-sync" || spec.step_id === "context-sync-codex-fix").toBe(
        true,
      );
      expect(typeof spec.detected_at).toBe("string");
    }
  });

  it("does not include the excluded no-archive row (id 55)", () => {
    const hasExcluded = AUDITED_FALSE_CLIFF_CONTEXT_SYNC_2026_07.some(
      (s) =>
        s.workspace_slug === EXCLUDED_NO_ARCHIVE.workspace_slug &&
        s.detected_at === EXCLUDED_NO_ARCHIVE.detected_at,
    );
    expect(hasExcluded).toBe(false);
  });

  it("no duplicate identity tuples", () => {
    const keys = AUDITED_FALSE_CLIFF_CONTEXT_SYNC_2026_07.map(
      (s) => `${s.workspace_slug}\0${s.step_id}\0${s.detected_at}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
