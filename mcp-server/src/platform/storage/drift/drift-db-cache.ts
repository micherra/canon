/**
 * drift-db-cache — project-scoped factory and lifecycle for DriftDb.
 *
 * Extracted from drift-db.ts to keep that file under the 600-line limit.
 *
 * `getDriftDb` is the primary entry point: returns a cached DriftDb for a
 * given project directory, opening `.canon/drift.db` on first access.
 *
 * `evictDriftDbForScope` is the close-on-connection-end hook (Phase 2 wiring).
 * Under stdio the single connection never ends before process exit, so this is
 * never called — a behavioral no-op.
 *
 * // Phase 2: call evictStoresForScope/evictDriftDbForScope from the
 * // connection-end handler (next to clearConnectionScope in server-state.ts)
 */

import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { CANON_DIR } from "@shared/constants.ts";
import { DriftDb } from "./drift-db.ts";
import { initDriftDb } from "./drift-schema.ts";

const cache = new Map<string, DriftDb>();

/**
 * Return a cached DriftDb for the given projectDir, opening `.canon/drift.db`
 * on first access. Thread-safe within a single Node.js process since
 * better-sqlite3 is synchronous.
 */
export function getDriftDb(projectDir: string): DriftDb {
  const key = resolve(projectDir);
  const existing = cache.get(key);
  if (existing !== undefined) return existing;

  const canonDir = join(key, CANON_DIR);
  mkdirSync(canonDir, { recursive: true });

  const dbPath = join(canonDir, "drift.db");
  const db = initDriftDb(dbPath);
  const store = new DriftDb(db);
  cache.set(key, store);
  return store;
}

/**
 * Close and evict the DriftDb instance for the given projectDir.
 *
 * The drift-db cache is keyed directly by resolve(projectDir), so this is an
 * exact-key close+delete. No-op when the scope is not in the cache.
 *
 * Called from the connection-end handler (Phase 2). Under stdio the single
 * connection never ends before process exit, so this is never called — a true
 * behavioral no-op.
 */
export function evictDriftDbForScope(projectDir: string): void {
  const key = resolve(projectDir);
  const db = cache.get(key);
  if (db === undefined) return; // no-op for unknown scope
  try {
    db.close();
  } catch {
    /* ignore close errors */
  }
  cache.delete(key);
}
