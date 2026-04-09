/**
 * Hotspot Scorer
 *
 * Computes recency-weighted churn and composite hotspot scores per file.
 * All computation functions are pure; only persist/query functions touch the DB.
 */

import type Database from "better-sqlite3";
import type { GitIntelConfig } from "./git-intel-config.ts";
import type { ChurnEntry, GitCommitRecord, HotspotRow } from "./git-intel-types.ts";

/**
 * Compute recency-weighted churn per file from commit records.
 * Each commit contributes an exponentially decayed weight based on its age:
 *   weight = Math.exp(-(Math.LN2 / halfLifeDays) * ageDays)
 * Results are sorted descending by rawChurn.
 */
export const computeChurn = (
  commits: GitCommitRecord[],
  config: Pick<GitIntelConfig, "halfLifeDays">,
  nowEpochSec: number,
): ChurnEntry[] => {
  const churnMap = new Map<string, { rawChurn: number; commitCount: number }>();
  const decayRate = Math.LN2 / config.halfLifeDays;

  for (const commit of commits) {
    const ageDays = (nowEpochSec - commit.timestamp) / 86400;
    const weight = Math.exp(-decayRate * ageDays);

    for (const filePath of commit.files) {
      const existing = churnMap.get(filePath);
      if (existing) {
        existing.rawChurn += weight;
        existing.commitCount += 1;
      } else {
        churnMap.set(filePath, { commitCount: 1, rawChurn: weight });
      }
    }
  }

  const entries: ChurnEntry[] = [];
  for (const [filePath, { rawChurn, commitCount }] of churnMap) {
    entries.push({ commitCount, filePath, rawChurn });
  }

  entries.sort((a, b) => b.rawChurn - a.rawChurn);
  return entries;
};

/**
 * Compute inclusive percentile rank for each value in an array.
 * Formula: rank = count(values <= x) / total_count
 *
 * When all values are identical, all get percentile 1.0 (N/N = 1.0).
 * Preserves input order — output[i] is the rank for input[i].
 */
export const computePercentiles = (values: number[]): number[] => {
  const n = values.length;
  if (n === 0) return [];

  // Sort a copy to enable binary search for the upper bound (count of values <= x)
  const sorted = [...values].sort((a, b) => a - b);

  return values.map((x) => {
    // Binary search: find rightmost index where sorted[idx] <= x
    // That gives count(values <= x)
    let lo = 0;
    let hi = n - 1;
    let upperBound = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid] <= x) {
        upperBound = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    // upperBound is the last index where sorted[idx] <= x
    // count = upperBound + 1; rank = count / n
    return (upperBound + 1) / n;
  });
};

/**
 * Build hotspot rows from churn entries and complexity map.
 * 1. Computes churn percentiles across all files.
 * 2. Computes complexity percentiles across all files.
 * 3. score = churn_percentile * complexity_percentile
 * 4. is_hotspot = score >= config.hotspotScoreThreshold
 */
export const buildHotspotRows = (
  churnEntries: ChurnEntry[],
  complexityByFile: Map<string, number>,
  config: Pick<GitIntelConfig, "hotspotScoreThreshold">,
  commitSha: string,
): HotspotRow[] => {
  if (churnEntries.length === 0) return [];

  const now = new Date().toISOString();

  // Extract ordered churn and complexity values
  const churnValues = churnEntries.map((e) => e.rawChurn);
  const complexityValues = churnEntries.map((e) => complexityByFile.get(e.filePath) ?? 0);

  // Compute percentiles for each dimension
  const churnPercentiles = computePercentiles(churnValues);
  const complexityPercentiles = computePercentiles(complexityValues);

  return churnEntries.map((entry, i) => {
    const churnPctile = churnPercentiles[i];
    const complexityPctile = complexityPercentiles[i];
    const score = churnPctile * complexityPctile;

    return {
      churn_percentile: churnPctile,
      churn_raw: entry.rawChurn,
      complexity_pctile: complexityPctile,
      complexity_raw: complexityValues[i],
      computed_at: now,
      computed_at_commit: commitSha,
      file_path: entry.filePath,
      is_hotspot: score >= config.hotspotScoreThreshold ? 1 : 0,
      score,
    };
  });
};

/**
 * Persist hotspot rows to DB, replacing all existing data.
 * Executes bare DELETE + INSERT — caller must wrap in a transaction.
 */
export const persistHotspots = (db: Database.Database, rows: HotspotRow[]): void => {
  db.prepare("DELETE FROM hotspot_scores").run();

  const insert = db.prepare(`
    INSERT INTO hotspot_scores
      (file_path, churn_raw, churn_percentile, complexity_raw, complexity_pctile,
       score, is_hotspot, computed_at_commit, computed_at)
    VALUES
      (@file_path, @churn_raw, @churn_percentile, @complexity_raw, @complexity_pctile,
       @score, @is_hotspot, @computed_at_commit, @computed_at)
  `);

  for (const row of rows) {
    insert.run(row);
  }
};

/**
 * Read the entity count per file from the KG entities table.
 * Files with no entities get count 0 (LEFT JOIN).
 */
export const getComplexityMap = (db: Database.Database): Map<string, number> => {
  const rows = db
    .prepare(
      `SELECT f.path, COUNT(e.entity_id) as entity_count
       FROM files f
       LEFT JOIN entities e ON e.file_id = f.file_id
       GROUP BY f.file_id`,
    )
    .all() as Array<{ path: string; entity_count: number }>;

  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.path, row.entity_count);
  }
  return map;
};
