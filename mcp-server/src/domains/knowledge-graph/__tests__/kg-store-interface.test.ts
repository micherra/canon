/**
 * Structural typing test — verifies that KgStore satisfies IKgStore and
 * KgQuery satisfies IKgQuery.
 *
 * These are compile-time checks: if the concrete classes do not implement
 * the interfaces, TypeScript will report a type error.
 */

import { describe, expect, test } from "vitest";
import { KgQuery } from "@graph/kg-query.ts";
import { KgStore } from "@graph/kg-store.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import type { IKgStore, IKgQuery } from "../kg-store.interface.ts";

describe("IKgStore and IKgQuery structural compatibility", () => {
  test("KgStore satisfies IKgStore at the type level", () => {
    const db = initDatabase(":memory:");
    const store = new KgStore(db);

    // Type-level check: this assignment must compile without error.
    const _: IKgStore = store;

    expect(store).toBeDefined();

    db.close();
  });

  test("KgQuery satisfies IKgQuery at the type level", () => {
    const db = initDatabase(":memory:");
    const query = new KgQuery(db);

    // Type-level check: this assignment must compile without error.
    const _: IKgQuery = query;

    expect(query).toBeDefined();

    db.close();
  });
});
