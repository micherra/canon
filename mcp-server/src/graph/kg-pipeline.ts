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

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import { CANON_DIR, CANON_FILES } from "../shared/constants.ts";
import { inferLayer } from "../matcher.ts";
import { resolveImport } from "./import-parser.ts";
import { getAdapter, getLanguage } from "./kg-adapter-registry.ts";
import { EmbeddingService } from "./kg-embedding.ts";
import { initDatabase } from "./kg-schema.ts";
import { KgStore } from "./kg-store.ts";
import type { AdapterResult, EdgeType, EntityRow } from "./kg-types.ts";
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

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function fileLayer(relPath: string): string {
  return inferLayer(relPath) ?? "unknown";
}

/** Strip .js / .ts extension aliases used in ESM imports before resolution */
function normaliseSpecifier(spec: string): string {
  // Strip trailing .js in ESM imports so resolveImport can find .ts sources
  if (spec.endsWith(".js")) return spec.slice(0, -3);
  return spec;
}

// Phase 2 helper — parse one file and store it

type ParseFileParams = {
  relPath: string;
  content: string;
  hash: string;
  mtimeMs: number;
};

function parseAndStoreFile(
  store: KgStore,
  params: ParseFileParams,
): { fileId: number; adapterResult: AdapterResult | null } {
  const { relPath, content, hash, mtimeMs } = params;
  const ext = path.extname(relPath);
  const language = getLanguage(ext);
  const layer = fileLayer(relPath);
  // Upsert file row
  const fileRow = store.upsertFile({
    content_hash: hash,
    language,
    last_indexed_at: Date.now(),
    layer,
    mtime_ms: mtimeMs,
    path: relPath,
  });

  const fileId = fileRow.file_id as number;

  // Delete stale entities (CASCADE takes care of edges)
  store.deleteEntitiesByFile(fileId);

  // Insert bare file entity
  const qualifiedName = relPath;
  store.insertEntity({
    file_id: fileId,
    is_default_export: false,
    is_exported: false,
    kind: "file",
    line_end: 1,
    line_start: 1,
    metadata: null,
    name: path.basename(relPath),
    qualified_name: qualifiedName,
    signature: null,
  });

  // Attempt adapter parse
  const adapter = getAdapter(ext);
  if (!adapter) return { adapterResult: null, fileId };

  try {
    const adapterResult = adapter.parse(relPath, content);

    for (const entityDef of adapterResult.entities) {
      store.insertEntity({
        file_id: fileId,
        ...entityDef,
      } as Omit<EntityRow, "entity_id">);
    }
    return { adapterResult, fileId };
  } catch (err) {
    console.warn(`[kg-pipeline] adapter error for ${relPath}: ${(err as Error).message}`);
    return { adapterResult: null, fileId };
  }
}

// Phase 3 — cross-file import resolution

/** Resolve a single named import to entity-level edges. */
function resolveNamedImport(
  store: KgStore,
  name: string,
  sourceFileId: number,
  targetFileId: number,
): void {
  if (!name || name === "*") return;

  const candidates = store.findExportedByName(name);
  const targetCandidates = candidates.filter((e) => e.file_id === targetFileId);
  if (targetCandidates.length === 0) return;

  const sourceFileEntities = store.getEntitiesByFile(sourceFileId);
  const sourceFileEntity = sourceFileEntities.find((e) => e.kind === "file");
  if (!sourceFileEntity?.entity_id) return;

  for (const target of targetCandidates) {
    if (!target.entity_id) continue;
    store.insertEdge({
      confidence: 0.9,
      edge_type: "type-references",
      metadata: JSON.stringify({ import_name: name }),
      source_entity_id: sourceFileEntity.entity_id as number,
      target_entity_id: target.entity_id as number,
    });
  }
}

type ResolveImportParams = {
  specifier: string;
  names: string[];
  relPath: string;
  allRelPaths: Set<string>;
};

/** Resolve a single import specifier and create file + entity edges. */
function resolveOneImport(store: KgStore, sourceFileId: number, params: ResolveImportParams): void {
  const { specifier, names, relPath, allRelPaths } = params;
  const normSpec = normaliseSpecifier(specifier);
  const resolved = resolveImport(normSpec, relPath, allRelPaths);
  if (!resolved) return;

  const targetFileRow = store.getFile(resolved);
  if (!targetFileRow?.file_id) return;

  store.insertFileEdge({
    confidence: 1.0,
    edge_type: "imports",
    evidence: specifier,
    relation: null,
    source_file_id: sourceFileId,
    target_file_id: targetFileRow.file_id as number,
  });

  for (const name of names) {
    resolveNamedImport(store, name, sourceFileId, targetFileRow.file_id as number);
  }
}

