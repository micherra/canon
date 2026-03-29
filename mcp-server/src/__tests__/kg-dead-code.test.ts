/**
 * Dead Code Detection Tests
 *
 * Uses in-memory SQLite (:memory:) for speed and isolation.
 * Each describe block gets a fresh DB via beforeEach.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../graph/kg-schema.ts';
import { KgStore } from '../graph/kg-store.ts';
import { detectDeadCode } from '../graph/kg-dead-code.ts';
import type { FileRow, EntityRow } from '../graph/kg-types.ts';

// ---------------------------------------------------------------------------
// Test helpers
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
// detectDeadCode tests
// ---------------------------------------------------------------------------

describe('detectDeadCode', () => {
  let db: Database.Database;
  let store: KgStore;

  beforeEach(() => {
    db = initDatabase(':memory:');
    store = new KgStore(db);
  });

  afterEach(() => {
    store.close();
  });

  // ---- Happy path ----

  test('returns empty report when database is empty', () => {
    const report = detectDeadCode(db);
    expect(report.total_dead).toBe(0);
    expect(report.by_kind).toEqual({});
    expect(report.by_file).toEqual([]);
  });

  test('detects an unexported unreferenced function as dead', () => {
    const file = store.upsertFile(makeFileRow({ path: 'src/utils.ts' }));
    store.insertEntity(
      makeEntityRow(file.file_id!, {
        name: 'deadHelper',
        qualified_name: 'src/utils.ts::deadHelper',
        is_exported: false,
      }),
    );

    const report = detectDeadCode(db);

    expect(report.total_dead).toBe(1);
    expect(report.by_kind).toEqual({ function: 1 });
    expect(report.by_file).toHaveLength(1);
    expect(report.by_file[0]!.path).toBe('src/utils.ts');
    expect(report.by_file[0]!.entities[0]!.name).toBe('deadHelper');
    expect(report.by_file[0]!.entities[0]!.confidence).toBe(0.9);
    expect(report.by_file[0]!.entities[0]!.reason).toBe('unexported and unreferenced');
  });

  test('does not flag an unexported entity that is referenced via calls edge', () => {
    const fileA = store.upsertFile(makeFileRow({ path: 'src/A.ts' }));
    const fileB = store.upsertFile(makeFileRow({ path: 'src/B.ts' }));

    const caller = store.insertEntity(
      makeEntityRow(fileA.file_id!, {
        name: 'caller',
        qualified_name: 'src/A.ts::caller',
        is_exported: true,
      }),
    );
    const callee = store.insertEntity(
      makeEntityRow(fileB.file_id!, {
        name: 'helper',
        qualified_name: 'src/B.ts::helper',
        is_exported: false,
      }),
    );

    store.insertEdge({
      source_entity_id: caller.entity_id!,
      target_entity_id: callee.entity_id!,
      edge_type: 'calls',
      confidence: 1.0,
      metadata: null,
    });

    const report = detectDeadCode(db);
    const deadNames = report.by_file.flatMap((f) => f.entities.map((e) => e.name));
    expect(deadNames).not.toContain('helper');
  });

  test('does not flag exported entities', () => {
    const file = store.upsertFile(makeFileRow({ path: 'src/api.ts' }));
    store.insertEntity(
      makeEntityRow(file.file_id!, {
        name: 'publicFunc',
        qualified_name: 'src/api.ts::publicFunc',
        is_exported: true,
      }),
    );

    const report = detectDeadCode(db);
    expect(report.total_dead).toBe(0);
  });

  test('does not flag file-kind entities', () => {
    const file = store.upsertFile(makeFileRow({ path: 'src/module.ts' }));
    store.insertEntity(
      makeEntityRow(file.file_id!, {
        name: 'src/module.ts',
        qualified_name: 'src/module.ts',
        kind: 'file',
        is_exported: false,
      }),
    );

    const report = detectDeadCode(db);
    expect(report.total_dead).toBe(0);
  });

  test('does not flag property-kind entities', () => {
    const file = store.upsertFile(makeFileRow({ path: 'src/types.ts' }));
    store.insertEntity(
      makeEntityRow(file.file_id!, {
        name: 'myProp',
        qualified_name: 'src/types.ts::MyClass::myProp',
        kind: 'property',
        is_exported: false,
      }),
    );

    const report = detectDeadCode(db);
    expect(report.total_dead).toBe(0);
  });

  // ---- Entry-point exclusions ----

  test('excludes entities in index.ts (entry point)', () => {
    const file = store.upsertFile(makeFileRow({ path: 'src/index.ts' }));
    store.insertEntity(
      makeEntityRow(file.file_id!, {
        name: 'setup',
        qualified_name: 'src/index.ts::setup',
        is_exported: false,
      }),
    );

    const report = detectDeadCode(db);
    expect(report.total_dead).toBe(0);
  });

  test('excludes entities in main.ts (entry point)', () => {
    const file = store.upsertFile(makeFileRow({ path: 'src/main.ts' }));
    store.insertEntity(
      makeEntityRow(file.file_id!, {
        name: 'bootstrap',
        qualified_name: 'src/main.ts::bootstrap',
        is_exported: false,
      }),
    );

    const report = detectDeadCode(db);
    expect(report.total_dead).toBe(0);
  });

  // ---- Test file exclusion ----

  test('excludes test file entities by default', () => {
    const file = store.upsertFile(makeFileRow({ path: 'src/__tests__/utils.test.ts' }));
    store.insertEntity(
      makeEntityRow(file.file_id!, {
        name: 'helper',
        qualified_name: 'src/__tests__/utils.test.ts::helper',
        is_exported: false,
      }),
    );

    const report = detectDeadCode(db);
    expect(report.total_dead).toBe(0);
  });

  test('includes test file entities when includeTests is true', () => {
    const file = store.upsertFile(makeFileRow({ path: 'src/__tests__/utils.test.ts' }));
    store.insertEntity(
      makeEntityRow(file.file_id!, {
        name: 'helper',
        qualified_name: 'src/__tests__/utils.test.ts::helper',
        is_exported: false,
      }),
    );

    const report = detectDeadCode(db, { includeTests: true });
    // Test file entity may appear as dead (unless it matches an entry point, which it doesn't)
    const deadNames = report.by_file.flatMap((f) => f.entities.map((e) => e.name));
    expect(deadNames).toContain('helper');
  });

  // ---- Confidence threshold ----

  test('respects minConfidence option to filter low-confidence results', () => {
    const file = store.upsertFile(makeFileRow({ path: 'src/helpers.ts' }));
    store.insertEntity(
      makeEntityRow(file.file_id!, {
        name: 'deadFunc',
        qualified_name: 'src/helpers.ts::deadFunc',
        is_exported: false,
      }),
    );

    // Confidence for unexported-unreferenced is 0.9 — threshold 0.95 should exclude it
    const reportExcludes = detectDeadCode(db, { minConfidence: 0.95 });
    expect(reportExcludes.total_dead).toBe(0);

    // Threshold 0.5 (default) should include it
    const reportIncludes = detectDeadCode(db, { minConfidence: 0.5 });
    expect(reportIncludes.total_dead).toBe(1);
  });

  // ---- by_kind aggregation ----

  test('aggregates by_kind correctly across multiple entities and kinds', () => {
    const file = store.upsertFile(makeFileRow({ path: 'src/module.ts' }));
    store.insertEntity(
      makeEntityRow(file.file_id!, {
        name: 'fn1',
        qualified_name: 'src/module.ts::fn1',
        kind: 'function',
        is_exported: false,
      }),
    );
    store.insertEntity(
      makeEntityRow(file.file_id!, {
        name: 'fn2',
        qualified_name: 'src/module.ts::fn2',
        kind: 'function',
        is_exported: false,
      }),
    );
    store.insertEntity(
      makeEntityRow(file.file_id!, {
        name: 'MyClass',
        qualified_name: 'src/module.ts::MyClass',
        kind: 'class',
        is_exported: false,
      }),
    );

    const report = detectDeadCode(db);
    expect(report.total_dead).toBe(3);
    expect(report.by_kind['function']).toBe(2);
    expect(report.by_kind['class']).toBe(1);
  });

  // ---- by_file sorting ----

  test('sorts by_file descending by entity count', () => {
    const fileA = store.upsertFile(makeFileRow({ path: 'src/A.ts' }));
    const fileB = store.upsertFile(makeFileRow({ path: 'src/B.ts' }));

    // fileB gets 3 dead entities, fileA gets 1
    store.insertEntity(
      makeEntityRow(fileA.file_id!, {
        name: 'fn1',
        qualified_name: 'src/A.ts::fn1',
        is_exported: false,
      }),
    );
    for (let i = 1; i <= 3; i++) {
      store.insertEntity(
        makeEntityRow(fileB.file_id!, {
          name: `fn${i}`,
          qualified_name: `src/B.ts::fn${i}`,
          is_exported: false,
        }),
      );
    }

    const report = detectDeadCode(db);
    expect(report.by_file[0]!.path).toBe('src/B.ts');
    expect(report.by_file[0]!.entities).toHaveLength(3);
    expect(report.by_file[1]!.path).toBe('src/A.ts');
    expect(report.by_file[1]!.entities).toHaveLength(1);
  });

  // ---- Type-reference and other edge types ----

  test('does not flag entity referenced via type-references edge', () => {
    const fileA = store.upsertFile(makeFileRow({ path: 'src/A.ts' }));
    const fileB = store.upsertFile(makeFileRow({ path: 'src/B.ts' }));

    const consumer = store.insertEntity(
      makeEntityRow(fileA.file_id!, {
        name: 'consumer',
        qualified_name: 'src/A.ts::consumer',
        is_exported: true,
      }),
    );
    const myType = store.insertEntity(
      makeEntityRow(fileB.file_id!, {
        name: 'MyType',
        qualified_name: 'src/B.ts::MyType',
        kind: 'type-alias',
        is_exported: false,
      }),
    );

    store.insertEdge({
      source_entity_id: consumer.entity_id!,
      target_entity_id: myType.entity_id!,
      edge_type: 'type-references',
      confidence: 1.0,
      metadata: null,
    });

    const report = detectDeadCode(db);
    const deadNames = report.by_file.flatMap((f) => f.entities.map((e) => e.name));
    expect(deadNames).not.toContain('MyType');
  });
});
