/**
 * Structural typing test — verifies that KgStore satisfies IKgStore and
 * KgQuery satisfies IKgQuery.
 *
 * These are compile-time checks: if the concrete classes do not implement
 * the interfaces, TypeScript will report a type error.
 */

import { KgQuery } from "@graph/kg-query.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import { describe, expect, test } from "vitest";
import type { IKgQuery, IKgStore } from "../kg-store.interface.ts";

describe("IKgStore and IKgQuery structural compatibility", () => {
  test("KgStore satisfies IKgStore at the type level", () => {
    const db = initDatabase(":memory:");
    const store = new KgStore(db);

    // Type-level check: this assertion must compile without error.
    store satisfies IKgStore;

    expect(store).toBeDefined();

    db.close();
  });

  test("KgQuery satisfies IKgQuery at the type level", () => {
    const db = initDatabase(":memory:");
    const query = new KgQuery(db);

    // Type-level check: this assertion must compile without error.
    query satisfies IKgQuery;

    expect(query).toBeDefined();

    db.close();
  });
});
