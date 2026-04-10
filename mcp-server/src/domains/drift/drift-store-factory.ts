/**
 * Drift store factory — provides backward-compatible default IDriftStore instances.
 *
 * This module isolates the concrete DriftStore construction to the domains/drift/
 * layer. Cross-context callers (features/orchestration/) import createDriftStore
 * from here rather than importing DriftStore directly from @platform/storage/drift/.
 *
 * Wiring layer: acceptable to import from @platform/storage/drift/ — this module
 * is the designated anti-corruption layer for default store construction.
 */

import { DriftStore } from "@platform/storage/drift/store.ts";
import type { IDriftStore } from "./drift-store.interface.ts";

/**
 * Create a concrete IDriftStore backed by the SQLite DriftStore.
 * Callers that do not inject a store use this factory for the backward-compatible default.
 */
export function createDriftStore(projectDir: string): IDriftStore {
  return new DriftStore(projectDir);
}
