/**
 * Tests for evictDriftDbForScope — the close-on-connection-end eviction hook
 * added in 1d. Decision http-phase1-1d-01.
 *
 * The drift-db cache is keyed by resolve(projectDir). Eviction is an
 * exact-key close+delete for the given scope.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evictDriftDbForScope, getDriftDb } from "../drift-db-cache.ts";

let tempRoots: string[] = [];

function makeTempProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "drift-evict-test-"));
  // drift-db needs .canon/ to exist
  mkdirSync(join(dir, ".canon"), { recursive: true });
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const root of tempRoots) {
    try {
      // Close any open DB handles by evicting — ignore errors
      evictDriftDbForScope(root);
    } catch {
      // best-effort
    }
    try {
      rmSync(root, { force: true, recursive: true });
    } catch {
      // best-effort
    }
  }
  tempRoots = [];
});

describe("evictDriftDbForScope", () => {
  it("closes and removes the exact-key entry for the given projectDir", () => {
    const projectDir = makeTempProjectDir();

    // Warm the cache
    getDriftDb(projectDir);

    // Should not throw
    expect(() => evictDriftDbForScope(projectDir)).not.toThrow();

    // After eviction, getDriftDb should return a fresh instance (cache miss)
    const fresh = getDriftDb(projectDir);
    expect(fresh).toBeTruthy();
  });

  it("is a no-op for an unknown scope (never warmed)", () => {
    const projectDir = makeTempProjectDir();
    // Never called getDriftDb — evicting unknown scope must not throw
    expect(() => evictDriftDbForScope(projectDir)).not.toThrow();
  });

  it("does not affect cached entries for a different projectDir", () => {
    const dirA = makeTempProjectDir();
    const dirB = makeTempProjectDir();

    const dbA = getDriftDb(dirA);
    const dbB = getDriftDb(dirB);

    evictDriftDbForScope(dirA);

    // dirB's entry should still be cached (same instance)
    const freshB = getDriftDb(dirB);
    expect(freshB).toBe(dbB);

    // Cleanup dirA's db manually (was evicted, need fresh for cleanup)
    const freshA = getDriftDb(dirA);
    expect(freshA).not.toBe(dbA);
  });

  it("after eviction, getDriftDb returns a new instance", () => {
    const projectDir = makeTempProjectDir();

    const original = getDriftDb(projectDir);
    evictDriftDbForScope(projectDir);
    const fresh = getDriftDb(projectDir);

    expect(fresh).not.toBe(original);
  });
});
