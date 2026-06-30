/**
 * ensure-doc-corpus-fresh.ts
 *
 * Lazy content-hash freshness gate for the knowledge-corpus vector index.
 *
 * Mirrors ensure-graph-fresh.ts design:
 * - Compares a stored content-hash marker in `meta` against a freshly-computed
 *   stat-walk hash of the corpus sources.
 * - On mismatch → runs ingestDocCorpus once, re-stamps the marker.
 * - Fail-open: any error is caught and logged; never throws.
 * - Single-flight: concurrent callers share one in-flight run per DB path.
 *
 * Content hash (dc-06):
 *   SHA-256 over sorted (relPath, size, mtimeMs) tuples for all *.md files in
 *   the resolved source roots. Does NOT read file content — cheap stat-walk only.
 *   Keyed under DOC_CORPUS_HASH_KEY in the meta table (NOT the git HEAD key).
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, type Stats, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ingestDocCorpus } from "@graph/kg-doc-ingest.ts";
import type { EmbeddingServiceLike } from "@graph/kg-embedding.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { DOC_CORPUS_HASH_KEY, type DocCorpusSource } from "@shared/constants.ts";

/** Per-dbPath single-flight map. */
const inFlight = new Map<string, Promise<void>>();

/** Safely stat a path, returning null on any error. */
function safeStatSync(abs: string): Stats | null {
  try {
    return statSync(abs);
  } catch {
    return null;
  }
}

/**
 * Walk a corpus directory tree, collecting (relPath, size, mtimeMs) entries for *.md files.
 * Uses an explicit `entries` parameter instead of a closure to keep complexity low.
 */
function walkCorpusDir(
  root: string,
  corpusName: string,
  entries: Array<[string, number, number]>,
): void {
  if (!existsSync(root)) return;
  let dirEntries: string[];
  try {
    dirEntries = readdirSync(root);
  } catch {
    return;
  }
  for (const entry of dirEntries) {
    const abs = join(root, entry);
    const stat = safeStatSync(abs);
    if (!stat) continue;
    if (stat.isDirectory()) {
      walkCorpusDir(abs, corpusName, entries);
    } else if (entry.endsWith(".md")) {
      const relPath = `${corpusName}/${relative(root, abs)}`;
      entries.push([relPath, stat.size, stat.mtimeMs]);
    }
  }
}

/**
 * Compute a cheap content-hash fingerprint for a set of corpus sources.
 * Stat-walks *.md files; does NOT read file contents.
 */
function computeCorpusHash(sources: DocCorpusSource[]): string {
  const entries: Array<[string, number, number]> = [];
  for (const source of sources) {
    walkCorpusDir(source.root, source.corpus, entries);
  }

  // Sort for determinism
  entries.sort((a, b) => a[0].localeCompare(b[0]));

  const hashInput = entries.map(([p, sz, mt]) => `${p}:${sz}:${mt}`).join("\n");
  return createHash("sha256").update(hashInput).digest("hex");
}

function readStoredHash(dbPath: string): string | undefined {
  const db = initDatabase(dbPath);
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(DOC_CORPUS_HASH_KEY) as
      | { value: string }
      | undefined;
    return row?.value;
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

function writeStoredHash(dbPath: string, hash: string): void {
  const db = initDatabase(dbPath);
  try {
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(
      DOC_CORPUS_HASH_KEY,
      hash,
    );
  } finally {
    db.close();
  }
}

async function refreshOnce(
  dbPath: string,
  sources: DocCorpusSource[],
  embedSvc: EmbeddingServiceLike,
  newHash: string,
): Promise<void> {
  const existing = inFlight.get(dbPath);
  if (existing) return existing;

  const p = (async () => {
    try {
      const db = initDatabase(dbPath);
      try {
        await ingestDocCorpus(db, sources, embedSvc);
      } finally {
        db.close();
      }
      writeStoredHash(dbPath, newHash);
    } catch (err) {
      console.warn(
        `[ensure-doc-corpus-fresh] refresh failed (serving last-good index): ${
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
 * Ensure the knowledge-corpus vector index is fresh.
 *
 * @param dbPath - Absolute path to the knowledge-graph.db file.
 * @param sources - Resolved corpus source descriptors (absolute roots).
 * @param embedSvc - EmbeddingServiceLike instance (caller owns lifecycle).
 *
 * No-op when:
 * - DB is absent (caller handles KG_NOT_INDEXED)
 * - Computed corpus hash matches the stored marker
 *
 * Fail-open: any error is caught and logged; never throws.
 */
export async function ensureDocCorpusFresh(
  dbPath: string,
  sources: DocCorpusSource[],
  embedSvc: EmbeddingServiceLike,
): Promise<void> {
  try {
    if (!existsSync(dbPath)) return;

    const currentHash = computeCorpusHash(sources);
    const storedHash = readStoredHash(dbPath);

    if (storedHash === currentHash) return; // already fresh

    await refreshOnce(dbPath, sources, embedSvc, currentHash);
  } catch (err) {
    console.warn(
      `[ensure-doc-corpus-fresh] freshness gate failed (serving last-good index): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
