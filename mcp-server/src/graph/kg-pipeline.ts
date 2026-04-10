/**
 * Knowledge Graph Pipeline Orchestrator
 *
 * Ties together file scanning, adapter-based parsing, cross-file import
 * resolution, Canon entity linking, and SQLite persistence into a single
 * runPipeline() entry point.  Also exports reindexFile() for incremental
 * single-file updates.
 *
 * All DB mutations are wrapped in transactions for performance.  Adapter
 * errors are treated as non-fatal: a bare file entity is created instead.
 */

import path from "node:path";
import { CANON_DIR, CANON_FILES } from "@shared/constants.ts";
import type { Database } from "better-sqlite3";
import { EmbeddingService } from "./kg-embedding.ts";
import type { FileImportMap } from "./kg-pipeline-phases.ts";
import { parsePhase2, resolveLinkPhases, shouldReindex } from "./kg-pipeline-phases.ts";
import { initDatabase } from "./kg-schema.ts";
import { KgStore } from "./kg-store.ts";
import { KgVectorStore } from "./kg-vector-store.ts";
import { initParsers } from "./kg-wasm-parser.ts";
import { scanSourceFiles } from "./scanner.ts";

// Public interfaces

export type PipelineOptions = {
  /** Defaults to `<projectDir>/.canon/knowledge-graph.db` */
  dbPath?: string;
  /** Skip files whose mtime + hash match the DB row (default: true) */
  incremental?: boolean;
  /** Called after each phase with progress info */
  onProgress?: (phase: string, current: number, total: number) => void;
  /**
   * Limit the scan to these subdirectories (relative to projectDir).
   * When provided, only files under these directories are indexed.
   * When omitted, the full projectDir is scanned.
   */
  sourceDirs?: string[];
};

export type PipelineResult = {
  filesScanned: number;
  filesUpdated: number;
  entitiesTotal: number;
  edgesTotal: number;
  durationMs: number;
  embeddingsGenerated?: number;
};

export type ReindexResult = {
  changed: boolean;
  entitiesBefore: number;
  entitiesAfter: number;
};

/** Scan source files, handling sourceDirs if provided. */
async function scanPhase(projectDir: string, sourceDirs?: string[]): Promise<string[]> {
  if (!sourceDirs || sourceDirs.length === 0) {
    return scanSourceFiles(projectDir);
  }

  const allFiles: string[] = [];
  for (const dir of sourceDirs) {
    const absDir = path.resolve(projectDir, dir);
    if (!absDir.startsWith(projectDir + path.sep) && absDir !== projectDir) continue;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: sequential scan with per-directory error handling; each directory is isolated
      const files = await scanSourceFiles(absDir);
      for (const f of files) {
        allFiles.push(path.posix.join(dir.replace(/\\/g, "/"), f.replace(/\\/g, "/")));
      }
    } catch {
      // Directory may not exist — skip silently
    }
  }
  return allFiles;
}

// Phase 5 — Embed (async, best-effort)

/**
 * Embed all stale entity and summary vectors.
 *
 * Design:
 * - Strict phase separation: collect IDs (sync DB read) → generate embeddings
 *   (async) → write back (sync transaction). Never call async embedding inside
 *   db.transaction().
 * - Non-fatal: any error is caught and logged; the pipeline always succeeds.
 * - Orphan cleanup runs before embedding to avoid wasted work.
 */
