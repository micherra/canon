/**
 * AreaMemoryDao Tests — DAO for area_observations table
 *
 * Uses in-memory SQLite (:memory:) for speed and isolation.
 * Each test gets a fresh DB via initDriftDb(':memory:') which runs all migrations
 * including v8 (area_observations).
 */

import { deriveSubsystemKey } from "@shared/lib/subsystem-key.ts";
import type Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { AreaMemoryDao } from "../area-memory-dao.ts";
import { initDriftDb } from "../drift-schema.ts";

// ---- Setup helpers ----

function makeAreaMemoryDb(): { db: Database.Database; dao: AreaMemoryDao } {
  const db = initDriftDb(":memory:");
  const dao = new AreaMemoryDao(db);
  return { dao, db };
}

// ---- insertObservation + getObservationsForSubsystems ----

describe("AreaMemoryDao.insertObservation + getObservationsForSubsystems", () => {
  test("round-trip: insert and retrieve an observation", () => {
    const { dao, db } = makeAreaMemoryDb();

    dao.insertObservation({
      content: "Watch out for DriftDb circular imports",
      source: "reviewer",
      subsystem_key: "platform/storage/drift",
    });

    const results = dao.getObservationsForSubsystems(["platform/storage/drift"]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      content: "Watch out for DriftDb circular imports",
      injected_count: 0,
      last_injected_at: null,
      source: "reviewer",
      subsystem_key: "platform/storage/drift",
      workflow_slug: null,
    });
    expect(results[0]!.id).toBeGreaterThan(0);
    expect(results[0]!.created_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
    db.close();
  });

  test("round-trip: insert with optional workflow_slug", () => {
    const { dao, db } = makeAreaMemoryDb();

    dao.insertObservation({
      content: "Simplify this module",
      source: "engineer",
      subsystem_key: "features/orchestration",
      workflow_slug: "my-build-slug",
    });

    const results = dao.getObservationsForSubsystems(["features/orchestration"]);
    expect(results).toHaveLength(1);
    expect(results[0]!.workflow_slug).toBe("my-build-slug");
    db.close();
  });

  test("returns empty array for empty subsystem keys", () => {
    const { dao, db } = makeAreaMemoryDb();
    const results = dao.getObservationsForSubsystems([]);
    expect(results).toEqual([]);
    db.close();
  });

  test("returns empty array when no observations exist for the given key", () => {
    const { dao, db } = makeAreaMemoryDb();
    const results = dao.getObservationsForSubsystems(["nonexistent/area"]);
    expect(results).toEqual([]);
    db.close();
  });

  test("returns observations from multiple subsystem keys", () => {
    const { dao, db } = makeAreaMemoryDb();

    dao.insertObservation({
      content: "Obs A",
      source: "reviewer",
      subsystem_key: "features/orchestration",
    });
    dao.insertObservation({
      content: "Obs B",
      source: "engineer",
      subsystem_key: "platform/storage/drift",
    });

    const results = dao.getObservationsForSubsystems([
      "features/orchestration",
      "platform/storage/drift",
    ]);
    expect(results).toHaveLength(2);
    const contents = results.map((r) => r.content);
    expect(contents).toContain("Obs A");
    expect(contents).toContain("Obs B");
    db.close();
  });
});

// ---- 7-day expiry ----

describe("AreaMemoryDao 7-day expiry", () => {
  test("filters out observations older than 7 days", () => {
    const { dao, db } = makeAreaMemoryDb();

    // Insert an old observation directly via raw SQL (bypassing DAO to set old created_at)
    db.prepare(`
      INSERT INTO area_observations (subsystem_key, content, source, created_at, injected_count)
      VALUES (?, ?, ?, ?, 0)
    `).run("platform/storage/drift", "Old observation", "reviewer", "2020-01-01T00:00:00.000Z");

    const results = dao.getObservationsForSubsystems(["platform/storage/drift"]);
    expect(results).toEqual([]);
    db.close();
  });

  test("includes observations within 7 days", () => {
    const { dao, db } = makeAreaMemoryDb();

    dao.insertObservation({
      content: "Recent observation",
      source: "reviewer",
      subsystem_key: "platform/storage/drift",
    });

    const results = dao.getObservationsForSubsystems(["platform/storage/drift"]);
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe("Recent observation");
    db.close();
  });
});

