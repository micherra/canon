/**
 * IKgStore and IKgQuery — capability interfaces for the knowledge graph store.
 *
 * Cross-context callers depend on these interfaces rather than the concrete
 * KgStore / KgQuery classes. This hides the SQLite DAO details behind a
 * capability contract.
 */

import type { FileMetrics, FileRow, LayerViolation, SummaryRow } from "@graph/kg-types.ts";

/**
 * Subset of KgStore methods needed by cross-context callers (e.g. inject-context).
 */
export type IKgStore = {
  getFile(path: string): FileRow | undefined;
  getSummaryByFile(fileId: number): SummaryRow | undefined;
};

/**
 * Subset of KgQuery methods needed by cross-context callers (e.g. inject-context).
 */
export type IKgQuery = {
  getFileMetrics(
    filePath: string,
    options?: {
      changedFiles?: Set<string>;
      hubPaths?: Set<string>;
      cycleMemberPaths?: Map<string, string[]>;
      layerViolationsByPath?: Map<string, LayerViolation[]>;
    },
  ): FileMetrics | null;
  getKgFreshnessMs(): number | null;
  /** Return all files with their aggregate entity and export counts. */
  getAllFilesWithStats(): Array<FileRow & { entity_count: number; export_count: number }>;
  /** Return a Map from file_id to { in_degree, out_degree } for all files in file_edges. */
  getAllFileDegrees(): Map<number, { in_degree: number; out_degree: number }>;
};
