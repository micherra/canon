/**
 * Knowledge Graph Pipeline — Reindex Flow
 *
 * Single-file incremental reindex helpers extracted from kg-pipeline.ts.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Database } from "better-sqlite3";
import type { ReindexResult } from "./kg-pipeline.ts";
import type { FileImportMap, ParseFileParams } from "./kg-pipeline-phases.ts";
import { parseAndStoreFile, resolveImports } from "./kg-pipeline-phases.ts";
import { contentHash } from "./kg-pipeline-utils.ts";
import { KgStore } from "./kg-store.ts";
import { initParsers } from "./kg-wasm-parser.ts";

/** Read file content and stat; returns null if file is unreadable. */
export function readFileForReindex(absPath: string): { content: string; mtimeMs: number } | null {
  let content: string;
  try {
    content = readFileSync(absPath, "utf8");
  } catch {
    // File unreadable (deleted, permission denied) — skip
    return null;
  }
  let stat: ReturnType<typeof statSync> | null = null;
  try {
    stat = statSync(absPath);
  } catch {
    // File stat failed after successful read — treat as unindexable
    return null;
  }
  return { content, mtimeMs: stat.mtimeMs };
}

/** Re-parse a single file and re-resolve its imports within a transaction. */
export function reindexFileTransaction(
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
