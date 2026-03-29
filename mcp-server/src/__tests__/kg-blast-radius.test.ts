/**
 * Tests for the unified blast radius types, classifyBlastSeverity() pure function,
 * and computeUnifiedBlastRadius() orchestration function.
 *
 * These tests cover severity classification rules, description string generation,
 * the treatment of test files vs. production files, and the integration between
 * file-level and entity-level blast radius queries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { initDatabase } from '../graph/kg-schema.ts';
import { KgStore } from '../graph/kg-store.ts';
import {
  classifyBlastSeverity,
  computeUnifiedBlastRadius,
  type BlastRadiusFile,
} from '../graph/kg-blast-radius.ts';
import type { FileRow, EntityRow } from '../graph/kg-types.ts';

// ---------------------------------------------------------------------------
// Shared DB helpers
// ---------------------------------------------------------------------------

function makeFileRow(overrides: Partial<Omit<FileRow, 'file_id'>> = {}): Omit<FileRow, 'file_id'> {
  return {
    path: 'src/A.ts',
    mtime_ms: 1700000000000,
    content_hash: 'abc123',
    language: 'typescript',
    layer: 'domain',
    last_indexed_at: Date.now(),
    ...overrides,
  };
}

function makeEntityRow(
  fileId: number,
  overrides: Partial<Omit<EntityRow, 'entity_id' | 'file_id'>> = {},
): Omit<EntityRow, 'entity_id'> {
  return {
    file_id: fileId,
    name: 'myFunc',
    qualified_name: 'src/A.ts::myFunc',
    kind: 'function',
    line_start: 1,
    line_end: 10,
    is_exported: false,
    is_default_export: false,
    signature: null,
    metadata: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeFile(
  overrides: Partial<BlastRadiusFile> & Pick<BlastRadiusFile, 'path'>,
): BlastRadiusFile {
  return {
    depth: 1,
    relationship: 'imports',
    layer: 'domain',
    is_test: false,
    in_degree: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyBlastSeverity — severity levels
// ---------------------------------------------------------------------------

describe('classifyBlastSeverity', () => {
  describe('contained', () => {
    it('returns contained when no files are affected', () => {
      const result = classifyBlastSeverity([], 'domain');
      expect(result.severity).toBe('contained');
      expect(result.total_files).toBe(0);
      expect(result.total_production_files).toBe(0);
    });

    it('returns contained when all affected files are test files', () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ path: 'src/__tests__/foo.test.ts', is_test: true, layer: 'domain' }),
        makeFile({ path: 'src/test/bar.spec.ts', is_test: true, layer: 'api' }),
      ];
      const result = classifyBlastSeverity(affected, 'domain');
      expect(result.severity).toBe('contained');
      expect(result.total_files).toBe(2); // test files still counted in total_files
      expect(result.total_production_files).toBe(0);
    });

    it('returns the contained description string', () => {
      const result = classifyBlastSeverity([], 'api');
      expect(result.description).toBe(
        'Changes are fully contained. No production files depend on this.',
      );
    });
  });

  describe('low', () => {
    it('returns low for 2 same-layer, low in_degree production files', () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ path: 'src/a.ts', layer: 'domain', in_degree: 2 }),
        makeFile({ path: 'src/b.ts', layer: 'domain', in_degree: 3 }),
      ];
      const result = classifyBlastSeverity(affected, 'domain');
      expect(result.severity).toBe('low');
      expect(result.total_production_files).toBe(2);
    });

    it('returns low for 1 same-layer file with in_degree exactly 5 (boundary)', () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ path: 'src/a.ts', layer: 'domain', in_degree: 5 }),
      ];
      const result = classifyBlastSeverity(affected, 'domain');
      expect(result.severity).toBe('low');
    });

    it('returns low description with correct count and layer name', () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ path: 'src/a.ts', layer: 'api', in_degree: 1 }),
        makeFile({ path: 'src/b.ts', layer: 'api', in_degree: 2 }),
      ];
      const result = classifyBlastSeverity(affected, 'api');
      expect(result.description).toBe(
        'Low blast radius — 2 direct dependents, all within the api layer.',
      );
    });
  });

  describe('moderate', () => {
    it('returns moderate when there is 1 cross-layer production file', () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ path: 'src/api/handler.ts', layer: 'api', in_degree: 1 }),
      ];
      const result = classifyBlastSeverity(affected, 'domain');
      expect(result.severity).toBe('moderate');
      expect(result.cross_layer_count).toBe(1);
    });

    it('returns moderate for 4 same-layer production files', () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ path: 'src/a.ts', layer: 'domain', in_degree: 1 }),
        makeFile({ path: 'src/b.ts', layer: 'domain', in_degree: 1 }),
        makeFile({ path: 'src/c.ts', layer: 'domain', in_degree: 1 }),
        makeFile({ path: 'src/d.ts', layer: 'domain', in_degree: 1 }),
      ];
      const result = classifyBlastSeverity(affected, 'domain');
      expect(result.severity).toBe('moderate');
    });

    it('returns moderate for 8 same-layer production files (upper boundary)', () => {
      const affected: BlastRadiusFile[] = Array.from({ length: 8 }, (_, i) =>
        makeFile({ path: `src/f${i}.ts`, layer: 'domain', in_degree: 1 }),
      );
      const result = classifyBlastSeverity(affected, 'domain');
      expect(result.severity).toBe('moderate');
    });

    it('returns moderate when a low-count file has in_degree > 5 (same layer)', () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ path: 'src/hub.ts', layer: 'domain', in_degree: 6 }),
      ];
      const result = classifyBlastSeverity(affected, 'domain');
      expect(result.severity).toBe('moderate');
    });

    it('returns moderate description with file count and cross-layer count', () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ path: 'src/a.ts', layer: 'domain', in_degree: 1 }),
        makeFile({ path: 'src/b.ts', layer: 'domain', in_degree: 1 }),
        makeFile({ path: 'src/c.ts', layer: 'domain', in_degree: 1 }),
        makeFile({ path: 'src/api/handler.ts', layer: 'api', in_degree: 1 }),
        makeFile({ path: 'src/api/router.ts', layer: 'api', in_degree: 1 }),
      ];
      const result = classifyBlastSeverity(affected, 'domain');
      expect(result.description).toBe(
        'Moderate blast radius — 5 files affected, 2 across layer boundaries.',
      );
    });
  });

  describe('high', () => {
    it('returns high for 9 same-layer production files', () => {
      const affected: BlastRadiusFile[] = Array.from({ length: 9 }, (_, i) =>
        makeFile({ path: `src/f${i}.ts`, layer: 'domain', in_degree: 1 }),
      );
      const result = classifyBlastSeverity(affected, 'domain');
      expect(result.severity).toBe('high');
    });

    it('returns high for 10+ same-layer production files', () => {
      const affected: BlastRadiusFile[] = Array.from({ length: 10 }, (_, i) =>
        makeFile({ path: `src/f${i}.ts`, layer: 'domain', in_degree: 1 }),
      );
      const result = classifyBlastSeverity(affected, 'domain');
      expect(result.severity).toBe('high');
      expect(result.total_production_files).toBe(10);
    });

    it('returns high description referencing the hub file and in_degree', () => {
      const affected: BlastRadiusFile[] = Array.from({ length: 9 }, (_, i) =>
        makeFile({ path: `src/f${i}.ts`, layer: 'domain', in_degree: 1 }),
      );
      // inject a hub file
      affected.push(
        makeFile({ path: 'src/core/hub.ts', layer: 'domain', in_degree: 11 }),
      );
      const result = classifyBlastSeverity(affected, 'domain');
      // 10 prod files >= 9 AND has hub — critical check fails (no cross-layer), so high
      expect(result.severity).toBe('high');
      expect(result.description).toContain('hub');
    });
  });

  describe('critical', () => {
    it('returns critical when hub file (in_degree > 10) is cross-layer', () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ path: 'src/api/mega-hub.ts', layer: 'api', in_degree: 15 }),
      ];
      const result = classifyBlastSeverity(affected, 'domain');
      expect(result.severity).toBe('critical');
      expect(result.amplification_risk).toBe(true);
    });

    it('includes layer count in critical description', () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ path: 'src/api/mega-hub.ts', layer: 'api', in_degree: 15 }),
        makeFile({ path: 'src/infra/db.ts', layer: 'infra', in_degree: 2 }),
      ];
      const result = classifyBlastSeverity(affected, 'domain');
      expect(result.severity).toBe('critical');
      expect(result.description).toMatch(/critical blast radius/i);
      expect(result.description).toContain('mega-hub.ts');
    });

    it('does NOT classify as critical when hub is in same layer as seed', () => {
      // hub exists but no cross-layer → high, not critical
      const affected: BlastRadiusFile[] = [
        makeFile({ path: 'src/domain/hub.ts', layer: 'domain', in_degree: 12 }),
      ];
      const result = classifyBlastSeverity(affected, 'domain');
      expect(result.severity).toBe('high');
    });
  });

  // ---------------------------------------------------------------------------
  // Test file handling
  // ---------------------------------------------------------------------------

  describe('test file exclusion', () => {
    it('excludes test files from severity but counts them in total_files', () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ path: 'src/a.ts', is_test: false, layer: 'domain', in_degree: 1 }),
        makeFile({
          path: 'src/__tests__/a.test.ts',
          is_test: true,
          layer: 'domain',
          in_degree: 0,
        }),
      ];
      const result = classifyBlastSeverity(affected, 'domain');
      expect(result.total_files).toBe(2);
      expect(result.total_production_files).toBe(1);
      // 1 prod file, same layer → low
      expect(result.severity).toBe('low');
    });

    it('counts test files in cross_layer only via production filtering', () => {
      // test file is in a different layer — should NOT affect cross_layer_count
      const affected: BlastRadiusFile[] = [
        makeFile({ path: 'src/a.ts', is_test: false, layer: 'domain', in_degree: 1 }),
        makeFile({
          path: 'src/__tests__/api.test.ts',
          is_test: true,
          layer: 'api',
          in_degree: 0,
        }),
      ];
      const result = classifyBlastSeverity(affected, 'domain');
      // cross_layer_count filters prod files only
      expect(result.cross_layer_count).toBe(0);
      expect(result.severity).toBe('low');
    });
  });

  // ---------------------------------------------------------------------------
  // Computed metadata fields
  // ---------------------------------------------------------------------------

  describe('computed metadata', () => {
    it('reports max_depth_reached correctly', () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ path: 'src/a.ts', depth: 1, layer: 'domain', in_degree: 1 }),
        makeFile({ path: 'src/b.ts', depth: 3, layer: 'domain', in_degree: 1 }),
        makeFile({ path: 'src/c.ts', depth: 2, layer: 'domain', in_degree: 1 }),
      ];
      const result = classifyBlastSeverity(affected, 'domain');
      expect(result.max_depth_reached).toBe(3);
    });

    it('reports max_depth_reached as 0 for empty input', () => {
      const result = classifyBlastSeverity([], 'domain');
      expect(result.max_depth_reached).toBe(0);
    });

    it('sets amplification_risk true when any file has in_degree > 10', () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ path: 'src/hub.ts', layer: 'domain', in_degree: 11 }),
      ];
      const result = classifyBlastSeverity(affected, 'domain');
      expect(result.amplification_risk).toBe(true);
    });

    it('sets amplification_risk false when no file exceeds in_degree 10', () => {
      const affected: BlastRadiusFile[] = [
        makeFile({ path: 'src/a.ts', layer: 'domain', in_degree: 10 }),
      ];
      const result = classifyBlastSeverity(affected, 'domain');
      expect(result.amplification_risk).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// computeUnifiedBlastRadius — integration tests
// ---------------------------------------------------------------------------

describe('computeUnifiedBlastRadius', () => {
  let db: Database.Database;
  let store: KgStore;

  beforeEach(() => {
    db = initDatabase(':memory:');
    store = new KgStore(db);
  });

  afterEach(() => {
    store.close();
  });

  it('returns contained report when file is not in the KG', () => {
    const result = computeUnifiedBlastRadius(db, 'src/nonexistent.ts');
    expect(result.seed_file).toBe('src/nonexistent.ts');
    expect(result.summary.severity).toBe('contained');
    expect(result.affected).toHaveLength(0);
    expect(result.by_depth).toEqual({});
  });

  it('returns contained report when file has no dependents', () => {
    // Seed file exists but no file_edges point to it and no entities call it
    store.upsertFile(makeFileRow({ path: 'src/seed.ts', layer: 'domain' }));

    const result = computeUnifiedBlastRadius(db, 'src/seed.ts');
    expect(result.summary.severity).toBe('contained');
    expect(result.affected).toHaveLength(0);
    expect(result.seed_layer).toBe('domain');
  });

  it('returns file-level blast radius for a non-code file (file_edges only)', () => {
    // Seed: a config file with no entities. Two files import it via file_edges.
    const seedFile = store.upsertFile(
      makeFileRow({ path: 'config/tsconfig.json', layer: 'config', language: 'json' }),
    );
    const fileA = store.upsertFile(
      makeFileRow({ path: 'src/a.ts', layer: 'api', language: 'typescript' }),
    );
    const fileB = store.upsertFile(
      makeFileRow({ path: 'src/b.ts', layer: 'domain', language: 'typescript' }),
    );

    store.insertFileEdge({
      source_file_id: fileA.file_id!,
      target_file_id: seedFile.file_id!,
      edge_type: 'imports',
      confidence: 1.0,
      evidence: null,
      relation: null,
    });
    store.insertFileEdge({
      source_file_id: fileB.file_id!,
      target_file_id: seedFile.file_id!,
      edge_type: 'imports',
      confidence: 1.0,
      evidence: null,
      relation: null,
    });

    const result = computeUnifiedBlastRadius(db, 'config/tsconfig.json');

    expect(result.affected).toHaveLength(2);
    const affectedPaths = result.affected.map((f) => f.path).sort();
    expect(affectedPaths).toEqual(['src/a.ts', 'src/b.ts']);
    // Both are at depth 1
    expect(result.affected.every((f) => f.depth === 1)).toBe(true);
    // by_depth should have depth 1 with 2 files
    expect(result.by_depth[1]).toHaveLength(2);
  });

  it('returns entity-level blast radius for a code file with exported entities', () => {
    // Seed file has an exported function. Another file's entity calls it.
    const seedFile = store.upsertFile(
      makeFileRow({ path: 'src/seed.ts', layer: 'domain' }),
    );
    const callerFile = store.upsertFile(
      makeFileRow({ path: 'src/caller.ts', layer: 'api' }),
    );

    const exportedFn = store.insertEntity(
      makeEntityRow(seedFile.file_id!, {
        name: 'exportedFn',
        qualified_name: 'src/seed.ts::exportedFn',
        is_exported: true,
      }),
    );
    const callerFn = store.insertEntity(
      makeEntityRow(callerFile.file_id!, {
        name: 'callerFn',
        qualified_name: 'src/caller.ts::callerFn',
      }),
    );

    // callerFn calls exportedFn
    store.insertEdge({
      source_entity_id: callerFn.entity_id!,
      target_entity_id: exportedFn.entity_id!,
      edge_type: 'calls',
      confidence: 1.0,
      metadata: null,
    });

    const result = computeUnifiedBlastRadius(db, 'src/seed.ts');

    expect(result.affected).toHaveLength(1);
    expect(result.affected[0].path).toBe('src/caller.ts');
    expect(result.affected[0].depth).toBe(1);
    expect(result.affected[0].affected_entities).toContain('callerFn');
  });

  it('merges file-level and entity-level results — entity adds affected_entities to existing file entry', () => {
    // Both file_edges and entity edges point from callerFile to seedFile.
    // The result should have a single entry for callerFile with affected_entities populated.
    const seedFile = store.upsertFile(
      makeFileRow({ path: 'src/seed.ts', layer: 'domain' }),
    );
    const callerFile = store.upsertFile(
      makeFileRow({ path: 'src/caller.ts', layer: 'api' }),
    );

    // File edge: callerFile imports seedFile
    store.insertFileEdge({
      source_file_id: callerFile.file_id!,
      target_file_id: seedFile.file_id!,
      edge_type: 'imports',
      confidence: 1.0,
      evidence: null,
      relation: null,
    });

    // Entity edge: callerFn calls exportedFn in seed
    const exportedFn = store.insertEntity(
      makeEntityRow(seedFile.file_id!, {
        name: 'exportedFn',
        qualified_name: 'src/seed.ts::exportedFn',
        is_exported: true,
      }),
    );
    const callerFn = store.insertEntity(
      makeEntityRow(callerFile.file_id!, {
        name: 'callerFn',
        qualified_name: 'src/caller.ts::callerFn',
      }),
    );
    store.insertEdge({
      source_entity_id: callerFn.entity_id!,
      target_entity_id: exportedFn.entity_id!,
      edge_type: 'calls',
      confidence: 1.0,
      metadata: null,
    });

    const result = computeUnifiedBlastRadius(db, 'src/seed.ts');

    // Should be a single file entry (not duplicated)
    expect(result.affected).toHaveLength(1);
    expect(result.affected[0].path).toBe('src/caller.ts');
    // Entity detail should be merged in
    expect(result.affected[0].affected_entities).toContain('callerFn');
  });

  it('entity-level results add new file entries not found via file_edges', () => {
    // No file_edges exist, but entity-level edges reveal a caller in a different file
    const seedFile = store.upsertFile(
      makeFileRow({ path: 'src/seed.ts', layer: 'domain' }),
    );
    const callerFile = store.upsertFile(
      makeFileRow({ path: 'src/indirect.ts', layer: 'api' }),
    );

    const exportedFn = store.insertEntity(
      makeEntityRow(seedFile.file_id!, {
        name: 'myExport',
        qualified_name: 'src/seed.ts::myExport',
        is_exported: true,
      }),
    );
    const callerFn = store.insertEntity(
      makeEntityRow(callerFile.file_id!, {
        name: 'indirectUser',
        qualified_name: 'src/indirect.ts::indirectUser',
      }),
    );
    store.insertEdge({
      source_entity_id: callerFn.entity_id!,
      target_entity_id: exportedFn.entity_id!,
      edge_type: 'calls',
      confidence: 1.0,
      metadata: null,
    });

    const result = computeUnifiedBlastRadius(db, 'src/seed.ts');

    expect(result.affected).toHaveLength(1);
    expect(result.affected[0].path).toBe('src/indirect.ts');
    expect(result.affected[0].relationship).toBe('entity-dependency');
    expect(result.affected[0].affected_entities).toContain('indirectUser');
  });

  it('respects maxDepth option', () => {
    // A imports B, B imports seed. maxDepth=1 → only B should appear.
    const seedFile = store.upsertFile(
      makeFileRow({ path: 'src/seed.ts', layer: 'domain' }),
    );
    const fileB = store.upsertFile(
      makeFileRow({ path: 'src/b.ts', layer: 'domain' }),
    );
    const fileA = store.upsertFile(
      makeFileRow({ path: 'src/a.ts', layer: 'api' }),
    );

    store.insertFileEdge({
      source_file_id: fileB.file_id!,
      target_file_id: seedFile.file_id!,
      edge_type: 'imports',
      confidence: 1.0,
      evidence: null,
      relation: null,
    });
    store.insertFileEdge({
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
      edge_type: 'imports',
      confidence: 1.0,
      evidence: null,
      relation: null,
    });

    const result = computeUnifiedBlastRadius(db, 'src/seed.ts', { maxDepth: 1 });

    const affectedPaths = result.affected.map((f) => f.path);
    expect(affectedPaths).toContain('src/b.ts'); // depth 1
    expect(affectedPaths).not.toContain('src/a.ts'); // depth 2, excluded
  });

  it('handles circular file references without infinite recursion', () => {
    // Circular: A imports B, B imports A. Seed = A. Should terminate.
    const fileA = store.upsertFile(
      makeFileRow({ path: 'src/a.ts', layer: 'domain' }),
    );
    const fileB = store.upsertFile(
      makeFileRow({ path: 'src/b.ts', layer: 'domain' }),
    );

    store.insertFileEdge({
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
      edge_type: 'imports',
      confidence: 1.0,
      evidence: null,
      relation: null,
    });
    store.insertFileEdge({
      source_file_id: fileB.file_id!,
      target_file_id: fileA.file_id!,
      edge_type: 'imports',
      confidence: 1.0,
      evidence: null,
      relation: null,
    });

    // Should not hang or throw; DISTINCT in the CTE handles cycles
    expect(() => computeUnifiedBlastRadius(db, 'src/a.ts')).not.toThrow();
    const result = computeUnifiedBlastRadius(db, 'src/a.ts');
    // fileB references fileA, so fileB should appear in blast radius
    const affectedPaths = result.affected.map((f) => f.path);
    expect(affectedPaths).toContain('src/b.ts');
  });

  it('marks test files as is_test=true via isTestFile()', () => {
    const seedFile = store.upsertFile(
      makeFileRow({ path: 'src/utils.ts', layer: 'domain' }),
    );
    const testFile = store.upsertFile(
      makeFileRow({ path: 'src/__tests__/utils.test.ts', layer: 'domain' }),
    );

    store.insertFileEdge({
      source_file_id: testFile.file_id!,
      target_file_id: seedFile.file_id!,
      edge_type: 'imports',
      confidence: 1.0,
      evidence: null,
      relation: null,
    });

    const result = computeUnifiedBlastRadius(db, 'src/utils.ts');

    expect(result.affected).toHaveLength(1);
    expect(result.affected[0].is_test).toBe(true);
    // All affected are test files → severity is contained
    expect(result.summary.severity).toBe('contained');
  });

  it('populates in_degree from file_edges for each affected file', () => {
    // Set up callerFile as a hub: 3 other files also import it (in_degree = 3 for callerFile)
    const seedFile = store.upsertFile(
      makeFileRow({ path: 'src/seed.ts', layer: 'domain' }),
    );
    const callerFile = store.upsertFile(
      makeFileRow({ path: 'src/hub.ts', layer: 'domain' }),
    );
    const otherA = store.upsertFile(
      makeFileRow({ path: 'src/other-a.ts', layer: 'api' }),
    );
    const otherB = store.upsertFile(
      makeFileRow({ path: 'src/other-b.ts', layer: 'api' }),
    );
    const otherC = store.upsertFile(
      makeFileRow({ path: 'src/other-c.ts', layer: 'api' }),
    );

    // callerFile imports seed (so hub is in blast radius of seed)
    store.insertFileEdge({
      source_file_id: callerFile.file_id!,
      target_file_id: seedFile.file_id!,
      edge_type: 'imports',
      confidence: 1.0,
      evidence: null,
      relation: null,
    });
    // 3 other files import callerFile (raises callerFile's in_degree to 3)
    for (const other of [otherA, otherB, otherC]) {
      store.insertFileEdge({
        source_file_id: other.file_id!,
        target_file_id: callerFile.file_id!,
        edge_type: 'imports',
        confidence: 1.0,
        evidence: null,
        relation: null,
      });
    }

    const result = computeUnifiedBlastRadius(db, 'src/seed.ts', { maxDepth: 1 });

    expect(result.affected).toHaveLength(1);
    expect(result.affected[0].path).toBe('src/hub.ts');
    expect(result.affected[0].in_degree).toBe(3);
  });

  it('returns correct seed_layer in the report', () => {
    store.upsertFile(makeFileRow({ path: 'src/tool.ts', layer: 'api' }));
    const result = computeUnifiedBlastRadius(db, 'src/tool.ts');
    expect(result.seed_layer).toBe('api');
  });

  // ── Reverse-deps fallback (markdown / doc files) ────────────────────────

  describe('reverse-deps.json fallback', () => {
    let projectDir: string;

    function writeReverseDeps(dir: string, data: Record<string, string[]>): void {
      const canonDir = join(dir, '.canon');
      mkdirSync(canonDir, { recursive: true });
      writeFileSync(join(canonDir, 'reverse-deps.json'), JSON.stringify(data));
    }

    beforeEach(() => {
      projectDir = mkdtempSync(join(tmpdir(), 'kg-br-test-'));
    });

    it('populates affected from reverse-deps.json when KG has no edges for a markdown file', () => {
      // Seed: a template markdown file with no KG edges
      store.upsertFile(
        makeFileRow({ path: 'templates/my-template.md', layer: 'templates', language: 'markdown' }),
      );
      // Dependents (flow files) are also in the KG
      const flowA = store.upsertFile(
        makeFileRow({ path: 'flows/flow-a.md', layer: 'flows', language: 'markdown' }),
      );
      const flowB = store.upsertFile(
        makeFileRow({ path: 'flows/flow-b.md', layer: 'flows', language: 'markdown' }),
      );
      // No file_edges or entity edges exist

      writeReverseDeps(projectDir, {
        'templates/my-template.md': ['flows/flow-a.md', 'flows/flow-b.md'],
      });

      const result = computeUnifiedBlastRadius(db, 'templates/my-template.md', {
        maxDepth: 2,
        projectDir,
      });

      expect(result.affected).toHaveLength(2);
      const paths = result.affected.map((f) => f.path).sort();
      expect(paths).toEqual(['flows/flow-a.md', 'flows/flow-b.md']);
      expect(result.affected.every((f) => f.depth === 1)).toBe(true);
      expect(result.affected.every((f) => f.relationship === 'reverse-dep')).toBe(true);
    });

    it('classifies cross-layer blast radius correctly from reverse-deps fallback', () => {
      // Template in 'templates' layer, dependents in 'flows' layer — cross-layer
      store.upsertFile(
        makeFileRow({ path: 'templates/my-template.md', layer: 'templates', language: 'markdown' }),
      );
      store.upsertFile(
        makeFileRow({ path: 'flows/flow-a.md', layer: 'flows', language: 'markdown' }),
      );
      store.upsertFile(
        makeFileRow({ path: 'flows/flow-b.md', layer: 'flows', language: 'markdown' }),
      );
      store.upsertFile(
        makeFileRow({ path: 'flows/flow-c.md', layer: 'flows', language: 'markdown' }),
      );
      store.upsertFile(
        makeFileRow({ path: 'flows/flow-d.md', layer: 'flows', language: 'markdown' }),
      );
      store.upsertFile(
        makeFileRow({ path: 'flows/flow-e.md', layer: 'flows', language: 'markdown' }),
      );

      writeReverseDeps(projectDir, {
        'templates/my-template.md': [
          'flows/flow-a.md',
          'flows/flow-b.md',
          'flows/flow-c.md',
          'flows/flow-d.md',
          'flows/flow-e.md',
        ],
      });

      const result = computeUnifiedBlastRadius(db, 'templates/my-template.md', {
        maxDepth: 2,
        projectDir,
      });

      expect(result.affected).toHaveLength(5);
      // All dependents are in 'flows' layer, seed is in 'templates' — all cross-layer
      expect(result.summary.cross_layer_count).toBe(5);
      // 5 cross-layer files → moderate or higher
      expect(['moderate', 'high', 'critical']).toContain(result.summary.severity);
      expect(result.summary.severity).not.toBe('contained');
    });

    it('does NOT use reverse-deps fallback when KG already has file edges', () => {
      // When KG has edges, the fallback must not be triggered
      const seedFile = store.upsertFile(
        makeFileRow({ path: 'templates/linked.md', layer: 'templates', language: 'markdown' }),
      );
      const depFile = store.upsertFile(
        makeFileRow({ path: 'flows/real-dep.md', layer: 'flows', language: 'markdown' }),
      );
      // KG edge exists
      store.insertFileEdge({
        source_file_id: depFile.file_id!,
        target_file_id: seedFile.file_id!,
        edge_type: 'imports',
        confidence: 1.0,
        evidence: null,
        relation: null,
      });
      // reverse-deps lists a DIFFERENT file — if fallback triggers, both would appear
      writeReverseDeps(projectDir, {
        'templates/linked.md': ['flows/fallback-only.md'],
      });

      const result = computeUnifiedBlastRadius(db, 'templates/linked.md', {
        maxDepth: 2,
        projectDir,
      });

      // Should only include the KG edge, not the fallback
      expect(result.affected).toHaveLength(1);
      expect(result.affected[0].path).toBe('flows/real-dep.md');
    });

    it('handles missing projectDir gracefully — returns contained when no KG edges', () => {
      store.upsertFile(
        makeFileRow({ path: 'templates/no-fallback.md', layer: 'templates', language: 'markdown' }),
      );
      // No projectDir → no fallback; no KG edges → contained
      const result = computeUnifiedBlastRadius(db, 'templates/no-fallback.md');
      expect(result.summary.severity).toBe('contained');
      expect(result.affected).toHaveLength(0);
    });

    it('handles nonexistent reverse-deps.json gracefully', () => {
      store.upsertFile(
        makeFileRow({ path: 'templates/no-rdeps.md', layer: 'templates', language: 'markdown' }),
      );
      // projectDir provided but no reverse-deps.json file exists
      const result = computeUnifiedBlastRadius(db, 'templates/no-rdeps.md', {
        projectDir,
      });
      expect(result.summary.severity).toBe('contained');
      expect(result.affected).toHaveLength(0);
    });

    it('synthesizes entries for dependents not in the KG', () => {
      store.upsertFile(
        makeFileRow({ path: 'templates/my-template.md', layer: 'templates', language: 'markdown' }),
      );
      // Dependent file NOT in the KG store
      writeReverseDeps(projectDir, {
        'templates/my-template.md': ['flows/unindexed-flow.md'],
      });

      const result = computeUnifiedBlastRadius(db, 'templates/my-template.md', {
        maxDepth: 2,
        projectDir,
      });

      expect(result.affected).toHaveLength(1);
      expect(result.affected[0].path).toBe('flows/unindexed-flow.md');
      expect(result.affected[0].depth).toBe(1);
      // in_degree should be 0 (no KG data)
      expect(result.affected[0].in_degree).toBe(0);
    });
  });
});
