/**
 * Co-Change Detector
 *
 * Computes Jaccard-based co-change coefficients between file pairs
 * from git commit history.
 *
 * All computation functions are pure; only persist functions touch the DB.
 */

import type { GitCommitRecord, CoChangePair } from "./git-intel-types.ts";
import type { GitIntelConfig } from "./git-intel-config.ts";
import type Database from "better-sqlite3";

/** Maximum number of files in a single commit before we skip it.
 * Commits touching > MAX_COMMIT_FILES files are ignored to avoid O(n^2) explosion. */
const MAX_COMMIT_FILES = 50;

/**
 * Compute co-change pairs with Jaccard coefficient from commit records.
 *
 * Algorithm:
 * 1. Build commitSets: Map<filePath, Set<sha>> — which commits touch each file.
 * 2. Build pairCounts: Map<"fileA|fileB", number> — co-occurrence counts.
 *    For each commit with N files (N <= MAX_COMMIT_FILES), generate C(N,2) pairs.
 *    Pair key is normalized: paths sorted alphabetically so (a,b) == (b,a).
 * 3. For each pair, compute Jaccard = coCount / (|set_a| + |set_b| - coCount).
 * 4. Filter by jaccardThreshold.
 */
export const computeCoChangePairs = (
  commits: GitCommitRecord[],
  config: Pick<GitIntelConfig, "jaccardThreshold">,
): CoChangePair[] => {
  // Step 1: Build per-file commit sets
  const commitSets = new Map<string, Set<string>>();

  for (const commit of commits) {
    if (commit.files.length > MAX_COMMIT_FILES) {
      // Skip large commits to avoid O(n^2) pair explosion
      continue;
    }

    for (const filePath of commit.files) {
      let set = commitSets.get(filePath);
      if (!set) {
        set = new Set();
        commitSets.set(filePath, set);
      }
      set.add(commit.sha);
    }
  }

  // Step 2: Count co-occurrences per pair
  const pairCounts = new Map<string, number>();

  for (const commit of commits) {
    if (commit.files.length > MAX_COMMIT_FILES) continue;

    const files = commit.files;
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        // Normalize alphabetically so (a,b) == (b,a)
        const [fileA, fileB] = files[i] <= files[j]
          ? [files[i], files[j]]
          : [files[j], files[i]];
        const key = `${fileA}|${fileB}`;
        pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
      }
    }
  }

  // Step 3: Compute Jaccard and filter
  const results: CoChangePair[] = [];

  for (const [key, coCount] of pairCounts) {
    const separatorIdx = key.indexOf("|");
    const fileA = key.slice(0, separatorIdx);
    const fileB = key.slice(separatorIdx + 1);

    const sizeA = commitSets.get(fileA)?.size ?? 0;
    const sizeB = commitSets.get(fileB)?.size ?? 0;

    // Union size = |A| + |B| - |A ∩ B|
    // Division by zero impossible: coCount >= 1, so union >= 1
    const unionSize = sizeA + sizeB - coCount;
    const jaccard = coCount / unionSize;

    if (jaccard >= config.jaccardThreshold) {
      results.push({ fileA, fileB, coCommitCount: coCount, jaccard });
    }
  }

  return results;
};

/**
 * Persist co-change edges to DB, replacing all existing data.
 * Executes bare DELETE + INSERT — caller must wrap in a transaction.
 */
export const persistCoChangeEdges = (
  db: Database.Database,
  pairs: CoChangePair[],
  commitSha: string,
): void => {
  db.prepare("DELETE FROM co_change_edges").run();

  if (pairs.length === 0) return;

  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO co_change_edges
      (file_a, file_b, co_commit_count, jaccard, computed_at_commit, computed_at)
    VALUES
      (@file_a, @file_b, @co_commit_count, @jaccard, @computed_at_commit, @computed_at)
  `);

  for (const pair of pairs) {
    insert.run({
      file_a: pair.fileA,
      file_b: pair.fileB,
      co_commit_count: pair.coCommitCount,
      jaccard: pair.jaccard,
      computed_at_commit: commitSha,
      computed_at: now,
    });
  }
};
