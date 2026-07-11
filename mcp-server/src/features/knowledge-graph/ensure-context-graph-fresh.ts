/**
 * ensure-context-graph-fresh.ts
 *
 * Lazy content-hash freshness gate for the context graph (decisions/ADRs).
 *
 * Mirrors ensure-doc-corpus-fresh.ts design — content-hash marker in `meta`,
 * per-dbPath single-flight, fail-open — but simpler: the context graph is
 * pure structural nodes/edges with no vectors, so there is no embed phase
 * and no `EmbeddingServiceLike` param. The hash is stamped immediately after
 * a successful ingest (PROBE-FINDINGS Delta 3).
 *
 * Content hash (DEC-M2-02): SHA-256 over (sorted decision `source_slug#
 * source_event_id` ids) ⊕ (sorted (filename, size, mtimeMs) tuples of
 * `pluginDir/docs/adr/*.md`). Content-hash, NOT `graph_head_commit` —
 * decisions live in `.canon/**` SQLite and mutate without git commits, so a
 * git-HEAD gate would never fire.
 *
 * NOTE (deviation from the m2-02 task plan, discovered during
 * implementation): the plan's signature is `ensureContextGraphFresh(dbPath,
 * projectDir, pluginDir)`, calling `buildDecisionsCorpus(projectDir)`
 * internally. `.dependency-cruiser.cjs`'s `no-cross-feature-internal-import`
 * rule forbids `features/knowledge-graph/` from importing
 * `features/orchestration/**` (the ADR-0005 allowance only runs the other
 * direction — peer features may depend ON knowledge-graph, not the reverse).
 * So `decisions` is a parameter here too; see `kg-context-ingest.ts`'s
 * docstring for the full rationale and the composition-root caller.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";
import { type IngestableDecision, ingestContextGraph } from "@graph/kg-context-ingest.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { CONTEXT_GRAPH_HASH_KEY } from "@shared/constants.ts";

/** Per-dbPath single-flight map. */
const inFlight = new Map<string, Promise<void>>();

// Mirrors kg-context-ingest.ts's ADR_FILENAME_RE — duplicated rather than
// imported. Same posture as ensure-doc-corpus-fresh.ts, which keeps its own
// stat-only walkCorpusDir separate from kg-doc-ingest.ts's content-reading
// scanMarkdownFiles: the freshness hash is a stat-walk and must not read
// file content, a distinct concern from the ingest scan it parallels.
const ADR_FILENAME_RE = /^\d{4}-.+\.md$/;

function safeStatSync(abs: string): Stats | null {
  try {
    return statSync(abs);
  } catch {
    return null;
  }
}

/** Compute a cheap content-hash fingerprint for decisions + ADR files. */
function computeContextGraphHash(decisions: IngestableDecision[], pluginDir: string): string {
  const decisionIds = decisions
    .map((d) => `${d.source_slug}#${d.source_event_id}`)
    .sort((a, b) => a.localeCompare(b));

  const adrEntries: Array<[string, number, number]> = [];
  const adrDir = join(pluginDir, "docs", "adr");
  if (existsSync(adrDir)) {
    let filenames: string[] = [];
    try {
      filenames = readdirSync(adrDir).filter((f) => ADR_FILENAME_RE.test(f));
    } catch {
      filenames = []; // fail-open: treat as empty
    }
    for (const filename of filenames) {
      const stat = safeStatSync(join(adrDir, filename));
      if (stat) adrEntries.push([filename, stat.size, stat.mtimeMs]);
    }
  }
  adrEntries.sort((a, b) => a[0].localeCompare(b[0]));

  const hashInput = [
    `decisions:${decisionIds.join(",")}`,
    `adrs:${adrEntries.map(([f, sz, mt]) => `${f}:${sz}:${mt}`).join(",")}`,
  ].join("|");
  return createHash("sha256").update(hashInput).digest("hex");
}

function readStoredHash(dbPath: string): string | undefined {
  const db = initDatabase(dbPath);
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(CONTEXT_GRAPH_HASH_KEY) as
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
      CONTEXT_GRAPH_HASH_KEY,
      hash,
    );
  } finally {
    db.close();
  }
}

type RefreshOnceOptions = {
  decisions: IngestableDecision[];
  projectDir: string;
  pluginDir: string;
  newHash: string;
};

async function refreshOnce(dbPath: string, options: RefreshOnceOptions): Promise<void> {
  const existing = inFlight.get(dbPath);
  if (existing) return existing;

  const { decisions, projectDir, pluginDir, newHash } = options;
  const p = (async () => {
    try {
      const db = initDatabase(dbPath);
      try {
        ingestContextGraph(db, decisions, projectDir, pluginDir);
      } finally {
        db.close();
      }
      // No embed phase to fail (unlike doc-corpus) — stamp immediately.
      writeStoredHash(dbPath, newHash);
    } catch (err) {
      console.warn(
        `[ensure-context-graph-fresh] refresh failed (serving last-good graph): ${
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
 * Ensure the context graph (decisions/ADRs) is fresh.
 *
 * @param dbPath - Absolute path to the knowledge-graph.db file.
 * @param decisions - Already-resolved decisions corpus (see module docstring
 *   for why this is a parameter rather than resolved internally).
 * @param projectDir - Project root, for the `.canon/principles` overlay scan.
 * @param pluginDir - Plugin root, for `docs/adr` + `principles` resolution.
 *
 * No-op when:
 * - DB is absent (caller handles KG_NOT_INDEXED)
 * - Computed content hash matches the stored marker
 *
 * Fail-open: any error is caught and logged; never throws.
 */
export async function ensureContextGraphFresh(
  dbPath: string,
  decisions: IngestableDecision[],
  projectDir: string,
  pluginDir: string,
): Promise<void> {
  try {
    if (!existsSync(dbPath)) return;

    const currentHash = computeContextGraphHash(decisions, pluginDir);
    const storedHash = readStoredHash(dbPath);

    if (storedHash === currentHash) return; // already fresh

    await refreshOnce(dbPath, { decisions, newHash: currentHash, pluginDir, projectDir });
  } catch (err) {
    console.warn(
      `[ensure-context-graph-fresh] freshness gate failed (serving last-good graph): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
