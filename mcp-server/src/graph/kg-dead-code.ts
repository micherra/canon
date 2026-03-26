/**
 * Dead Code Detection Module
 *
 * Uses the knowledge graph to identify potentially dead (unreachable) code
 * within a codebase. Delegates raw detection to KgQuery, then enriches
 * results with confidence scoring, reason strings, and structured groupings.
 */

import type Database from 'better-sqlite3';
import { KgQuery } from './kg-query.ts';
import { KgStore } from './kg-store.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DeadCodeOptions {
  /** Include entities in test files (default: false) */
  includeTests?: boolean;
  /** Include private class members (default: false) */
  includePrivate?: boolean;
  /** Minimum confidence threshold to include an entry (default: 0.5) */
  minConfidence?: number;
}

export interface DeadCodeEntry {
  name: string;
  kind: string;
  line_start?: number;
  line_end?: number;
  /** Confidence that this entity is actually dead, in [0.0, 1.0] */
  confidence: number;
  /** Human-readable explanation of why this entity is considered dead */
  reason: string;
}

export interface DeadCodeReport {
  /** Total number of dead entities across all files */
  total_dead: number;
  /** Count of dead entities grouped by kind (e.g. { function: 5, class: 1 }) */
  by_kind: Record<string, number>;
  /** Dead entities grouped by file path, sorted descending by entity count */
  by_file: Array<{ path: string; entities: DeadCodeEntry[] }>;
}

// ---------------------------------------------------------------------------
// Entry-point file patterns
// ---------------------------------------------------------------------------

const ENTRY_POINT_PATTERNS = [/(?:^|\/)index\.[^/]+$/, /(?:^|\/)main\.[^/]+$/];

function isEntryPoint(path: string): boolean {
  return ENTRY_POINT_PATTERNS.some((re) => re.test(path));
}

// ---------------------------------------------------------------------------
// Confidence and reason assignment
// ---------------------------------------------------------------------------

/**
 * Classify detection reason and assign a confidence score.
 *
 * Rule 1 — unexported + unreferenced → 0.9
 * (KgQuery.findDeadCode only returns unexported entities with no incoming
 * dependency edges, so all results map to this rule by default.)
 */
function assignConfidenceAndReason(isExported: boolean): { confidence: number; reason: string } {
  if (!isExported) {
    return {
      confidence: 0.9,
      reason: 'unexported and unreferenced',
    };
  }
  // Exported but surfaced by findDeadCode (should not normally happen given the
  // current SQL, but handle defensively).
  return {
    confidence: 0.7,
    reason: 'exported but no importers detected',
  };
}

// ---------------------------------------------------------------------------
// detectDeadCode
// ---------------------------------------------------------------------------

/**
 * Detect potentially dead code in the knowledge graph database.
 *
 * Returns a structured report with total counts, per-kind breakdowns,
 * and per-file groupings — each entry annotated with a confidence score
 * and a human-readable reason.
 *
 * @param db   - A better-sqlite3 Database instance wrapping an initialised KG.
 * @param options - Optional filtering/inclusion settings.
 */
export function detectDeadCode(db: Database.Database, options: DeadCodeOptions = {}): DeadCodeReport {
  const { includeTests = false, minConfidence = 0.5 } = options;

  const query = new KgQuery(db);
  const store = new KgStore(db);

  // Fetch base dead-code candidates from KgQuery
  const raw = query.findDeadCode({ includeTests });

  // Build a file-path lookup to enrich each result
  const filePathCache = new Map<number, string>();

  function getFilePath(fileId: number): string {
    const cached = filePathCache.get(fileId);
    if (cached !== undefined) return cached;
    const file = store.getFileById(fileId);
    const path = file?.path ?? '<unknown>';
    filePathCache.set(fileId, path);
    return path;
  }

  // Group by file, applying confidence threshold and entry-point exclusions
  const byFile = new Map<string, DeadCodeEntry[]>();
  const byKind: Record<string, number> = {};

  for (const result of raw) {
    const path = getFilePath(result.file_id);

    // Skip entry-point files — they are "used" by definition
    if (isEntryPoint(path)) continue;

    const { confidence, reason } = assignConfidenceAndReason(false /* all are unexported */);

    if (confidence < minConfidence) continue;

    const entry: DeadCodeEntry = {
      name: result.name,
      kind: result.kind,
      confidence,
      reason,
    };

    // Accumulate kind counts
    byKind[result.kind] = (byKind[result.kind] ?? 0) + 1;

    // Accumulate per-file entries
    let entries = byFile.get(path);
    if (!entries) {
      entries = [];
      byFile.set(path, entries);
    }
    entries.push(entry);
  }

  // Sort by most dead entities per file (descending)
  const byFileArray = Array.from(byFile.entries())
    .map(([path, entities]) => ({ path, entities }))
    .sort((a, b) => b.entities.length - a.entities.length);

  const totalDead = byFileArray.reduce((sum, { entities }) => sum + entities.length, 0);

  return {
    total_dead: totalDead,
    by_kind: byKind,
    by_file: byFileArray,
  };
}