function resolveImports(
  store: KgStore,
  _projectDir: string,
  allRelPaths: Set<string>,
  fileImports: Map<
    string,
    { relPath: string; specifiers: Array<{ specifier: string; names: string[] }> }
  >,
): void {
  for (const [relPath, info] of fileImports) {
    const sourceFileRow = store.getFile(relPath);
    if (!sourceFileRow?.file_id) continue;

    for (const { specifier, names } of info.specifiers) {
      resolveOneImport(store, sourceFileRow.file_id as number, {
        allRelPaths,
        names,
        relPath,
        specifier,
      });
    }
  }
}

// Phase 4 — Canon entity linking (applies-to, spawns, includes)

/** Link applies-to edges from a source entity to target files. */
function linkAppliesTo(store: KgStore, sourceEntityId: number, targets: string[]): void {
  for (const target of targets) {
    const targetFileRow = store.getFile(target);
    if (!targetFileRow?.file_id) continue;
    const targetEntities = store.getEntitiesByFile(targetFileRow.file_id as number);
    const targetFileEntity = targetEntities.find((e) => e.kind === "file");
    if (!targetFileEntity?.entity_id) continue;
    store.insertEdge({
      confidence: 0.8,
      edge_type: "applies-to",
      metadata: null,
      source_entity_id: sourceEntityId,
      target_entity_id: targetFileEntity.entity_id as number,
    });
  }
}

type NamedTargetParams = {
  targetName: string;
  edgeType: EdgeType;
  confidence: number;
};

/** Link named-lookup edges (spawns, includes) from a source entity. */
function linkNamedTarget(store: KgStore, sourceEntityId: number, params: NamedTargetParams): void {
  const { targetName, edgeType, confidence } = params;
  for (const target of store.findExportedByName(targetName)) {
    if (!target.entity_id) continue;
    store.insertEdge({
      confidence,
      edge_type: edgeType,
      metadata: null,
      source_entity_id: sourceEntityId,
      target_entity_id: target.entity_id as number,
    });
  }
}

/** Process Canon links for a single entity's metadata. */
function processEntityCanonLinks(store: KgStore, entityId: number, metadata: string): void {
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(metadata);
  } catch {
    return;
  }

  const appliesTo = meta.applies_to as string[] | undefined;
  if (Array.isArray(appliesTo)) linkAppliesTo(store, entityId, appliesTo);

  const spawnsTarget = meta.spawns as string | undefined;
  if (spawnsTarget)
    linkNamedTarget(store, entityId, {
      confidence: 0.7,
      edgeType: "spawns",
      targetName: spawnsTarget,
    });

  const includesTarget = meta.includes as string | undefined;
  if (includesTarget)
    linkNamedTarget(store, entityId, {
      confidence: 0.7,
      edgeType: "includes",
      targetName: includesTarget,
    });
}

function resolveCanonLinks(
  store: KgStore,
  fileImports: Map<
    string,
    { relPath: string; specifiers: Array<{ specifier: string; names: string[] }> }
  >,
): void {
  try {
    for (const [relPath] of fileImports) {
      const fileRow = store.getFile(relPath);
      if (!fileRow?.file_id) continue;

      const entities = store.getEntitiesByFile(fileRow.file_id as number);
      for (const entity of entities) {
        if (!entity.metadata || !entity.entity_id) continue;
        processEntityCanonLinks(store, entity.entity_id as number, entity.metadata);
      }
    }
  } catch (err) {
    console.warn(`[kg-pipeline] Canon entity linking error: ${(err as Error).message}`);
  }
}

// runPipeline

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

type ReindexCheckParams = {
  projectDir: string;
  relPath: string;
  incremental: boolean;
  fileHashCache: Map<string, string>;
};

