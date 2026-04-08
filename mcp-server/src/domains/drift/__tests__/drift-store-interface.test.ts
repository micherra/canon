/**
 * Structural typing test — verifies that DriftStore satisfies IDriftStore.
 *
 * This is a compile-time check: if DriftStore does not implement IDriftStore,
 * TypeScript will report a type error on the assignment below.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { DriftStore } from "@platform/storage/drift/store.ts";
import type { IDriftStore } from "../drift-store.interface.ts";

describe("IDriftStore structural compatibility", () => {
  test("DriftStore satisfies IDriftStore at the type level", () => {
    const dir = mkdtempSync(`${tmpdir()}/drift-test-`);
    try {
      const store = new DriftStore(dir);

      // Type-level check: this assignment must compile without error.
      // If DriftStore is missing any IDriftStore method, tsc will fail here.
      const _: IDriftStore = store;

      expect(store).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
