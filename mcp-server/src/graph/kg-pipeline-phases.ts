/**
 * Knowledge Graph Pipeline — Parse & Resolve Phases
 *
 * Contains parse-phase helpers (parseAndStoreFile, parsePhase2) and
 * resolve-phase helpers (resolveImports, resolveCanonLinks, resolveLinkPhases)
 * extracted from kg-pipeline.ts.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { resolveImport } from "./import-parser.ts";
import { getAdapter, getLanguage } from "./kg-adapter-registry.ts";
import { contentHash, fileLayer, normaliseSpecifier } from "./kg-pipeline-utils.ts";
import type { KgStore } from "./kg-store.ts";
import type { AdapterResult, EdgeType, EntityRow } from "./kg-types.ts";

// Phase 2 helper — parse one file and store it

export type ParseFileParams = {
  relPath: string;
  content: string;
  hash: string;
  mtimeMs: number;
};

export function parseAndStoreFile(
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

type ResolveDocRefParams = {
  sourceFileId: number;
  specifier: string;
  allRelPaths: Set<string>;
  relPath: string;
};

/**
 * Resolve a doc:references specifier using a conservative resolution order:
 *   1. Exact repo-root-relative membership using the RAW specifier
 *      (doc citations are literal paths; the .js→strip must NOT apply here).
 *   2. Fallback to relative resolution via resolveImport with normaliseSpecifier
 *      (handles ./ and ../ links where ESM .js→.ts aliasing is legitimate).
 *   3. Drop silently — consistent with unresolved-import behavior.
 *
 * Named-import entity edges are skipped: doc-ref specifiers carry empty names
 * arrays by construction (verified: doc adapters never populate names for refs).
 */
function resolveDocRefSpecifier(store: KgStore, params: ResolveDocRefParams): void {
  const { sourceFileId, specifier, allRelPaths, relPath } = params;

  // Step 1: exact repo-root-relative membership — use raw specifier (not normalised).
  // Doc citations are literal file paths; normaliseSpecifier strips .js which would
  // cause "scripts/build.js" to miss an exact match against allRelPaths.
  let resolved: string | null = allRelPaths.has(specifier) ? specifier : null;

  // Step 2: fallback to relative resolution (handles ./ and ../ links).
  // normaliseSpecifier is applied here only, where ESM .js→.ts aliasing is needed.
  if (!resolved) {
    resolved = resolveImport(normaliseSpecifier(specifier), relPath, allRelPaths);
  }

  // Step 3: drop silently if unresolved
  if (!resolved) return;

  const targetFileRow = store.getFile(resolved);
  if (!targetFileRow?.file_id) return;

  store.insertFileEdge({
    confidence: 1.0,
    edge_type: "doc:references",
    evidence: specifier,
    relation: null,
    source_file_id: sourceFileId,
    target_file_id: targetFileRow.file_id as number,
  });
  // Named-import entity edges skipped: doc-ref specifiers have empty names arrays.
}

export function resolveImports(
  store: KgStore,
  _projectDir: string,
  allRelPaths: Set<string>,
  fileImports: Map<
    string,
    {
      relPath: string;
      specifiers: Array<{ specifier: string; names: string[]; edgeType?: "doc:references" }>;
    }
  >,
): void {
  for (const [relPath, info] of fileImports) {
    const sourceFileRow = store.getFile(relPath);
    if (!sourceFileRow?.file_id) continue;

    for (const { specifier, names, edgeType } of info.specifiers) {
      if (edgeType === "doc:references") {
        resolveDocRefSpecifier(store, {
          allRelPaths,
          relPath,
          sourceFileId: sourceFileRow.file_id as number,
          specifier,
        });
      } else {
        resolveOneImport(store, sourceFileRow.file_id as number, {
          allRelPaths,
          names,
          relPath,
          specifier,
        });
      }
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
    // best-effort: entity metadata JSON is malformed; skip Canon link processing for this entity
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

export function resolveCanonLinks(
  store: KgStore,
  fileImports: Map<
    string,
    {
      relPath: string;
      specifiers: Array<{ specifier: string; names: string[]; edgeType?: "doc:references" }>;
    }
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

export type ReindexCheckParams = {
  projectDir: string;
  relPath: string;
  incremental: boolean;
  fileHashCache: Map<string, string>;
};

/** Check if a file needs reindexing; returns true if it should be indexed. */
export function shouldReindex(store: KgStore, params: ReindexCheckParams): boolean {
  const { projectDir, relPath, incremental, fileHashCache } = params;
  const absPath = path.join(projectDir, relPath);
  let stat: ReturnType<typeof statSync> | null = null;
  try {
    stat = statSync(absPath);
  } catch {
    // best-effort: file may have been deleted between scan and indexing; skip it
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
    // best-effort: file unreadable between scan and indexing; skip it
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

export type ParsePhaseContext = {
  toIndex: string[];
  projectDir: string;
  store: KgStore;
  fileHashCache: Map<string, string>;
  fileImports: Map<
    string,
    {
      relPath: string;
      specifiers: Array<{ specifier: string; names: string[]; edgeType?: "doc:references" }>;
    }
  >;
  progress: (phase: string, current: number, total: number) => void;
  filesUpdated: number;
};

/** Phase 2 inner loop: read, hash, parse, and store each file. */
export function parsePhase2(ctx: ParsePhaseContext): void {
  const { toIndex, projectDir, store, fileHashCache, fileImports, progress, filesUpdated } = ctx;
  for (let i = 0; i < toIndex.length; i++) {
    const relPath = toIndex[i];
    const absPath = path.join(projectDir, relPath);

    let content: string;
    try {
      content = readFileSync(absPath, "utf8");
    } catch {
      // best-effort: file deleted or unreadable between scan and indexing; skip it
      continue;
    }

    let stat: ReturnType<typeof statSync> | null = null;
    try {
      stat = statSync(absPath);
    } catch {
      // best-effort: file stat failed between read and indexing; skip it
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

export type FileImportMap = Map<
  string,
  {
    relPath: string;
    specifiers: Array<{ specifier: string; names: string[]; edgeType?: "doc:references" }>;
  }
>;

export type ResolveLinkOpts = {
  allRelPathsSet: Set<string>;
  fileImports: FileImportMap;
  progress: (phase: string, current: number, total: number) => void;
};

/** Phases 3-4: Resolve imports and Canon entity links. */
export function resolveLinkPhases(store: KgStore, projectDir: string, opts: ResolveLinkOpts): void {
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
