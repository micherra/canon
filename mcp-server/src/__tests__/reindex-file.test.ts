/**
 * reindex_file tool tests
 *
 * Integration-style tests using a temp directory on disk.
 * We write real files, invoke reindexFileTool, and verify the output shape
 * and DB/graph-data.json side effects.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reindexFileTool } from '../tools/reindex-file.js';
import { CANON_DIR, CANON_FILES } from '../constants.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempProject(): string {
  return mkdtempSync(path.join(tmpdir(), 'reindex-file-test-'));
}

function writeProjectFile(projectDir: string, relPath: string, content: string): void {
  const absPath = path.join(projectDir, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, 'utf8');
}

function graphDataPath(projectDir: string): string {
  return path.join(projectDir, CANON_DIR, CANON_FILES.GRAPH_DATA);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reindexFileTool', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempProject();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Happy path — new file
  // -------------------------------------------------------------------------

  test('indexes a new file and returns updated status', async () => {
    writeProjectFile(projectDir, 'src/hello.ts', 'export function hello() {}');

    const result = await reindexFileTool({ file_path: 'src/hello.ts' }, projectDir);

    expect(result.status).toBe('updated');
    expect(result.changed).toBe(true);
    expect(result.file_path).toBe('src/hello.ts');
    expect(result.entities_before).toBe(0);
    expect(result.entities_after).toBeGreaterThan(0);
  });

  test('writes graph-data.json after indexing', async () => {
    writeProjectFile(projectDir, 'src/app.ts', 'export const x = 1;');

    await reindexFileTool({ file_path: 'src/app.ts' }, projectDir);

    expect(existsSync(graphDataPath(projectDir))).toBe(true);
    const raw = readFileSync(graphDataPath(projectDir), 'utf8');
    const graphData = JSON.parse(raw);
    expect(graphData).toHaveProperty('nodes');
    expect(graphData).toHaveProperty('edges');
    expect(Array.isArray(graphData.nodes)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Unchanged content
  // -------------------------------------------------------------------------

  test('returns unchanged status when content has not changed', async () => {
    writeProjectFile(projectDir, 'src/stable.ts', 'export const stable = true;');

    // First index
    await reindexFileTool({ file_path: 'src/stable.ts' }, projectDir);

    // Second index — same content
    const result = await reindexFileTool({ file_path: 'src/stable.ts' }, projectDir);

    expect(result.status).toBe('unchanged');
    expect(result.changed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // File updated between calls
  // -------------------------------------------------------------------------

  test('returns updated status after file content changes', async () => {
    writeProjectFile(projectDir, 'src/changing.ts', 'export function v1() {}');
    await reindexFileTool({ file_path: 'src/changing.ts' }, projectDir);

    // Update the file content
    writeProjectFile(projectDir, 'src/changing.ts', 'export function v1() {} export function v2() {}');

    const result = await reindexFileTool({ file_path: 'src/changing.ts' }, projectDir);

    expect(result.status).toBe('updated');
    expect(result.changed).toBe(true);
    expect(result.entities_after).toBeGreaterThanOrEqual(result.entities_before);
  });

  // -------------------------------------------------------------------------
  // Missing file (deleted) — not tracked in DB
  // -------------------------------------------------------------------------

  test('returns deleted status when file does not exist and is not tracked', async () => {
    const result = await reindexFileTool({ file_path: 'src/ghost.ts' }, projectDir);

    expect(result.status).toBe('deleted');
    expect(result.changed).toBe(false);
    expect(result.entities_before).toBe(0);
    expect(result.entities_after).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Missing file (deleted) — was previously tracked
  // -------------------------------------------------------------------------

  test('removes a tracked file from the DB when it is deleted', async () => {
    const filePath = path.join(projectDir, 'src/ephemeral.ts');
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, 'export function gone() {}', 'utf8');

    // Index while the file exists
    await reindexFileTool({ file_path: 'src/ephemeral.ts' }, projectDir);

    // Delete the file on disk
    unlinkSync(filePath);

    // Reindex — tool should detect deletion
    const result = await reindexFileTool({ file_path: 'src/ephemeral.ts' }, projectDir);

    expect(result.status).toBe('deleted');
    expect(result.changed).toBe(true);
    expect(result.entities_before).toBeGreaterThan(0);
    expect(result.entities_after).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Path traversal — reject paths outside project dir
  // -------------------------------------------------------------------------

  test('rejects a path outside the project directory', async () => {
    const result = await reindexFileTool({ file_path: '../../../etc/passwd' }, projectDir);

    expect(result.status).toBe('rejected');
    expect(result.changed).toBe(false);
    expect(result.message).toMatch(/outside the project directory/i);
  });

  test('rejects an absolute path outside the project directory', async () => {
    const result = await reindexFileTool({ file_path: '/etc/hosts' }, projectDir);

    expect(result.status).toBe('rejected');
    expect(result.changed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // DB initialization — DB created on first call
  // -------------------------------------------------------------------------

  test('initializes the DB if it does not exist yet', async () => {
    const dbPath = path.join(projectDir, CANON_DIR, CANON_FILES.KNOWLEDGE_DB);
    expect(existsSync(dbPath)).toBe(false);

    writeProjectFile(projectDir, 'src/init-test.ts', 'export const y = 2;');
    await reindexFileTool({ file_path: 'src/init-test.ts' }, projectDir);

    expect(existsSync(dbPath)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Output shape
  // -------------------------------------------------------------------------

  test('returns the correct output shape', async () => {
    writeProjectFile(projectDir, 'src/shape.ts', 'export const shape = {};');
    const result = await reindexFileTool({ file_path: 'src/shape.ts' }, projectDir);

    expect(result).toMatchObject({
      file_path: expect.any(String),
      status: expect.stringMatching(/^(updated|unchanged|deleted|rejected)$/),
      entities_before: expect.any(Number),
      entities_after: expect.any(Number),
      changed: expect.any(Boolean),
    });
  });
});