/** Check if a file needs reindexing; returns true if it should be indexed. */
function shouldReindex(store: KgStore, params: ReindexCheckParams): boolean {
  const { projectDir, relPath, incremental, fileHashCache } = params;
  const absPath = path.join(projectDir, relPath);
  let stat: ReturnType<typeof statSync> | null = null;
  try {
    stat = statSync(absPath);
  } catch {
    return false;
  }
  const mtimeMs = stat.mtimeMs;

  if (!incremental) return true;

  const existing = store.getFile(relPath);
  if (existing && existing.mtime_ms === mtimeMs) return false;

  let content: string;
  try {
    content = readFileSync(absPath, "utf8");
  } catch {
    return false;
  }
  const hash = contentHash(content);
  if (existing && existing.content_hash === hash) {
    store.upsertFile({
      content_hash: hash,
      language: existing.language,
      last_indexed_at: Date.now(),
      layer: existing.layer,
      mtime_ms: mtimeMs,
      path: relPath,
    });
    return false;
  }
  fileHashCache.set(relPath, hash);
  return true;
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

type ParsePhaseContext = {
  toIndex: string[];
  projectDir: string;
  store: KgStore;
  fileHashCache: Map<string, string>;
  fileImports: Map<
    string,
    { relPath: string; specifiers: Array<{ specifier: string; names: string[] }> }
  >;
  progress: (phase: string, current: number, total: number) => void;
  filesUpdated: number;
};

/** Phase 2 inner loop: read, hash, parse, and store each file. */
function parsePhase2(ctx: ParsePhaseContext): void {
  const { toIndex, projectDir, store, fileHashCache, fileImports, progress, filesUpdated } = ctx;
  for (let i = 0; i < toIndex.length; i++) {
    const relPath = toIndex[i];
    const absPath = path.join(projectDir, relPath);

    let content: string;
    try {
      content = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }

    let stat: ReturnType<typeof statSync> | null = null;
    try {
      stat = statSync(absPath);
    } catch {
      continue;
    }
    const mtimeMs = stat.mtimeMs;
    const hash = fileHashCache.get(relPath) ?? contentHash(content);

    const { adapterResult } = parseAndStoreFile(store, { content, hash, mtimeMs, relPath });

    if (adapterResult?.importSpecifiers) {
      fileImports.set(relPath, { relPath, specifiers: adapterResult.importSpecifiers });
    }

    if (i % 50 === 0) progress("parse", i, filesUpdated);
  }
}

type FileImportMap = Map<
  string,
  { relPath: string; specifiers: Array<{ specifier: string; names: string[] }> }
>;

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

type ResolveLinkOpts = {
  allRelPathsSet: Set<string>;
  fileImports: FileImportMap;
  progress: NonNullable<PipelineOptions["onProgress"]>;
};

/** Phases 3-4: Resolve imports and Canon entity links. */
function resolveLinkPhases(store: KgStore, projectDir: string, opts: ResolveLinkOpts): void {
  const { allRelPathsSet, fileImports, progress } = opts;
  progress("resolve", 0, fileImports.size);
  store.transaction(() => {
    resolveImports(store, projectDir, allRelPathsSet, fileImports);
  });
  progress("resolve", fileImports.size, fileImports.size);

  progress("canon-link", 0, fileImports.size);
  store.transaction(() => {
    resolveCanonLinks(store, fileImports);
  });
  progress("canon-link", fileImports.size, fileImports.size);
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

// reindexFile — single-file incremental reindex

/** Read file content and stat; returns null if file is unreadable. */
function readFileForReindex(absPath: string): { content: string; mtimeMs: number } | null {
  let content: string;
  try {
    content = readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
  let stat: ReturnType<typeof statSync> | null = null;
  try {
    stat = statSync(absPath);
  } catch {
    return null;
  }
  return { content, mtimeMs: stat.mtimeMs };
}

/** Re-parse a single file and re-resolve its imports within a transaction. */
function reindexFileTransaction(
  db: Database,
  store: KgStore,
  projectDir: string,
  params: ParseFileParams,
): number {
  let entitiesAfter = 0;
  store.transaction(() => {
    const { fileId, adapterResult } = parseAndStoreFile(store, params);
    entitiesAfter = store.getEntitiesByFile(fileId).length;

    if (adapterResult?.importSpecifiers && adapterResult.importSpecifiers.length > 0) {
      const fileImports: FileImportMap = new Map([
        [params.relPath, { relPath: params.relPath, specifiers: adapterResult.importSpecifiers }],
      ]);
      const allKnownPaths = (
        db as unknown as { prepare: (sql: string) => { all: () => Array<{ path: string }> } }
      )
        .prepare("SELECT path FROM files")
        .all()
        .map((r: { path: string }) => r.path);

      store.deleteFileEdgesByFile(fileId);
      resolveImports(store, projectDir, new Set(allKnownPaths), fileImports);
    }
  });
  return entitiesAfter;
}

export async function reindexFile(
  db: Database,
  projectDir: string,
  filePath: string,
): Promise<ReindexResult> {
  await initParsers();
  const store = new KgStore(db);
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(projectDir, filePath);
  const relPath = path.isAbsolute(filePath) ? path.relative(projectDir, filePath) : filePath;

  const fileData = readFileForReindex(absPath);
  if (!fileData) return { changed: false, entitiesAfter: 0, entitiesBefore: 0 };

  const hash = contentHash(fileData.content);
  const existing = store.getFile(relPath);
  if (existing && existing.content_hash === hash) {
    const count = existing.file_id ? store.getEntitiesByFile(existing.file_id as number).length : 0;
    return { changed: false, entitiesAfter: count, entitiesBefore: count };
  }

  const entitiesBefore = existing?.file_id
    ? store.getEntitiesByFile(existing.file_id as number).length
    : 0;

  const entitiesAfter = reindexFileTransaction(db, store, projectDir, {
    content: fileData.content,
    hash,
    mtimeMs: fileData.mtimeMs,
    relPath,
  });

  return { changed: true, entitiesAfter, entitiesBefore };
}
