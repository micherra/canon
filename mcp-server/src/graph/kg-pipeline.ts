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
import { getCurrentHead } from "@features/knowledge-graph/git-intel/git-intel-pipeline.ts";
import {
  CANON_DIR,
  CANON_FILES,
  GRAPH_HEAD_COMMIT_KEY,
  SCANNABLE_EXTENSIONS,
} from "@shared/constants.ts";
import type { Database } from "better-sqlite3";

// biome-ignore lint/performance/noBarrelFile: intentional re-export — kg-pipeline is the single entry point for both bulk pipeline and incremental reindex; consumers should not need to know about the internal split
export { readFileForReindex, reindexFile, reindexFileTransaction } from "./kg-pipeline-reindex.ts";

import { getOverlayExtensions, registerOverlayAdapters } from "./kg-adapter-registry.ts";
import { detectCommunities } from "./kg-community.ts";
import { EmbeddingService } from "./kg-embedding.ts";
import type { FileImportMap } from "./kg-pipeline-phases.ts";
import { parsePhase2, resolveLinkPhases, shouldReindex } from "./kg-pipeline-phases.ts";
import { KgQuery } from "./kg-query.ts";
import { initDatabase } from "./kg-schema.ts";
import { KgStore } from "./kg-store.ts";
import { propagateAllTags } from "./kg-tags.ts";
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
  /** Number of distinct communities detected during Phase 5. */
  communitiesDetected?: number;
  /** Total number of file tags computed during Phase 6. */
  tagsComputed?: number;
};

export type ReindexResult = {
  changed: boolean;
  entitiesBefore: number;
  entitiesAfter: number;
};

/**
 * Compute the union of built-in scannable extensions plus any extensions
 * registered by the current project's overlay adapters. This ensures that
 * overlay-only extensions (e.g. `.rb`) are discovered during the scan phase
 * even though `SCANNABLE_EXTENSIONS` does not include them.
 */
function buildIncludeExtensions(): string[] {
  const overlayExts = getOverlayExtensions();
  if (overlayExts.size === 0) return [...SCANNABLE_EXTENSIONS];
  const union = new Set(SCANNABLE_EXTENSIONS);
  for (const ext of overlayExts) {
    union.add(ext);
  }
  return [...union];
}

