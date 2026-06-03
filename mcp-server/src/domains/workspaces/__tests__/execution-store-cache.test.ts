/**
 * Tests for evictStoresForScope — the close-on-connection-end eviction hook
 * added in 1d. Decision http-phase1-1d-01.
 *
 * The execution-store cache is keyed by absolute workspace path, which is
 * always under {projectDir}/.canon/workspaces/.... So evictStoresForScope
 * must do a prefix match on resolve(projectDir), NOT an exact-key match.
 *
 * These tests use real temp directories and the actual cache so they exercise
 * the real Map keying semantics (resolve(), path normalization).
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearStoreCache,
  evictStoresForScope,
  getExecutionStore,
} from "../execution-store-cache.ts";

// Build a real workspace path that getExecutionStore accepts
// (must contain ".canon/workspaces/" segment).
function makeTempWorkspace(projectDir: string, slug: string): string {
  const ws = join(projectDir, ".canon", "workspaces", slug);
  mkdirSync(ws, { recursive: true });
  return ws;
}

let tempRoots: string[] = [];

function makeTempProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "evict-test-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  // Clear cache to release SQLite handles before deleting temp dirs
  clearStoreCache();
  for (const root of tempRoots) {
    try {
      rmSync(root, { force: true, recursive: true });
    } catch {
      // best-effort
    }
  }
  tempRoots = [];
});

describe("evictStoresForScope", () => {
  it("closes and removes all entries under the given projectDir prefix", () => {
    const projectDir = makeTempProjectDir();
    const ws1 = makeTempWorkspace(projectDir, "slug-alpha");
    const ws2 = makeTempWorkspace(projectDir, "slug-beta");

    // Warm the cache
    getExecutionStore(ws1);
    getExecutionStore(ws2);

    evictStoresForScope(projectDir);

    // After eviction, getExecutionStore must create a fresh instance
    // (not return the same cached object). We verify by checking a property
    // on the fresh instance — it should not have thrown.
    const fresh = getExecutionStore(ws1);
    expect(fresh).toBeTruthy();
  });

  it("is a no-op when the scope has no cached entries", () => {
    const projectDir = makeTempProjectDir();
    // Don't warm the cache — evicting an unknown scope should not throw
    expect(() => evictStoresForScope(projectDir)).not.toThrow();
  });

  it("does not evict entries for a sibling projectDir", () => {
    const dirA = makeTempProjectDir();
    const dirB = makeTempProjectDir();

    const wsA = makeTempWorkspace(dirA, "slug-a");
    const wsB = makeTempWorkspace(dirB, "slug-b");

    const storeA = getExecutionStore(wsA);
    const storeB = getExecutionStore(wsB);

    // Evict only dirA
    evictStoresForScope(dirA);

    // storeB should still be alive (no close) — verify by getting it again
    // and confirming it's the SAME cached instance (not a new one).
    // If eviction closed storeB, the underlying db would be closed and
    // getExecutionStore would throw or return a broken store.
    const freshB = getExecutionStore(wsB);
    // same object because dirB was NOT evicted
    expect(freshB).toBe(storeB);
  });

  it("after eviction, getExecutionStore returns a fresh instance (not the closed one)", () => {
    const projectDir = makeTempProjectDir();
    const ws = makeTempWorkspace(projectDir, "slug-fresh");

    const original = getExecutionStore(ws);
    evictStoresForScope(projectDir);

    const fresh = getExecutionStore(ws);
    // After eviction a new instance is created
    expect(fresh).not.toBe(original);
  });
});
