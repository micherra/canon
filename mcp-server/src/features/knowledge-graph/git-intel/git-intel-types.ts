/**
 * Git Intelligence Type Definitions
 *
 * Pure type declarations for hotspot scoring and co-change detection.
 * No runtime code — all exports are TypeScript types.
 */

export type GitCommitRecord = {
  sha: string;
  timestamp: number; // unix epoch seconds
  files: string[];
};

export type ChurnEntry = {
  filePath: string;
  rawChurn: number; // sum of decay-weighted commit contributions
  commitCount: number;
};

export type CoChangePair = {
  fileA: string;
  fileB: string;
  coCommitCount: number;
  jaccard: number;
};

export type HotspotRow = {
  file_path: string;
  churn_raw: number;
  churn_percentile: number;
  complexity_raw: number;
  complexity_pctile: number;
  score: number;
  is_hotspot: number; // 0 or 1
  computed_at_commit: string;
  computed_at: string;
};

export type CoChangeRow = {
  file_a: string;
  file_b: string;
  co_commit_count: number;
  jaccard: number;
  computed_at_commit: string;
  computed_at: string;
};

/** Hotspot score returned by get_file_context. */
export type HotspotScoreOutput = {
  score: number;
  is_hotspot: boolean;
  churn_percentile: number;
  complexity_percentile: number;
};

/** Co-change partner returned by get_file_context. */
export type CoChangePartner = {
  path: string;
  jaccard: number;
};
