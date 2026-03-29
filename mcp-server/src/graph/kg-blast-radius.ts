/**
 * Knowledge Graph Blast Radius Analysis
 *
 * Computes the impact blast radius of changes to entities or files.
 * Given a set of target entity names or file paths, resolves them to entity IDs,
 * then performs a recursive CTE traversal to find all transitively affected entities.
 */

import type Database from 'better-sqlite3';
import { KgQuery } from './kg-query.ts';
import { KgStore } from './kg-store.ts';
import type { BlastRadiusResult } from './kg-types.ts';

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
// Unified Blast Radius Types (new design — see br-03 for wiring)
// ---------------------------------------------------------------------------

export interface BlastRadiusFile {
  path: string;
  depth: number;
  /** edge_type from file_edges or entity edges */
  relationship: string;
  layer: string;
  is_test: boolean;
  in_degree: number;
  affected_entities?: string[];
}

export type BlastSeverity = 'contained' | 'low' | 'moderate' | 'high' | 'critical';

export interface BlastRadiusSummary {
  severity: BlastSeverity;
  total_files: number;
  total_production_files: number;
  cross_layer_count: number;
  max_depth_reached: number;
  amplification_risk: boolean;
  description: string;
}

export interface UnifiedBlastRadiusReport {
  seed_file: string;
  seed_layer: string;
  summary: BlastRadiusSummary;
  by_depth: Record<number, BlastRadiusFile[]>;
  affected: BlastRadiusFile[];
}

// ---------------------------------------------------------------------------
// Pure functions for unified blast radius analysis
// ---------------------------------------------------------------------------

/**
 * Detect whether a file path belongs to a test file.
 * Matches __tests__/, test/, tests/ directories and .test.* / .spec.* extensions.
 */
function isTestFile(path: string): boolean {
  return /(?:^|\/)__tests__\/|(?:^|\/)test\/|(?:^|\/)tests\/|(?:^|\/)[^.]+\.(?:test|spec)\.[^.]+$/i.test(
    path,
  );
}

/**
 * Classify the blast radius severity of a change and produce a human-readable summary.
 *
 * Severity rules (evaluated on production files only):
 *   contained — 0 production files affected
 *   low       — 1–3 prod files, all same layer as seed, no file with in_degree > 5
 *   moderate  — 4–8 prod files, OR any cross-layer dependency
 *   high      — 9+ prod files, OR any affected file with in_degree > 10
 *   critical  — any file with in_degree > 10 AND cross-layer (hub amplification)
 *
 * Test files are excluded from severity computation but counted in total_files.
 */
export function classifyBlastSeverity(
  affected: BlastRadiusFile[],
  seedLayer: string,
): BlastRadiusSummary {
  const total_files = affected.length;
  const prodFiles = affected.filter((f) => !f.is_test);
  const total_production_files = prodFiles.length;

  const crossLayerFiles = prodFiles.filter((f) => f.layer !== seedLayer);
  const cross_layer_count = crossLayerFiles.length;

  const maxDepthReached =
    affected.length > 0 ? Math.max(...affected.map((f) => f.depth)) : 0;
  const max_depth_reached = maxDepthReached;

  const hubFiles = prodFiles.filter((f) => f.in_degree > 10);
  const amplification_risk = hubFiles.length > 0;

  let severity: BlastSeverity;
  let description: string;

  if (total_production_files === 0) {
    severity = 'contained';
    description = 'Changes are fully contained. No production files depend on this.';
  } else if (
    amplification_risk &&
    cross_layer_count > 0
  ) {
    // critical: hub file affected AND crosses layer boundaries
    severity = 'critical';
    const hubFile = hubFiles[0];
    const uniqueLayers = new Set(prodFiles.map((f) => f.layer));
    description = `Critical blast radius — hub file ${hubFile.path} in ${hubFile.layer} layer is affected, amplifying impact across ${uniqueLayers.size} layers.`;
  } else if (total_production_files >= 9 || amplification_risk) {
    // high: 9+ prod files OR any file with in_degree > 10
    severity = 'high';
    const hubFile = hubFiles[0];
    if (hubFile) {
      description = `High blast radius — ${total_production_files} files affected. ${hubFile.path} is a hub with ${hubFile.in_degree} dependents of its own.`;
    } else {
      description = `High blast radius — ${total_production_files} files affected.`;
    }
  } else if (total_production_files >= 4 || cross_layer_count > 0) {
    // moderate: 4–8 prod files OR any cross-layer dependency
    severity = 'moderate';
    description = `Moderate blast radius — ${total_production_files} files affected, ${cross_layer_count} across layer boundaries.`;
  } else {
    // low: 1–3 prod files, all same layer, no high in_degree
    const highDegreeFiles = prodFiles.filter((f) => f.in_degree > 5);
    if (highDegreeFiles.length > 0) {
      // If some have in_degree > 5 but count is still 1–3 and same layer, bump to moderate
      severity = 'moderate';
      description = `Moderate blast radius — ${total_production_files} files affected, ${cross_layer_count} across layer boundaries.`;
    } else {
      severity = 'low';
      description = `Low blast radius — ${total_production_files} direct dependents, all within the ${seedLayer} layer.`;
    }
  }

  return {
    severity,
    total_files,
    total_production_files,
    cross_layer_count,
    max_depth_reached,
    amplification_risk,
    description,
  };
}