// ---- markInjected ----

describe("AreaMemoryDao.markInjected", () => {
  test("increments injected_count and sets last_injected_at", () => {
    const { dao, db } = makeAreaMemoryDb();

    dao.insertObservation({
      content: "Track this",
      source: "reviewer",
      subsystem_key: "features/orchestration",
    });

    const before = dao.getObservationsForSubsystems(["features/orchestration"]);
    expect(before).toHaveLength(1);
    expect(before[0]!.injected_count).toBe(0);
    expect(before[0]!.last_injected_at).toBeNull();

    dao.markInjected([before[0]!.id]);

    const after = dao.getObservationsForSubsystems(["features/orchestration"]);
    expect(after[0]!.injected_count).toBe(1);
    expect(after[0]!.last_injected_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
    db.close();
  });

  test("increments injected_count on repeated calls", () => {
    const { dao, db } = makeAreaMemoryDb();

    dao.insertObservation({
      content: "Multi-inject",
      source: "engineer",
      subsystem_key: "features/orchestration",
    });

    const obs = dao.getObservationsForSubsystems(["features/orchestration"]);
    dao.markInjected([obs[0]!.id]);
    dao.markInjected([obs[0]!.id]);

    const after = dao.getObservationsForSubsystems(["features/orchestration"]);
    expect(after[0]!.injected_count).toBe(2);
    db.close();
  });

  test("markInjected with empty ids is a no-op", () => {
    const { dao, db } = makeAreaMemoryDb();

    dao.insertObservation({
      content: "Untouched",
      source: "reviewer",
      subsystem_key: "features/orchestration",
    });

    // Should not throw
    dao.markInjected([]);

    const after = dao.getObservationsForSubsystems(["features/orchestration"]);
    expect(after[0]!.injected_count).toBe(0);
    db.close();
  });
});

// ---- deriveSubsystemKey ----

describe("deriveSubsystemKey", () => {
  test("maps deep feature path to feature/subsystem (strips tools/ leaf dir)", () => {
    expect(deriveSubsystemKey("mcp-server/src/features/orchestration/tools/write-review.ts")).toBe(
      "features/orchestration",
    );
  });

  test("maps platform storage path to platform/storage/drift", () => {
    expect(deriveSubsystemKey("mcp-server/src/platform/storage/drift/drift-db.ts")).toBe(
      "platform/storage/drift",
    );
  });

  test("maps hooks path to hooks", () => {
    expect(deriveSubsystemKey("hooks/canon-hook-lib.sh")).toBe("hooks");
  });

  test("maps __tests__ file to parent subsystem", () => {
    expect(deriveSubsystemKey("mcp-server/src/features/orchestration/__tests__/foo.test.ts")).toBe(
      "features/orchestration",
    );
  });

  test("maps root-level file to root", () => {
    expect(deriveSubsystemKey("CLAUDE.md")).toBe("root");
  });

  test("maps file with no directory to root", () => {
    expect(deriveSubsystemKey("README.md")).toBe("root");
  });

  test("strips mcp-server/src/ prefix before mapping", () => {
    const withPrefix = deriveSubsystemKey(
      "mcp-server/src/platform/storage/drift/area-memory-dao.ts",
    );
    const withoutPrefix = deriveSubsystemKey("platform/storage/drift/area-memory-dao.ts");
    // Both should produce the same result (prefix stripping is applied consistently)
    expect(withPrefix).toBe(withoutPrefix);
  });
});
