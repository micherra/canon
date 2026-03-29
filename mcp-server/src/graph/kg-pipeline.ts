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

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Database } from 'better-sqlite3';
import { initDatabase } from './kg-schema.ts';
import { KgStore } from './kg-store.ts';
import { getAdapter, getLanguage } from './kg-adapter-registry.ts';
import { initParsers } from './kg-wasm-parser.ts';
import { scanSourceFiles } from './scanner.ts';
import { resolveImport } from './import-parser.ts';
import { inferLayer } from '../matcher.ts';
import { CANON_DIR, CANON_FILES } from '../constants.ts';
import type { AdapterResult, EntityRow } from './kg-types.ts';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface PipelineOptions {
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
}

export interface PipelineResult {
  filesScanned: number;
  filesUpdated: number;
  entitiesTotal: number;
  edgesTotal: number;
  durationMs: number;
}

export interface ReindexResult {
  changed: boolean;
  entitiesBefore: number;
  entitiesAfter: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function fileLayer(relPath: string): string {
  return inferLayer(relPath) ?? 'unknown';
}

/** Strip .js / .ts extension aliases used in ESM imports before resolution */
function normaliseSpecifier(spec: string): string {
  // Strip trailing .js in ESM imports so resolveImport can find .ts sources
  if (spec.endsWith('.js')) return spec.slice(0, -3);
  return spec;
}

// ---------------------------------------------------------------------------
// Phase 2 helper — parse one file and store it
// ---------------------------------------------------------------------------

function parseAndStoreFile(
  store: KgStore,
  _projectDir: string,
  relPath: string,
  content: string,
  hash: string,
  mtimeMs: number,
): { fileId: number; adapterResult: AdapterResult | null } {
  const ext = path.extname(relPath);
  const language = getLanguage(ext);
  const layer = fileLayer(relPath);
  // Upsert file row
  const fileRow = store.upsertFile({
    path: relPath,
    mtime_ms: mtimeMs,
    content_hash: hash,
    language,
    layer,
    last_indexed_at: Date.now(),
  });

  const fileId = fileRow.file_id as number;

  // Delete stale entities (CASCADE takes care of edges)
  store.deleteEntitiesByFile(fileId);

  // Insert bare file entity
  const qualifiedName = relPath;
  store.insertEntity({
    file_id: fileId,
    name: path.basename(relPath),
    qualified_name: qualifiedName,
    kind: 'file',
    line_start: 1,
    line_end: 1,
    is_exported: false,
    is_default_export: false,
    signature: null,
    metadata: null,
  });

  // Attempt adapter parse
  const adapter = getAdapter(ext);
  if (!adapter) return { fileId, adapterResult: null };

  try {
    const adapterResult = adapter.parse(relPath, content);

    for (const entityDef of adapterResult.entities) {
      store.insertEntity({
        file_id: fileId,
        ...entityDef,
      } as Omit<EntityRow, 'entity_id'>);
    }
    return { fileId, adapterResult };
  } catch (err) {
    console.warn(`[kg-pipeline] adapter error for ${relPath}: ${(err as Error).message}`);
    return { fileId, adapterResult: null };
  }
}

// ---------------------------------------------------------------------------
// Phase 3 — cross-file import resolution
// ---------------------------------------------------------------------------

function resolveImports(
  store: KgStore,
  _projectDir: string,
  allRelPaths: Set<string>,
  fileImports: Map<string, { relPath: string; specifiers: Array<{ specifier: string; names: string[] }> }>,
): void {
  for (const [relPath, info] of fileImports) {
    const sourceFileRow = store.getFile(relPath);
    if (!sourceFileRow?.file_id) continue;

    for (const { specifier, names } of info.specifiers) {
      const normSpec = normaliseSpecifier(specifier);
      const resolved = resolveImport(normSpec, relPath, allRelPaths);
      if (!resolved) continue;

      const targetFileRow = store.getFile(resolved);
      if (!targetFileRow?.file_id) continue;

      // File-level edge
      store.insertFileEdge({
        source_file_id: sourceFileRow.file_id as number,
        target_file_id: targetFileRow.file_id as number,
        edge_type: 'imports',
        confidence: 1.0,
        evidence: specifier,
        relation: null,
      });

      // Named import → entity-level edges
      for (const name of names) {
        if (!name || name === '*') continue;
        const candidates = store.findExportedByName(name);
        const targetCandidates = candidates.filter(
          (e) => e.file_id === (targetFileRow.file_id as number),
        );
        if (targetCandidates.length === 0) continue;

        // Source file entity (the bare file entity as caller proxy)
        const sourceFileEntities = store.getEntitiesByFile(sourceFileRow.file_id as number);
        const sourceFileEntity = sourceFileEntities.find((e) => e.kind === 'file');
        if (!sourceFileEntity?.entity_id) continue;

        for (const target of targetCandidates) {
          if (!target.entity_id) continue;
          store.insertEdge({
            source_entity_id: sourceFileEntity.entity_id as number,
            target_entity_id: target.entity_id as number,
            edge_type: 'type-references',
            confidence: 0.9,
            metadata: JSON.stringify({ import_name: name }),
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 4 — Canon entity linking (applies-to, spawns, includes)
// ---------------------------------------------------------------------------

function resolveCanonLinks(
  store: KgStore,
  fileImports: Map<string, { relPath: string; specifiers: Array<{ specifier: string; names: string[] }> }>,
): void {
  // Canon links are stored in adapter-produced entity metadata.
  // We iterate all entities looking for those with metadata containing
  // applies_to / spawns / includes and create corresponding edges.
  // This is a best-effort pass — errors are logged and skipped.
  try {
    // Get all principle/flow/agent entities from the DB
    // We look at files that were indexed in this run
    for (const [relPath] of fileImports) {
      const fileRow = store.getFile(relPath);
      if (!fileRow?.file_id) continue;

      const entities = store.getEntitiesByFile(fileRow.file_id as number);
      for (const entity of entities) {
        if (!entity.metadata || !entity.entity_id) continue;

        let meta: Record<string, unknown>;
        try {
          meta = JSON.parse(entity.metadata);
        } catch {
          continue;
        }

        const sourceEntityId = entity.entity_id as number;

        // applies-to: principle → files matching layers/patterns
        const appliesTo = meta['applies_to'] as string[] | undefined;
        if (Array.isArray(appliesTo)) {
          for (const target of appliesTo) {
            const targetFileRow = store.getFile(target);
            if (!targetFileRow?.file_id) continue;
            const targetEntities = store.getEntitiesByFile(targetFileRow.file_id as number);
            const targetFileEntity = targetEntities.find((e) => e.kind === 'file');
            if (targetFileEntity?.entity_id) {
              store.insertEdge({
                source_entity_id: sourceEntityId,
                target_entity_id: targetFileEntity.entity_id as number,
                edge_type: 'applies-to',
                confidence: 0.8,
                metadata: null,
              });
            }
          }
        }

        // spawns: flow-state → agent
        const spawnsTarget = meta['spawns'] as string | undefined;
        if (spawnsTarget) {
          for (const target of store.findExportedByName(spawnsTarget)) {
            if (target.entity_id) {
              store.insertEdge({
                source_entity_id: sourceEntityId,
                target_entity_id: target.entity_id as number,
                edge_type: 'spawns',
                confidence: 0.7,
                metadata: null,
              });
            }
          }
        }

        // includes: flow → fragment
        const includesTarget = meta['includes'] as string | undefined;
        if (includesTarget) {
          for (const target of store.findExportedByName(includesTarget)) {
            if (target.entity_id) {
              store.insertEdge({
                source_entity_id: sourceEntityId,
                target_entity_id: target.entity_id as number,
                edge_type: 'includes',
                confidence: 0.7,
                metadata: null,
              });
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[kg-pipeline] Canon entity linking error: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// runPipeline
// ---------------------------------------------------------------------------

export async function runPipeline(
  projectDir: string,
  options?: PipelineOptions,
): Promise<PipelineResult> {
  await initParsers(); // One-time WASM initialization — idempotent
  const startMs = Date.now();
  const incremental = options?.incremental ?? true;
  const dbPath =
    options?.dbPath ?? path.join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
  const progress = options?.onProgress ?? (() => {});
  const sourceDirs = options?.sourceDirs;

  // Open DB
  const db = initDatabase(dbPath);
  const store = new KgStore(db);

  try {
    // -----------------------------------------------------------------------
    // Phase 1: File scan
    // -----------------------------------------------------------------------
    progress('scan', 0, 0);
    // When sourceDirs is provided, scan each subdirectory and produce relative
    // paths from projectDir so the rest of the pipeline is path-consistent.
    let relPaths: string[];
    if (sourceDirs && sourceDirs.length > 0) {
      const allFiles: string[] = [];
      for (const dir of sourceDirs) {
        const absDir = path.resolve(projectDir, dir);
        // Guard against path traversal: skip any entry that escapes the project root
        if (!absDir.startsWith(projectDir + path.sep) && absDir !== projectDir) {
          continue;
        }
        try {
          const files = await scanSourceFiles(absDir);
          for (const f of files) {
            allFiles.push(path.posix.join(dir.replace(/\\/g, '/'), f.replace(/\\/g, '/')));
          }
        } catch {
          // Directory may not exist — skip silently
        }
      }
      relPaths = allFiles;
    } else {
      relPaths = await scanSourceFiles(projectDir);
    }
    const allRelPathsSet = new Set(relPaths);
    const filesScanned = relPaths.length;

    progress('scan', filesScanned, filesScanned);

    // Determine which files need (re)indexing
    const toIndex: string[] = [];
    const fileHashCache = new Map<string, string>(); // relPath → hash (for changed files)

    for (const relPath of relPaths) {
      const absPath = path.join(projectDir, relPath);
      let stat: ReturnType<typeof statSync> | null = null;
      try {
        stat = statSync(absPath);
      } catch {
        continue; // File disappeared between scan and stat — skip
      }
      const mtimeMs = stat.mtimeMs;

      if (incremental) {
        const existing = store.getFile(relPath);
        if (existing && existing.mtime_ms === mtimeMs) {
          // mtime matches — likely unchanged, skip (no hash needed)
          continue;
        }
        // mtime changed — check hash
        let content: string;
        try {
          content = readFileSync(absPath, 'utf8');
        } catch {
          continue;
        }
        const hash = contentHash(content);
        if (existing && existing.content_hash === hash) {
          // Content unchanged despite mtime change — skip but update mtime
          store.upsertFile({
            path: relPath,
            mtime_ms: mtimeMs,
            content_hash: hash,
            language: existing.language,
            layer: existing.layer,
            last_indexed_at: Date.now(),
          });
          continue;
        }
        fileHashCache.set(relPath, hash);
      }

      toIndex.push(relPath);
    }

    const filesUpdated = toIndex.length;

    // -----------------------------------------------------------------------
    // Phase 2: Parse + extract
    // -----------------------------------------------------------------------
    progress('parse', 0, filesUpdated);

    // Map relPath → adapter result for Phase 3
    const fileImports = new Map<
      string,
      { relPath: string; specifiers: Array<{ specifier: string; names: string[] }> }
    >();

    store.transaction(() => {
      for (let i = 0; i < toIndex.length; i++) {
        const relPath = toIndex[i];
        const absPath = path.join(projectDir, relPath);

        let content: string;
        try {
          content = readFileSync(absPath, 'utf8');
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

        const { adapterResult } = parseAndStoreFile(
          store,
          projectDir,
          relPath,
          content,
          hash,
          mtimeMs,
        );

        if (adapterResult?.importSpecifiers) {
          fileImports.set(relPath, {
            relPath,
            specifiers: adapterResult.importSpecifiers,
          });
        }

        if (i % 50 === 0) progress('parse', i, filesUpdated);
      }
    });

    progress('parse', filesUpdated, filesUpdated);

    // -----------------------------------------------------------------------
    // Phase 3: Cross-file import resolution
    // -----------------------------------------------------------------------
    progress('resolve', 0, fileImports.size);

    store.transaction(() => {
      resolveImports(store, projectDir, allRelPathsSet, fileImports);
    });

    progress('resolve', fileImports.size, fileImports.size);

    // -----------------------------------------------------------------------
    // Phase 4: Canon entity linking
    // -----------------------------------------------------------------------
    progress('canon-link', 0, fileImports.size);

    store.transaction(() => {
      resolveCanonLinks(store, fileImports);
    });

    progress('canon-link', fileImports.size, fileImports.size);

    // -----------------------------------------------------------------------
    // Phase 5: Stats
    // -----------------------------------------------------------------------
    const stats = store.getStats();

    return {
      filesScanned,
      filesUpdated,
      entitiesTotal: stats.entities,
      edgesTotal: stats.edges + stats.fileEdges,
      durationMs: Date.now() - startMs,
    };
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// reindexFile — single-file incremental reindex
// ---------------------------------------------------------------------------

export async function reindexFile(
  db: Database,
  projectDir: string,
  filePath: string,
): Promise<ReindexResult> {
  await initParsers(); // Idempotent — no-op if already initialized
  const store = new KgStore(db);
  const absPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(projectDir, filePath);
  const relPath = path.isAbsolute(filePath)
    ? path.relative(projectDir, filePath)
    : filePath;

  // Read file
  let content: string;
  try {
    content = readFileSync(absPath, 'utf8');
  } catch {
    return { changed: false, entitiesBefore: 0, entitiesAfter: 0 };
  }

  let stat: ReturnType<typeof statSync> | null = null;
  try {
    stat = statSync(absPath);
  } catch {
    return { changed: false, entitiesBefore: 0, entitiesAfter: 0 };
  }

  const hash = contentHash(content);
  const mtimeMs = stat.mtimeMs;

  // Check if unchanged
  const existing = store.getFile(relPath);
  if (existing && existing.content_hash === hash) {
    const entitiesCount = existing.file_id
      ? store.getEntitiesByFile(existing.file_id as number).length
      : 0;
    return { changed: false, entitiesBefore: entitiesCount, entitiesAfter: entitiesCount };
  }

  const entitiesBefore = existing?.file_id
    ? store.getEntitiesByFile(existing.file_id as number).length
    : 0;

  // Re-index in a transaction
  let entitiesAfter = 0;
  store.transaction(() => {
    const { fileId, adapterResult } = parseAndStoreFile(
      store,
      projectDir,
      relPath,
      content,
      hash,
      mtimeMs,
    );

    entitiesAfter = store.getEntitiesByFile(fileId).length;

    // Re-resolve cross-file imports for this file
    if (adapterResult?.importSpecifiers && adapterResult.importSpecifiers.length > 0) {
      // Build a minimal set of all known files from the DB for resolution
      // (We don't have allFiles here, so use a best-effort approach with
      // only this file's directory context; edge creation is best-effort)
      const fileImports = new Map([
        [
          relPath,
          {
            relPath,
            specifiers: adapterResult.importSpecifiers,
          },
        ],
      ]);

      // Collect all known file paths from the store for resolution
      // We use a raw DB query to avoid a full scan API we don't have
      const allKnownPaths = (db as unknown as {
        prepare: (sql: string) => { all: () => Array<{ path: string }> };
      })
        .prepare('SELECT path FROM files')
        .all()
        .map((r: { path: string }) => r.path);

      const allRelPathsSet = new Set(allKnownPaths);

      // Delete stale file edges for this file before re-resolving
      store.deleteFileEdgesByFile(fileId);

      resolveImports(store, projectDir, allRelPathsSet, fileImports);
    }
  });

  return { changed: true, entitiesBefore, entitiesAfter };
}
