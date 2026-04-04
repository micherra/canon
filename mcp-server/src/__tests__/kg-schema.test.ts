/**
 * kg-schema.ts — initDatabase PRAGMA tests
 *
 * Tests cover:
 * - busy_timeout PRAGMA is set to 5000 after initDatabase()
 */

import { describe, expect, test } from "vitest";
import { initDatabase } from "../graph/kg-schema.ts";

// busy_timeout PRAGMA

describe("initDatabase — PRAGMAs", () => {
  test("sets busy_timeout to 5000", () => {
    const db = initDatabase(":memory:");
    const row = db.pragma("busy_timeout", { simple: true }) as number;
    expect(row).toBe(5000);
    db.close();
  });

  test("sets foreign_keys to ON", () => {
    const db = initDatabase(":memory:");
    const fk = db.pragma("foreign_keys", { simple: true }) as number;
    expect(fk).toBe(1);
    db.close();
  });
});