async function runEmbedPhase(
  db: Database,
  onProgress?: (phase: string, current: number, total: number) => void,
): Promise<{ entitiesEmbedded: number; summariesEmbedded: number }> {
  const vectorStore = new KgVectorStore(db);
  const embeddingService = new EmbeddingService();

  try {
    onProgress?.("embed", 0, 0);

    // 1. Clean orphan vectors
    vectorStore.cleanOrphanEntityVectors();
    vectorStore.cleanOrphanSummaryVectors();

    // 2. Get stale entities and summaries (sync DB reads)
    const staleEntities = vectorStore.getStaleEntityVectors();
    const staleSummaries = vectorStore.getStaleSummaryVectors();
    const total = staleEntities.length + staleSummaries.length;

    if (total === 0) {
      onProgress?.("embed", 0, 0);
      return { entitiesEmbedded: 0, summariesEmbedded: 0 };
    }

    // 3. Embed entities (async — NEVER inside a db.transaction())
    if (staleEntities.length > 0) {
      const texts = staleEntities.map((e) => KgVectorStore.compositeEntityText(e));
      const embeddings = await embeddingService.embed(texts);

      // 4. Write back in transaction (sync)
      const store = new KgStore(db);
      store.transaction(() => {
        for (let i = 0; i < staleEntities.length; i++) {
          vectorStore.upsertEntityVector(
            staleEntities[i].entity_id,
            embeddings[i],
            staleEntities[i].current_hash,
          );
        }
      });
    }

    // 5. Embed summaries (async)
    if (staleSummaries.length > 0) {
      const texts = staleSummaries.map((s) => s.summary);
      const embeddings = await embeddingService.embed(texts);

      const store = new KgStore(db);
      store.transaction(() => {
        for (let i = 0; i < staleSummaries.length; i++) {
          vectorStore.upsertSummaryVector(
            staleSummaries[i].summary_id,
            embeddings[i],
            staleSummaries[i].current_hash,
          );
        }
      });
    }

    onProgress?.("embed", total, total);
    return { entitiesEmbedded: staleEntities.length, summariesEmbedded: staleSummaries.length };
  } catch (err) {
    // Embedding failures are non-fatal
    console.warn(`[kg-pipeline] embed phase error (non-fatal): ${(err as Error).message}`);
    return { entitiesEmbedded: 0, summariesEmbedded: 0 };
  } finally {
    embeddingService.dispose();
  }
}

/** Phase 1: Scan files and determine which need reindexing. */
async function scanAndFilterPhase(
  store: KgStore,
  projectDir: string,
  opts: {
    incremental: boolean;
    sourceDirs?: string[];
    progress: NonNullable<PipelineOptions["onProgress"]>;
  },
): Promise<{ relPaths: string[]; toIndex: string[]; fileHashCache: Map<string, string> }> {
  opts.progress("scan", 0, 0);
  const relPaths = await scanPhase(projectDir, opts.sourceDirs);
  opts.progress("scan", relPaths.length, relPaths.length);

  const toIndex: string[] = [];
  const fileHashCache = new Map<string, string>();
  for (const relPath of relPaths) {
    if (
      shouldReindex(store, { fileHashCache, incremental: opts.incremental, projectDir, relPath })
    ) {
      toIndex.push(relPath);
    }
  }
  return { fileHashCache, relPaths, toIndex };
}

export async function runPipeline(
  projectDir: string,
  options?: PipelineOptions,
): Promise<PipelineResult> {
  await initParsers();
  const startMs = Date.now();
  const incremental = options?.incremental ?? true;
  const dbPath = options?.dbPath ?? path.join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  const progress: NonNullable<PipelineOptions["onProgress"]> =
    options?.onProgress ??
    (() => {
      /* noop */
    });

  const db = initDatabase(dbPath);
  const store = new KgStore(db);

  try {
    const { relPaths, toIndex, fileHashCache } = await scanAndFilterPhase(store, projectDir, {
      incremental,
      progress,
      sourceDirs: options?.sourceDirs,
    });
    const filesUpdated = toIndex.length;

    // Phase 2: Parse + extract
    progress("parse", 0, filesUpdated);
    const fileImports: FileImportMap = new Map();
    store.transaction(() => {
      parsePhase2({
        fileHashCache,
        fileImports,
        filesUpdated,
        progress,
        projectDir,
        store,
        toIndex,
      });
    });
    progress("parse", filesUpdated, filesUpdated);

    // Phases 3-4: Resolve imports + Canon links
    resolveLinkPhases(store, projectDir, {
      allRelPathsSet: new Set(relPaths),
      fileImports,
      progress,
    });

    // Phase 5: Embed
    const embedResult = await runEmbedPhase(db, progress);

    const stats = store.getStats();
    return {
      durationMs: Date.now() - startMs,
      edgesTotal: stats.edges + stats.fileEdges,
      embeddingsGenerated: embedResult.entitiesEmbedded + embedResult.summariesEmbedded,
      entitiesTotal: stats.entities,
      filesScanned: relPaths.length,
      filesUpdated,
    };
  } finally {
    store.close();
  }
}
