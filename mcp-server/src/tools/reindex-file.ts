/**
 * reindex_file MCP tool — incremental single-file reindex of the knowledge graph.
 *
 * Accepts a project-relative file path, updates the SQLite knowledge graph for
 * that file only, then materializes the updated graph to graph-data.json.
 *
 * Edge cases handled:
 *   - Missing file (deleted): removes the file entry from the DB
 *   - Path outside project dir: rejected with an error result
 *   - DB doesn't exist yet: initialized via initDatabase before use
 */

import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { reindexFile } from '../graph/kg-pipeline.js';
import { materializeToFile } from '../graph/view-materializer.js';
import { initDatabase } from '../graph/kg-schema.js';
import { KgStore } from '../graph/kg-store.js';
import { CANON_DIR, CANON_FILES } from '../constants.js';

export interface ReindexFileInput {
  file_path: string;
}

export interface ReindexFileOutput {
  file_path: string;
  status: 'updated' | 'unchanged' | 'deleted' | 'rejected';
  entities_before: number;
  entities_after: number;
  changed: boolean;
  message?: string;
}

export async function reindexFileTool(
  input: ReindexFileInput,
  projectDir: string,
): Promise<ReindexFileOutput> {
  const rawPath = input.file_path;

  // -------------------------------------------------------------------------
  // 1. Path validation — reject paths that escape the project directory
  // -------------------------------------------------------------------------
  const absPath = path.resolve(projectDir, rawPath);
  const projectRoot = path.resolve(projectDir);

  // Ensure trailing sep for prefix check so '/proj-foo' doesn't match '/proj'
  const projectRootWithSep = projectRoot + path.sep;
  const isInsideProject = absPath === projectRoot || absPath.startsWith(projectRootWithSep);

  if (!isInsideProject) {
    return {
      file_path: rawPath,
      status: 'rejected',
      entities_before: 0,
      entities_after: 0,
      changed: false,
      message: `Path is outside the project directory: ${rawPath}`,
    };
  }

  // Use POSIX-style relative path as the canonical key (consistent with DB storage)
  const relPath = path.relative(projectRoot, absPath).split(path.sep).join('/');

  // -------------------------------------------------------------------------
  // 2. Open (or create) the SQLite database
  // -------------------------------------------------------------------------
  const canonDir = path.join(projectRoot, CANON_DIR);
  mkdirSync(canonDir, { recursive: true });

  const dbPath = path.join(canonDir, CANON_FILES.KNOWLEDGE_DB);
  const db = initDatabase(dbPath);

  try {
    // -----------------------------------------------------------------------
    // 3. Handle missing file — remove from DB if tracked, skip if unknown
    // -----------------------------------------------------------------------
    if (!existsSync(absPath)) {
      const store = new KgStore(db);
      const existing = store.getFile(relPath);

      if (!existing) {
        // Not tracked — nothing to do
        return {
          file_path: relPath,
          status: 'deleted',
          entities_before: 0,
          entities_after: 0,
          changed: false,
          message: `File not found and not tracked in DB: ${relPath}`,
        };
      }

      // File was tracked — remove it (CASCADE handles entities/file_edges)
      const entitiesBefore = existing.file_id
        ? store.getEntitiesByFile(existing.file_id as number).length
        : 0;

      store.deleteFile(relPath);

      // Materialize with the updated DB state (file deleted)
      materializeToFile(db, projectRoot);

      return {
        file_path: relPath,
        status: 'deleted',
        entities_before: entitiesBefore,
        entities_after: 0,
        changed: true,
        message: `File deleted and removed from knowledge graph: ${relPath}`,
      };
    }

    // -----------------------------------------------------------------------
    // 4. Reindex the file (incremental — skips if content unchanged)
    // -----------------------------------------------------------------------
    const result = await reindexFile(db, projectRoot, relPath);

    // -----------------------------------------------------------------------
    // 5. Materialize graph-data.json (always, even if unchanged, to ensure
    //    the file is current when the DB was just freshly initialized)
    // -----------------------------------------------------------------------
    materializeToFile(db, projectRoot);

    return {
      file_path: relPath,
      status: result.changed ? 'updated' : 'unchanged',
      entities_before: result.entitiesBefore,
      entities_after: result.entitiesAfter,
      changed: result.changed,
    };
  } finally {
    db.close();
  }
}