/** Scan source files, handling sourceDirs if provided. */
async function scanPhase(projectDir: string, sourceDirs?: string[]): Promise<string[]> {
  const includeExtensions = buildIncludeExtensions();

  if (!sourceDirs || sourceDirs.length === 0) {
    return scanSourceFiles(projectDir, { includeExtensions });
  }

  const allFiles: string[] = [];
  for (const dir of sourceDirs) {
    const absDir = path.resolve(projectDir, dir);
    if (!absDir.startsWith(projectDir + path.sep) && absDir !== projectDir) continue;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: sequential scan with per-directory error handling; each directory is isolated
      const files = await scanSourceFiles(absDir, { includeExtensions });
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

type PhaseResult = {
  communityResult: ReturnType<typeof detectCommunities>;
  tagResult: ReturnType<typeof propagateAllTags>;
  embedResult: Awaited<ReturnType<typeof runEmbedPhase>>;
};

/** Phases 5-7: Community detection, tag propagation, and embedding. */
async function runEnrichmentPhases(
  db: Database,
  store: KgStore,
  progress: NonNullable<PipelineOptions["onProgress"]>,
): Promise<PhaseResult> {
  // Phase 5: Community detection
  progress("community", 0, 0);
  const kgQuery = new KgQuery(db);
  const adjacencyList = kgQuery.getFileAdjacencyList();
  const communityResult = detectCommunities(adjacencyList, store);
  progress("community", communityResult.filesAssigned, communityResult.filesAssigned);

  // Phase 6: Tag propagation
  progress("tags", 0, 0);
  const tagResult = propagateAllTags(store, kgQuery);
  progress("tags", tagResult.totalTags, tagResult.totalTags);

  // Phase 7: Embed
  const embedResult = await runEmbedPhase(db, progress);

  return { communityResult, embedResult, tagResult };
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

/**
 * Self-healing orphan prune: delete file rows present in the store but absent
 * from the on-disk scan. Relies on ON DELETE CASCADE to drop each orphan's
 * edges (including inbound edges from dependents), so dependents' blast-radius
 * and in_degree correct automatically — no dependent reparse required.
 */
function pruneOrphanFiles(store: KgStore, scannedRelPaths: string[]): void {
  const scanned = new Set(scannedRelPaths);
  const storedPaths = store.getAllFilePaths();
  const orphans = storedPaths.filter((p) => !scanned.has(p));
  if (orphans.length === 0) return;
  store.transaction(() => {
    for (const p of orphans) {
      store.deleteFileAndDependents(p);
    }
  });
}

/**
 * Stamp the graph with its build commit and assemble the PipelineResult.
 * Called only after all phases succeed (decision kg-marker-01). The marker is
 * stamped only on full-project runs (`meta.isFullRun === true`) — scoped runs
 * must not advance the marker because they only processed a subset of the tree,
 * so a later full `ensureGraphFresh` would see a fresh marker and skip rebuilding
 * the parts it missed (decision kg-sync-fix-01). It is skipped when git is
 * unavailable (head null) so the next read retries.
 */
function stampAndBuildResult(
  store: KgStore,
  projectDir: string,
  phases: PhaseResult,
  meta: { startMs: number; relPathsCount: number; filesUpdated: number; isFullRun: boolean },
): PipelineResult {
  const head = getCurrentHead(projectDir);
  if (head && meta.isFullRun) store.setMeta(GRAPH_HEAD_COMMIT_KEY, head);

  const stats = store.getStats();
  return {
    communitiesDetected: phases.communityResult.communityCount,
    durationMs: Date.now() - meta.startMs,
    edgesTotal: stats.edges + stats.fileEdges,
    embeddingsGenerated: phases.embedResult.entitiesEmbedded + phases.embedResult.summariesEmbedded,
    entitiesTotal: stats.entities,
    filesScanned: meta.relPathsCount,
    filesUpdated: meta.filesUpdated,
    tagsComputed: phases.tagResult.totalTags,
  };
}

export async function runPipeline(
  projectDir: string,
  options?: PipelineOptions,
): Promise<PipelineResult> {
  const loadedOverlayConfigs = await initParsers(projectDir);
  registerOverlayAdapters(loadedOverlayConfigs);
  const startMs = Date.now();
  const incremental = options?.incremental ?? true;
  const dbPath = options?.dbPath ?? path.join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  const progress: NonNullable<PipelineOptions["onProgress"]> =
    options?.onProgress ??
    (() => {
      /* noop */
    });

  // A full run owns the entire project tree: prune orphans + stamp the HEAD marker.
  // Scoped runs target a subset (sourceDirs provided) and must do neither — they
  // only see a portion of the tree, so pruning would delete out-of-scope rows, and
  // stamping the marker would trick ensureGraphFresh into skipping the next full
  // refresh (decision kg-sync-fix-01).
  const isFullRun = options?.sourceDirs == null || options.sourceDirs.length === 0;

  const db = initDatabase(dbPath);
  const store = new KgStore(db);

  try {
    const { relPaths, toIndex, fileHashCache } = await scanAndFilterPhase(store, projectDir, {
      incremental,
      progress,
      sourceDirs: options?.sourceDirs,
    });
    const filesUpdated = toIndex.length;

    // Self-healing prune: remove stored files no longer on disk (set-diff).
    // CASCADE drops dependents' inbound edges automatically (decision kg-prune-04).
    // Scoped runs skip this to avoid deleting out-of-scope rows (decision kg-sync-fix-01).
    if (isFullRun) pruneOrphanFiles(store, relPaths);

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

    // Phases 5-7: Community detection, tag propagation, embedding
    const phases = await runEnrichmentPhases(db, store, progress);

    return stampAndBuildResult(store, projectDir, phases, {
      filesUpdated,
      isFullRun,
      relPathsCount: relPaths.length,
      startMs,
    });
  } finally {
    store.close();
  }
}
