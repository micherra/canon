/**
 * Factory and per-workspace cache for ExecutionStore.
 *
 * Split from execution-store.ts to keep that file under the 600-line limit.
 */

import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { CANON_FILES } from "@shared/constants.ts";
import { initExecutionDb } from "./execution-schema.ts";
import { ExecutionStore } from "./execution-store.ts";

/** Cache keyed by absolute workspace path. */
const storeCache = new Map<string, ExecutionStore>();

/**
 * Guards that a workspace path follows the canonical `.canon/workspaces/` convention.
 * Throws when the path does not contain the expected segment, preventing accidental
 * misuse (e.g. passing a project root instead of a workspace subdirectory).
 *
 * Skipped when `CANON_SKIP_WORKSPACE_VALIDATION=true` or when running under Vitest
 * (`VITEST` env var set). Tests that operate on temp dirs typically do not include
 * the `.canon/workspaces/` segment in their paths.
 */
export function assertWorkspacePath(workspace: string): void {
  if (process.env.CANON_SKIP_WORKSPACE_VALIDATION !== "true" && !process.env.VITEST) {
    // Use the raw string for the segment check so Windows-style paths work
    // cross-platform (resolve() would rewrite them on macOS).
    const hasValidSegment =
      workspace.includes(".canon/workspaces/") || workspace.includes(".canon\\workspaces\\");
    if (!hasValidSegment) {
      throw new Error(
        `Invalid workspace path: "${workspace}". Expected a path containing ".canon/workspaces/".`,
      );
    }
  }
}

export function getExecutionStore(workspace: string): ExecutionStore {
  assertWorkspacePath(workspace);

  const key = resolve(workspace);
  const existing = storeCache.get(key);
  if (existing) return existing;

  if (!existsSync(key)) {
    throw new Error(`Workspace directory does not exist: ${key}`);
  }

  const dbPath = join(key, CANON_FILES.ORCHESTRATION_DB);
  const db = initExecutionDb(dbPath);
  const store = new ExecutionStore(db);
  storeCache.set(key, store);
  return store;
}

/**
 * Close and evict all cached ExecutionStore instances.
 * Call this in test afterEach/afterAll to release SQLite file handles
 * before deleting temp workspace directories.
 */
export function clearStoreCache(): void {
  for (const store of storeCache.values()) {
    try {
      store.close();
    } catch {
      /* ignore close errors */
    }
  }
  storeCache.clear();
}

/**
 * Close and evict all cached ExecutionStore instances whose workspace path is
 * under the given projectDir (prefix match on resolve(projectDir)).
 *
 * Workspace keys are `{projectDir}/.canon/workspaces/...`, so a prefix match
 * on the resolved projectDir catches all workspaces for that project.
 *
 * Called from the connection-end handler (Phase 2). Under stdio the single
 * connection never ends before process exit, so this is never called — a true
 * behavioral no-op.
 *
 * // Phase 2: call evictStoresForScope/evictDriftDbForScope from the connection-end handler
 */
export function evictStoresForScope(projectDir: string): void {
  const prefix = resolve(projectDir);
  for (const [key, store] of storeCache) {
    if (key === prefix || key.startsWith(prefix + sep)) {
      try {
        store.close();
      } catch {
        /* ignore close errors */
      }
      storeCache.delete(key);
    }
  }
}
