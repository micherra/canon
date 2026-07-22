/**
 * aggregate-clean-checkout.test.ts — coverage for AC-7: aggregate.ts must be
 * runnable (or fail ACTIONABLY) on a clean checkout where `better-sqlite3`
 * hasn't been installed yet. `loadDriftDbOrExplain` factors the "load or
 * explain" decision into a pure, testable seam — no subprocess spawning.
 */

import { describe, expect, it } from "vitest";
import { loadDriftDbOrExplain } from "../aggregate.ts";

describe("loadDriftDbOrExplain — AC-7", () => {
  it("returns an actionable npm-install message (not a raw stack trace) when the drift-db module fails to load", async () => {
    const brokenImporter = () => Promise.reject(new Error("Cannot find module 'better-sqlite3'"));

    const result = await loadDriftDbOrExplain(brokenImporter);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("npm install");
      expect(result.message).toContain("cannot load drift DB");
    }
  });

  it("returns the loaded getDriftDb function when the import succeeds", async () => {
    const stubGetDriftDb = () => {
      throw new Error("not called in this test");
    };
    const workingImporter = () => Promise.resolve({ getDriftDb: stubGetDriftDb });

    const result = await loadDriftDbOrExplain(workingImporter);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.getDriftDb).toBe(stubGetDriftDb);
    }
  });
});
