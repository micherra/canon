/**
 * Lazy structural-KG freshness gate.
 *
 * Mirrors the `ensureGitIntelFresh` pattern: a single named call that consumers
 * make before reading the knowledge graph. It compares the commit the graph was
 * computed at (`meta.graph_head_commit`) against the current HEAD and, on a
 * mismatch, runs the incremental pipeline — which prunes deleted files and
 * re-stamps the marker.
 *
 * Design:
 * - deep-modules: one-arg facade over scan/diff/stamp/prune.
 * - no-hidden-side-effects: the read→refresh effect is named and visible at
 *   every call site; it only fires when the stored SHA differs from HEAD.
 * - errors-are-values / fail-open: returns void and NEVER throws. A git or
 *   pipeline failure logs a warning and degrades to serving the last-good
 *   graph, exactly like `ensureGitIntelFresh`.
 *
 * ## Known limitations
 *
 * **(a) First-read latency**: the first KG read after a new commit pays the full
 * incremental-pipeline cost (parse + resolve + community + tags + embed)
 * synchronously before returning. This cost is accepted to ensure callers always
 * see a consistent graph. Subsequent reads at the same HEAD are a cheap marker
 * compare (O(1) SQL lookup). The latency is bounded by the changed-file count,
 * not the whole-tree size, because the pipeline is incremental.
 *
 * **(b) Commit-granularity**: freshness is keyed on the `HEAD` commit SHA.
 * Working-tree edits (unstaged/uncommitted) are **invisible** to the gate until
 * committed — the graph reflects the last commit, not the working tree. This is
 * intentional: rebuilding on every keystroke would cause thrash and would produce
 * a graph that diverges from what any collaborator or CI sees.
 *
 * **(c) No-op embed-skip**: on a refresh where nothing changed (`filesUpdated ===
 * 0`), no entities are reparsed, so `runEmbedPhase` finds zero stale vectors
 * (`total === 0`) and early-returns WITHOUT loading the embedding model. A
 * marker-mismatch caused by an empty or docs-only commit therefore does not pay
 * embedding cost (confirmed: `kg-pipeline.ts` `runEmbedPhase` early-return at
 * the `total === 0` guard).
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getCurrentHead } from "@features/knowledge-graph/git-intel/git-intel-pipeline.ts";
import { runPipeline } from "@graph/kg-pipeline.ts";
import { CANON_DIR, CANON_FILES, GRAPH_HEAD_COMMIT_KEY } from "@shared/constants.ts";
import Database from "better-sqlite3";

export type EnsureGraphFreshOptions = {
  /** Limit the refresh scan to these subdirectories (passed to runPipeline). */
  sourceDirs?: string[];
};

/**
 * Per-DB single-flight map: concurrent stale refreshers for the same DB path
 * await the first in-flight promise instead of spawning duplicate pipeline runs.
 * Cleared in `finally` so the next stale cycle re-refreshes.
 */
const inFlight = new Map<string, Promise<void>>();

/**
 * Read the stored graph marker without leaving the DB handle open.
 * Returns undefined when the marker is absent or the meta table is missing.
 *
 * Opens the DB read-only with a plain handle (no sqlite-vec load, no DDL, no
 * migrations) — the freshness check must be cheap because it runs on every KG
 * read. The full pipeline (when stale) opens its own initialized handle.
 */
function readStoredMarker(dbPath: string): string | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(GRAPH_HEAD_COMMIT_KEY) as
      | { value: string }
      | undefined;
    return row?.value;
  } catch {
    // meta table absent (un-indexed DB) → treat marker as absent.
    return undefined;
  } finally {
    db.close();
  }
}

/**
 * Run the pipeline exactly once per stale DB, deduplicating concurrent callers.
 * Errors are caught and logged (fail-open); the map entry is always cleared in
 * `finally` so subsequent stale calls can retry.
 */
async function refreshOnce(
  projectDir: string,
  dbPath: string,
  sourceDirs?: string[],
): Promise<void> {
  const existing = inFlight.get(dbPath);
  if (existing) return existing;

  const p = (async () => {
    try {
      await runPipeline(projectDir, { dbPath, sourceDirs });
    } catch (err) {
      console.warn(
        `[ensure-graph-fresh] freshness refresh failed (serving last-good graph): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  })();

  inFlight.set(dbPath, p);
  try {
    await p;
  } finally {
    inFlight.delete(dbPath);
  }
}

/**
 * Ensure the structural knowledge graph is fresh for `projectDir`.
 *
 * No-op when the DB is absent (the read tool reports KG_NOT_INDEXED itself),
 * when HEAD cannot be determined (non-git checkout — avoids rebuild thrash),
 * or when the stored marker already matches HEAD. Otherwise runs the
 * incremental pipeline via `refreshOnce`, which deduplicates concurrent
 * callers, prunes orphans, and re-stamps the marker (on full runs).
 *
 * Fail-open: any error is logged and swallowed; never throws.
 */
export async function ensureGraphFresh(
  projectDir: string,
  opts?: EnsureGraphFreshOptions,
): Promise<void> {
  try {
    const dbPath = join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);

    // DB absent → let the read tool report KG_NOT_INDEXED; do not build here.
    if (!existsSync(dbPath)) return;

    const head = getCurrentHead(projectDir);
    // HEAD null (git unavailable) → cannot determine staleness. Treat as fresh
    // to avoid rebuilding the graph on every read in a non-git checkout. The
    // DB-exists guard above already gates us. (Differs intentionally from
    // git-intel; see decision kg-marker-01 / task plan risk mitigations.)
    if (head === null) return;

    const marker = readStoredMarker(dbPath);
    const stale = marker === undefined || marker !== head;
    if (!stale) return;

    // Single-flight: concurrent stale callers share one pipeline run per DB.
    await refreshOnce(projectDir, dbPath, opts?.sourceDirs);
  } catch (err) {
    console.warn(
      `[ensure-graph-fresh] freshness refresh failed (serving last-good graph): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
