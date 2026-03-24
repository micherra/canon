/**
 * Knowledge Graph Blast Radius Analysis
 *
 * Computes the impact blast radius of changes to entities or files.
 * Given a set of target entity names or file paths, resolves them to entity IDs,
 * then performs a recursive CTE traversal to find all transitively affected entities.
 */

import type Database from 'better-sqlite3';
import { KgQuery } from './kg-query.js';
import { KgStore } from './kg-store.js';
import type { BlastRadiusResult } from './kg-types.js';

// ---------------------------------------------------------------------------
// Exported Interfaces
// ---------------------------------------------------------------------------

export interface BlastRadiusOptions {
  /** Maximum traversal depth. Default: 3 */
  maxDepth?: number;
  /** Include test file impacts. Default: true */
  includeTests?: boolean;
}

export interface BlastRadiusEntry {
  entity_name: string;
  entity_kind: string;
  file_path: string;
  depth: number;
  /** How this entity connects back to the seed — the edge_type from the traversal */
  edge_type: string;
}

export interface BlastRadiusReport {
  /** Resolved target names used as seed entities */
  seed_entities: string[];
  /** Total number of unique affected entities */
  total_affected: number;
  /** Number of unique affected files */
  affected_files: number;
  /** Depth -> count of entities at that depth */
  by_depth: Record<number, number>;
  /** Full list of affected entries (filtered per options) */
  affected: BlastRadiusEntry[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Detect whether a target string looks like a file path (contains a path
 * separator or file extension) vs. a plain entity name.
 */
function looksLikeFilePath(target: string): boolean {
  return target.includes('/') || target.includes('\\') || /\.\w{1,6}$/.test(target);
}

/**
 * Resolve a set of target strings (entity names or file paths) to a list of
 * { entityId, name } pairs that will be used as blast-radius seeds.
 *
 * Resolution strategy:
 *   1. If the target looks like a file path — find the file row via KgStore and
 *      return all entities belonging to that file.
 *   2. Otherwise — run an FTS5 search for the name and take all matching entity IDs.
 */
function resolveTargets(
  targets: string[],
  store: KgStore,
  query: KgQuery,
): Array<{ id: number; name: string }> {
  const seen = new Set<number>();
  const resolved: Array<{ id: number; name: string }> = [];

  for (const target of targets) {
    if (looksLikeFilePath(target)) {
      // File path resolution
      const file = store.getFile(target);
      if (!file || file.file_id == null) continue;

      const entities = store.getEntitiesByFile(file.file_id);
      for (const ent of entities) {
        if (ent.entity_id == null || seen.has(ent.entity_id)) continue;
        seen.add(ent.entity_id);
        resolved.push({ id: ent.entity_id, name: ent.name });
      }
    } else {
      // FTS5 name search
      const results = query.search(target, 50);
      for (const r of results) {
        if (seen.has(r.entity_id)) continue;
        seen.add(r.entity_id);
        resolved.push({ id: r.entity_id, name: r.name });
      }
    }
  }

  return resolved;
}

/**
 * Fetch the file path for a given file_id.
 * Returns an empty string when the file cannot be found.
 */
function getFilePath(store: KgStore, fileId: number): string {
  const file = store.getFileById(fileId);
  return file?.path ?? '';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Analyze the blast radius of changes to the given targets.
 *
 * @param db      - A better-sqlite3 Database instance (read-only access is fine)
 * @param targets - Entity names or file paths to use as seed points
 * @param options - Optional depth and test-file inclusion controls
 * @returns       A BlastRadiusReport summarising all transitively affected entities
 */
export function analyzeBlastRadius(
  db: Database.Database,
  targets: string[],
  options?: BlastRadiusOptions,
): BlastRadiusReport {
  const maxDepth = options?.maxDepth ?? 3;
  const includeTests = options?.includeTests ?? true;

  const store = new KgStore(db);
  const query = new KgQuery(db);

  // Step 1: Resolve target strings to seed entity IDs
  const seeds = resolveTargets(targets, store, query);
  const seedIds = seeds.map((s) => s.id);
  const seedNames = seeds.map((s) => s.name);

  // Step 2: Run recursive CTE blast-radius traversal
  const rawResults: BlastRadiusResult[] = query.getBlastRadius(seedIds, maxDepth);

  // Step 3: Join with file paths and optionally filter test files
  const entries: BlastRadiusEntry[] = [];
  const seenFileIds = new Set<number>();

  for (const row of rawResults) {
    const filePath = getFilePath(store, row.file_id);

    // Optionally exclude test files
    if (!includeTests && (filePath.includes('test') || filePath.includes('spec'))) {
      continue;
    }

    seenFileIds.add(row.file_id);

    // BlastRadiusResult does not include an edge_type from the traversal
    // (the CTE follows all edge types). We label the edge_type based on depth:
    // depth 0 = seed (the entity itself), depth > 0 = "dependency".
    const edgeType = row.depth === 0 ? 'seed' : 'dependency';

    entries.push({
      entity_name: row.name,
      entity_kind: row.kind,
      file_path: filePath,
      depth: row.depth,
      edge_type: edgeType,
    });
  }

  // Step 4: Build depth summary
  const byDepth: Record<number, number> = {};
  for (const entry of entries) {
    byDepth[entry.depth] = (byDepth[entry.depth] ?? 0) + 1;
  }

  return {
    seed_entities: seedNames,
    total_affected: entries.length,
    affected_files: seenFileIds.size,
    by_depth: byDepth,
    affected: entries,
  };
}