// ---------------------------------------------------------------------------
// computeUnifiedBlastRadius — orchestration function (new unified API)
// ---------------------------------------------------------------------------

export interface UnifiedBlastRadiusOptions {
  /** Maximum traversal depth for both file-level and entity-level queries. Default: 2 */
  maxDepth?: number;
  /** Currently unused — test files are always included in `affected` but excluded from severity. Default: false */
  includeTests?: boolean;
}

/**
 * Compute the unified blast radius for a given file path.
 *
 * Combines file-level reverse dependencies (from `file_edges`) with
 * entity-level reverse dependencies (from `edges` for exported entities)
 * into a single `UnifiedBlastRadiusReport`.
 *
 * Algorithm:
 * 1. Look up `filePath` in the files table. If not found, return a `contained` report.
 * 2. Get file-level reverse dependencies via `getFileBlastRadius()`.
 * 3. Get the file's exported entities and their reverse dependencies via `getBlastRadius()`.
 * 4. Merge both result sets: file-level results form the base; entity-level results
 *    add `affected_entities` detail to existing entries, or create new entries for
 *    files not reachable via `file_edges`.
 * 5. Look up `in_degree` for each affected file from `file_edges`.
 * 6. Classify severity via `classifyBlastSeverity()`.
 * 7. Group results by depth.
 */
export function computeUnifiedBlastRadius(
  db: Database.Database,
  filePath: string,
  options?: UnifiedBlastRadiusOptions,
): UnifiedBlastRadiusReport {
  const maxDepth = options?.maxDepth ?? 2;

  const store = new KgStore(db);
  const query = new KgQuery(db);

  // Step 1: Resolve the seed file
  const seedFile = store.getFile(filePath);
  if (!seedFile || seedFile.file_id == null) {
    return buildContainedReport(filePath, '');
  }

  const seedFileId = seedFile.file_id;
  const seedLayer = seedFile.layer ?? '';

  // Step 2: File-level blast radius
  const fileResults = query.getFileBlastRadius(seedFileId, maxDepth);

  // Build a map from file_id → BlastRadiusFile for merging
  // We'll populate `in_degree` and `layer` after building the full file set.
  const fileMap = new Map<number, BlastRadiusFile>();

  for (const fr of fileResults) {
    fileMap.set(fr.file_id, {
      path: fr.path,
      depth: fr.depth,
      relationship: 'file-import',
      layer: fr.layer ?? '',
      is_test: isTestFile(fr.path),
      in_degree: 0, // populated below
      affected_entities: [],
    });
  }

  // Step 3: Entity-level blast radius (exported entities only)
  const exportedEntities = store.getEntitiesByFile(seedFileId).filter((e) => e.is_exported);
  const exportedEntityIds = exportedEntities
    .map((e) => e.entity_id)
    .filter((id): id is number => id != null);

  if (exportedEntityIds.length > 0) {
    const entityResults = query.getBlastRadius(exportedEntityIds, maxDepth);

    // Step 6 (merged): for each entity result, find or create the BlastRadiusFile entry
    for (const er of entityResults) {
      // Skip depth 0 (seed entities themselves — they're in the seed file, not affected files)
      if (er.depth === 0) continue;

      const existingEntry = fileMap.get(er.file_id);
      if (existingEntry) {
        // Add entity detail to existing file entry
        if (!existingEntry.affected_entities) existingEntry.affected_entities = [];
        existingEntry.affected_entities.push(er.name);
        // Use the shallower of the two depths (entity path may be shorter)
        if (er.depth < existingEntry.depth) {
          existingEntry.depth = er.depth;
        }
      } else {
        // New file reachable via entity edges but not file_edges
        const fileRow = store.getFileById(er.file_id);
        if (fileRow) {
          fileMap.set(er.file_id, {
            path: fileRow.path,
            depth: er.depth,
            relationship: 'entity-dependency',
            layer: fileRow.layer ?? '',
            is_test: isTestFile(fileRow.path),
            in_degree: 0, // populated below
            affected_entities: [er.name],
          });
        }
      }
    }
  }

  // Step 7: Populate in_degree for each affected file from file_edges
  for (const [affectedFileId, entry] of fileMap) {
    entry.in_degree = store.getFileEdgesTo(affectedFileId).length;
  }

  // Build the flat affected list
  const affected = Array.from(fileMap.values());

  // Step 8: Classify severity
  const summary = classifyBlastSeverity(affected, seedLayer);

  // Step 9: Group by depth
  const by_depth: Record<number, BlastRadiusFile[]> = {};
  for (const file of affected) {
    if (!by_depth[file.depth]) by_depth[file.depth] = [];
    by_depth[file.depth].push(file);
  }

  return {
    seed_file: filePath,
    seed_layer: seedLayer,
    summary,
    by_depth,
    affected,
  };
}

/** Build a contained (empty) UnifiedBlastRadiusReport for files not in the KG or with no dependents. */
function buildContainedReport(filePath: string, seedLayer: string): UnifiedBlastRadiusReport {
  return {
    seed_file: filePath,
    seed_layer: seedLayer,
    summary: classifyBlastSeverity([], seedLayer),
    by_depth: {},
    affected: [],
  };
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
 *
 * @deprecated Use the unified blast radius pipeline (to be wired in br-03) that returns
 *             UnifiedBlastRadiusReport with classifyBlastSeverity() severity classification.
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
