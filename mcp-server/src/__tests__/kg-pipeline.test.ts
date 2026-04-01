/**
 * Knowledge Graph Pipeline Tests
 *
 * Integration-style tests using a temp directory on disk and in-memory SQLite.
 * We write real files, run the pipeline, and verify the DB state.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { reindexFile, runPipeline } from "../graph/kg-pipeline.ts";
import { initDatabase } from "../graph/kg-schema.ts";
import { KgStore } from "../graph/kg-store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempProject(): string {
  return mkdtempSync(path.join(tmpdir(), "kg-pipeline-test-"));
}

function writeFile(projectDir: string, relPath: string, content: string): void {
  const absPath = path.join(projectDir, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf8");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runPipeline", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempProject();
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("returns PipelineResult with correct shape", async () => {
    writeFile(projectDir, "src/hello.ts", "export function hello() {}");

    const dbPath = path.join(projectDir, "test.db");
    const result = await runPipeline(projectDir, { dbPath, incremental: false });

    expect(result).toMatchObject({
      filesScanned: expect.any(Number),
      filesUpdated: expect.any(Number),
      entitiesTotal: expect.any(Number),
      edgesTotal: expect.any(Number),
      durationMs: expect.any(Number),
    });
    expect(result.filesScanned).toBeGreaterThan(0);
    expect(result.filesUpdated).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("inserts a file row into the files table", async () => {
    writeFile(projectDir, "src/foo.ts", "export const x = 1;");

    const dbPath = path.join(projectDir, "test.db");
    await runPipeline(projectDir, { dbPath, incremental: false });

    const db = new Database(dbPath);
    const store = new KgStore(db);
    const fileRow = store.getFile("src/foo.ts");
    db.close();

    expect(fileRow).toBeDefined();
    expect(fileRow?.path).toBe("src/foo.ts");
    expect(fileRow?.language).toBe("typescript");
  });

  test("creates a bare file entity for each indexed file", async () => {
    writeFile(projectDir, "src/bar.ts", "// empty");

    const dbPath = path.join(projectDir, "test.db");
    await runPipeline(projectDir, { dbPath, incremental: false });

    const db = new Database(dbPath);
    const store = new KgStore(db);
    const fileRow = store.getFile("src/bar.ts");
    const entities = fileRow?.file_id ? store.getEntitiesByFile(fileRow.file_id as number) : [];
    db.close();

    const fileEntity = entities.find((e) => e.kind === "file");
    expect(fileEntity).toBeDefined();
    expect(fileEntity?.name).toBe("bar.ts");
  });

  test("handles adapter errors gracefully (bare file entity only)", async () => {
    // Write a file with content that might trip up a parser
    writeFile(projectDir, "src/broken.ts", "this is not valid typescript %%%");

    const dbPath = path.join(projectDir, "test.db");
    // Should not throw
    const result = await runPipeline(projectDir, { dbPath, incremental: false });
    expect(result.filesScanned).toBeGreaterThan(0);
  });

  test("incremental mode skips unchanged files on second run", async () => {
    writeFile(projectDir, "src/stable.ts", "export const a = 1;");

    const dbPath = path.join(projectDir, "test.db");

    // First run — indexes everything
    const result1 = await runPipeline(projectDir, { dbPath, incremental: true });
    expect(result1.filesUpdated).toBeGreaterThan(0);

    // Second run — mtime and hash unchanged, should skip
    const result2 = await runPipeline(projectDir, { dbPath, incremental: true });
    expect(result2.filesUpdated).toBe(0);
  });

  test("onProgress callback is called", async () => {
    writeFile(projectDir, "src/x.ts", "export const x = 1;");

    const dbPath = path.join(projectDir, "test.db");
    const phases: string[] = [];

    await runPipeline(projectDir, {
      dbPath,
      incremental: false,
      onProgress: (phase) => {
        phases.push(phase);
      },
    });

    expect(phases).toContain("scan");
    expect(phases).toContain("parse");
    expect(phases).toContain("resolve");
    expect(phases).toContain("canon-link");
  });

  test("creates file_edge for TypeScript import between two files", async () => {
    writeFile(projectDir, "src/a.ts", `export const A = 1;`);
    writeFile(projectDir, "src/b.ts", `import { A } from './a.ts';`);

    const dbPath = path.join(projectDir, "test.db");
    await runPipeline(projectDir, { dbPath, incremental: false });

    const db = new Database(dbPath);
    const store = new KgStore(db);
    const fileB = store.getFile("src/b.ts");
    const edges = fileB?.file_id ? store.getFileEdgesFrom(fileB.file_id as number) : [];
    db.close();

    // Should have an imports edge from b.ts → a.ts
    const importEdge = edges.find((e) => e.edge_type === "imports");
    expect(importEdge).toBeDefined();
  });

  test("works with an empty project directory", async () => {
    const dbPath = path.join(projectDir, "test.db");
    const result = await runPipeline(projectDir, { dbPath, incremental: false });
    expect(result.filesScanned).toBe(0);
    expect(result.filesUpdated).toBe(0);
    expect(result.entitiesTotal).toBe(0);
  });

  test("handles non-TS file types (markdown) without error", async () => {
    writeFile(projectDir, "README.md", "# Hello\nThis is a readme.");

    const dbPath = path.join(projectDir, "test.db");
    const result = await runPipeline(projectDir, { dbPath, incremental: false });
    expect(result.filesScanned).toBeGreaterThan(0);

    const db = new Database(dbPath);
    const store = new KgStore(db);
    const fileRow = store.getFile("README.md");
    db.close();

    expect(fileRow).toBeDefined();
    expect(fileRow?.language).toBe("markdown");
  });
});

describe("reindexFile", () => {
  let projectDir: string;
  let db: Database.Database;

  beforeEach(() => {
    projectDir = makeTempProject();
    db = initDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  test("indexes a new file and returns changed=true", async () => {
    writeFile(projectDir, "src/new.ts", "export function greet() {}");

    const result = await reindexFile(db, projectDir, "src/new.ts");
    expect(result.changed).toBe(true);
    expect(result.entitiesAfter).toBeGreaterThan(0);
  });

  test("returns changed=false for an unchanged file", async () => {
    writeFile(projectDir, "src/stable.ts", "export const x = 42;");

    // First index
    await reindexFile(db, projectDir, "src/stable.ts");

    // Second index — same content
    const result = await reindexFile(db, projectDir, "src/stable.ts");
    expect(result.changed).toBe(false);
  });

  test("returns changed=false gracefully when file does not exist", async () => {
    const result = await reindexFile(db, projectDir, "src/nonexistent.ts");
    expect(result.changed).toBe(false);
    expect(result.entitiesBefore).toBe(0);
    expect(result.entitiesAfter).toBe(0);
  });

  test("accepts absolute file paths", async () => {
    writeFile(projectDir, "src/abs.ts", "export const y = 99;");
    const absPath = path.join(projectDir, "src/abs.ts");

    const result = await reindexFile(db, projectDir, absPath);
    expect(result.changed).toBe(true);
  });

  test("re-parses and updates entities on content change", async () => {
    writeFile(projectDir, "src/change.ts", "export const a = 1;");
    await reindexFile(db, projectDir, "src/change.ts");

    // Overwrite with new content
    writeFile(projectDir, "src/change.ts", "export const a = 1;\nexport const b = 2;");

    const result = await reindexFile(db, projectDir, "src/change.ts");
    expect(result.changed).toBe(true);
  });
});
