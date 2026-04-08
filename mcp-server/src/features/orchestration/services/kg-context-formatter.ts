/**
 * Shared KG file context formatter.
 *
 * Two callers — inject-context.ts and inject-wave-briefing.ts — independently
 * implemented KG file context formatting. This module is the single shared
 * implementation.
 *
 * Canon: deep-modules — one module hides KG formatting complexity behind a
 * clean two-function interface.
 * Canon: functions-do-one-thing — buildKgFileEntries builds entries from KG
 * data; formatKgFileContext renders them as markdown.
 * Canon: validate-at-trust-boundaries — returns raw (unescaped) text; callers
 * apply escapeDollarBrace() at their own trust boundary.
 * Canon: graceful-degradation — never throws; returns "(not indexed)" entries
 * for files missing from the KG.
 */

import type { IKgQuery, IKgStore } from "@domains/knowledge-graph/kg-store.interface.ts";
import { computeFileInsightMaps, KgQuery } from "@graph/kg-query.ts";
import { KgStore } from "@graph/kg-store.ts";

/**
 * Structured representation of a single file's KG context.
 * Exported for consumers that need to inspect or transform entries before formatting.
 *
 * When `indexed` is false the file was not found in the KG database;
 * layer, inDegree, outDegree, and isHub will have their zero/default values.
 */
export type KgFileEntry = {
  path: string;
  layer: string;
  inDegree: number;
  outDegree: number;
  isHub: boolean;
  summary: string | null;
  /** false when the file was not found in the KG DB */
  indexed: boolean;
};

type Database = Parameters<typeof computeFileInsightMaps>[0];

/**
 * Build KgFileEntry records for the given file paths using the provided KG database.
 *
 * Calls computeFileInsightMaps(db) once (not per-file) to avoid N+1 queries.
 * Files not found in the KG get placeholder entries with layer "unknown" and
 * zero degree values — never throws.
 *
 * @param filePaths - Ordered list of file paths to look up
 * @param db - Open KG SQLite database handle
 * @returns Structured entries in the same order as filePaths
 */
export function buildKgFileEntries(filePaths: string[], db: Database): KgFileEntry[] {
  const insightMaps = computeFileInsightMaps(db);
  const kgQuery: IKgQuery = new KgQuery(db);
  const kgStore: IKgStore = new KgStore(db);

  return filePaths.map((filePath) => {
    const metrics = kgQuery.getFileMetrics(filePath, {
      cycleMemberPaths: insightMaps.cycleMemberPaths,
      hubPaths: insightMaps.hubPaths,
      layerViolationsByPath: insightMaps.layerViolationsByPath,
    });

    if (metrics === null) {
      return {
        indexed: false,
        inDegree: 0,
        isHub: false,
        layer: "unknown",
        outDegree: 0,
        path: filePath,
        summary: null,
      };
    }

    let summary: string | null = null;
    const fileRow = kgStore.getFile(filePath);
    if (fileRow?.file_id !== undefined) {
      const summaryRow = kgStore.getSummaryByFile(fileRow.file_id);
      summary = summaryRow?.summary ?? null;
    }

    return {
      indexed: true,
      inDegree: metrics.in_degree,
      isHub: metrics.is_hub,
      layer: metrics.layer,
      outDegree: metrics.out_degree,
      path: filePath,
      summary,
    };
  });
}

/**
 * Format KgFileEntry records as a markdown file context section.
 *
 * Returns raw (unescaped) text — callers must apply escapeDollarBrace() at
 * their own trust boundary before inserting into prompts.
 *
 * @param entries - File entries to render; returns empty string when empty
 * @param heading - Section heading; defaults to "### File Context (N files)"
 * @returns Markdown string; empty string when entries is empty
 */
export function formatKgFileContext(entries: KgFileEntry[], heading?: string): string {
  if (entries.length === 0) return "";

  const resolvedHeading = heading ?? `### File Context (${entries.length} files)`;
  const lines: string[] = [resolvedHeading, ""];

  for (const entry of entries) {
    if (!entry.indexed) {
      // Unindexed file — no metrics available
      lines.push(`**${entry.path}** (not indexed)`);
    } else {
      const hubLabel = entry.isHub ? "yes" : "no";
      lines.push(
        `**${entry.path}** (layer: ${entry.layer}, in_degree: ${entry.inDegree}, out_degree: ${entry.outDegree}, hub: ${hubLabel})`,
      );
    }

    if (entry.summary) {
      lines.push(`Summary: ${entry.summary}`);
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}
