/**
 * Structural typing test — verifies that ExecutionStore satisfies IExecutionStore.
 *
 * This is a compile-time check: if ExecutionStore does not implement IExecutionStore,
 * TypeScript will report a type error on the assignment below.
 */

import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { initExecutionDb } from "../execution-schema.ts";
import { ExecutionStore } from "../execution-store.ts";
import type { IExecutionStore } from "../execution-store.interface.ts";

describe("IExecutionStore structural compatibility", () => {
  test("ExecutionStore satisfies IExecutionStore at the type level", () => {
    const db: Database.Database = initExecutionDb(":memory:");
    const store = new ExecutionStore(db);

    // Type-level check: this assignment must compile without error.
    // If ExecutionStore is missing any IExecutionStore method, tsc will fail here.
    const _: IExecutionStore = store;

    // Runtime sanity: instance was created successfully
    expect(store).toBeDefined();

    db.close();
  });
});
