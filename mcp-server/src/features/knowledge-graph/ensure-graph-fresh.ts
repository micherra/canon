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
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { getCurrentHead } from "@features/knowledge-graph/git-intel/git-intel-pipeline.ts";
import { runPipeline } from "@graph/kg-pipeline.ts";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";
import Database from "better-sqlite3";

export type EnsureGraphFreshOptions = {
  /** Limit the refresh scan to these subdirectories (passed to runPipeline). */
  sourceDirs?: string[];
};

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
    const row = db.prepare("SELECT value FROM meta WHERE key = 'graph_head_commit'").get() as
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
 * Ensure the structural knowledge graph is fresh for `projectDir`.
 *
 * No-op when the DB is absent (the read tool reports KG_NOT_INDEXED itself),
 * when HEAD cannot be determined (non-git checkout — avoids rebuild thrash),
 * or when the stored marker already matches HEAD. Otherwise runs the
 * incremental pipeline, which prunes orphans and re-stamps the marker.
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

    // Incremental default — prunes deleted files and re-stamps the marker.
    await runPipeline(projectDir, { dbPath, sourceDirs: opts?.sourceDirs });
  } catch (err) {
    console.warn(
      `[ensure-graph-fresh] freshness refresh failed (serving last-good graph): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
