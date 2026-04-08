/**
 * Git Intelligence Pipeline
 *
 * Orchestrates a single git-log pass that produces both hotspot scores
 * and co-change edges. Consumers call `ensureGitIntelFresh` to lazily
 * trigger computation, or `computeGitIntel` for proactive pre-computation.
 *
 * Design: deep-modules — one public call does everything. Internal complexity
 * of git parsing, scoring, and persistence is fully hidden from callers.
 *
 * First-call latency is a known v1 tradeoff. Use `computeGitIntel` from the
 * KG indexer or build pipeline to pre-compute data and make the lazy path rare.
 */

import type Database from "better-sqlite3";
import { gitExec } from "@platform/adapters/git-adapter.ts";
import { parseGitLog } from "./git-log-parser.ts";
import {
  computeChurn,
  buildHotspotRows,
  persistHotspots,
  getComplexityMap,
} from "./hotspot-scorer.ts";
import { computeCoChangePairs, persistCoChangeEdges } from "./co-change-detector.ts";
import {
  DEFAULT_GIT_INTEL_CONFIG,
  isExcluded,
  type GitIntelConfig,
} from "./git-intel-config.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import type { GitCommitRecord } from "./git-intel-types.ts";

// ---------------------------------------------------------------------------
// getCurrentHead
// ---------------------------------------------------------------------------

/**
 * Get the current HEAD SHA.
 * Returns null if git command fails (e.g. not a git repo, git not installed).
 */
export const getCurrentHead = (cwd: string): string | null => {
  const result = gitExec(["rev-parse", "HEAD"], cwd);
  if (!result.ok) return null;
  return result.stdout.trim();
};

// ---------------------------------------------------------------------------
// isGitIntelStale
// ---------------------------------------------------------------------------

/**
 * Check if git intel data is stale by comparing stored SHA against HEAD.
 *
 * Returns true when:
 * - No hotspot_scores rows exist (data has never been computed), OR
 * - The stored computed_at_commit differs from the current HEAD SHA
 *
 * Both tables (hotspot_scores and co_change_edges) are keyed by the same SHA,
 * so checking either table is sufficient.
 */
export const isGitIntelStale = (db: Database.Database, cwd: string): boolean => {
  const headSha = getCurrentHead(cwd);
  if (headSha === null) {
    // Can't determine HEAD — treat as stale to trigger recomputation when git is available
    return true;
  }

  const row = db
    .prepare("SELECT computed_at_commit FROM hotspot_scores LIMIT 1")
    .get() as { computed_at_commit: string } | undefined;

  if (!row) {
    // No data exists yet
    return true;
  }

  return row.computed_at_commit !== headSha;
};

// ---------------------------------------------------------------------------
// runGitIntelPipeline
// ---------------------------------------------------------------------------

/**
 * Run the full git intelligence pipeline:
 * 1. Fetch HEAD SHA
 * 2. Run git log for the lookback window
 * 3. Parse commits
 * 4. Filter excluded files
 * 5. Compute hotspot scores and co-change pairs
 * 6. Persist both in a single atomic transaction
 *
 * If git is unavailable or not a repo, returns silently without throwing.
 * Empty repos produce empty tables (clearing any stale data).
 */
export const runGitIntelPipeline = (
  db: Database.Database,
  cwd: string,
  config: GitIntelConfig = DEFAULT_GIT_INTEL_CONFIG,
): void => {
  // Step 1: Get HEAD SHA
  const headSha = getCurrentHead(cwd);
  if (headSha === null) {
    // git not available or not a repo — silent return
    return;
  }

  // Step 2: Compute lookback date (ISO string for --after flag)
  const lookbackMs = config.lookbackDays * 86400 * 1000;
  const lookbackDate = new Date(Date.now() - lookbackMs);
  const isoDate = lookbackDate.toISOString().slice(0, 10); // YYYY-MM-DD

  // Step 3: Run git log
  const logResult = gitExec(
    ["log", "--format=COMMIT:%H %at", "--name-only", `--after=${isoDate}`],
    cwd,
  );
  if (!logResult.ok) {
    // git log failed — silent return
    return;
  }

  // Step 4: Parse git log output
  const allCommits = parseGitLog(logResult.stdout);

  // Step 5: Filter excluded files from each commit's file list
  const filteredCommits: GitCommitRecord[] = allCommits.map((commit) => ({
    ...commit,
    files: commit.files.filter((f) => !isExcluded(f, config.excludePatterns)),
  }));

  // Step 6a: Compute hotspot scores
  const nowEpochSec = Math.floor(Date.now() / 1000);
  const churnEntries = computeChurn(filteredCommits, config, nowEpochSec);
  const complexityMap = getComplexityMap(db);
  const hotspotRows = buildHotspotRows(churnEntries, complexityMap, config, headSha);

  // Step 6b: Compute co-change pairs
  const coChangePairs = computeCoChangePairs(filteredCommits, config);

  // Step 7: Persist both in a single atomic transaction — all or nothing
  const persistAll = db.transaction(() => {
    persistHotspots(db, hotspotRows);
    persistCoChangeEdges(db, coChangePairs, headSha);
  });
  persistAll();
};

// ---------------------------------------------------------------------------
// ensureGitIntelFresh
// ---------------------------------------------------------------------------

/**
 * Ensure git intel data is fresh. Recomputes if stale. No-op if current.
 *
 * Entry point for consumers that already hold a DB handle (e.g. get_file_context).
 * Merges caller-provided config with defaults.
 */
export const ensureGitIntelFresh = (
  db: Database.Database,
  cwd: string,
  config?: Partial<GitIntelConfig>,
): void => {
  const mergedConfig: GitIntelConfig = { ...DEFAULT_GIT_INTEL_CONFIG, ...config };

  if (isGitIntelStale(db, cwd)) {
    runGitIntelPipeline(db, cwd, mergedConfig);
  }
};

// ---------------------------------------------------------------------------
// computeGitIntel
// ---------------------------------------------------------------------------

/**
 * Standalone entry point for proactive git intel computation.
 *
 * Opens its own DB connection, runs the full pipeline via `ensureGitIntelFresh`,
 * and closes the connection. Designed for use by the KG indexer or build pipeline
 * to pre-compute git intelligence data before users request it, making the lazy
 * `ensureGitIntelFresh` path a rare fallback.
 *
 * First-call latency (when data is absent and must be computed synchronously)
 * is a known v1 tradeoff. Proactive calls via this function eliminate it.
 */
export const computeGitIntel = (
  dbPath: string,
  repoRoot: string,
  config?: Partial<GitIntelConfig>,
): void => {
  const db = initDatabase(dbPath);
  try {
    ensureGitIntelFresh(db, repoRoot, config);
  } finally {
    db.close();
  }
};
