/**
 * IKgStore and IKgQuery — capability interfaces for the knowledge graph store.
 *
 * Cross-context callers depend on these interfaces rather than the concrete
 * KgStore / KgQuery classes. This hides the SQLite DAO details behind a
 * capability contract.
 */

import type { FileInsightMaps } from "@graph/kg-query-insights.ts";
import type { FileMetrics, FileRow, SummaryRow } from "@graph/kg-types.ts";

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
  getFileMetrics(filePath: string, insightMaps: FileInsightMaps): FileMetrics | null;
  getKgFreshnessMs(): number | null;
};
