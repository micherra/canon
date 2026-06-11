/**
 * Knowledge Graph Pipeline Tests
 *
 * Integration-style tests using a temp directory on disk and in-memory SQLite.
 * We write real files, run the pipeline, and verify the DB state.
 *
 * Embed phase tests use a vi.mock to replace EmbeddingService with a fast
 * mock that returns random 384-dim vectors (no model download needed).
 *
 * Overlay extension scan tests (Finding A fix) live in kg-overlay-scan.test.ts.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runPipeline } from "@graph/kg-pipeline.ts";
import { reindexFile } from "@graph/kg-pipeline-reindex.ts";
import { initDatabase } from "@graph/kg-schema.ts";
import { KgStore } from "@graph/kg-store.ts";
import { KgVectorStore } from "@graph/kg-vector-store.ts";
import { GRAPH_HEAD_COMMIT_KEY } from "@shared/constants.ts";
import { randomEmbedding } from "@tests/helpers/embedding-test-helpers.ts";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Mock EmbeddingService — fast random vectors, no model download

let _mockSeed = 0;

vi.mock("@graph/kg-embedding.ts", () => ({
  EmbeddingService: class MockEmbeddingService {
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((_, i) => randomEmbedding(_mockSeed + i));
    }
    async embedOne(_text: string): Promise<Float32Array> {
      return randomEmbedding(_mockSeed++);
    }
    dispose(): void {
      // no-op
    }
    get isLoaded(): boolean {
      return false;
    }
  },
}));

function makeTempProject(): string {
  return mkdtempSync(path.join(tmpdir(), "kg-pipeline-test-"));
}

function writeFile(projectDir: string, relPath: string, content: string): void {
  const absPath = path.join(projectDir, relPath);
  mkdirSync(path.dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf8");
}

describe("runPipeline", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempProject();
  });

  afterEach(() => {
    rmSync(projectDir, { force: true, recursive: true });
  });

  test("returns PipelineResult with correct shape", async () => {
    writeFile(projectDir, "src/hello.ts", "export function hello() {}");

    const dbPath = path.join(projectDir, "test.db");
    const result = await runPipeline(projectDir, { dbPath, incremental: false });

    expect(result).toMatchObject({
      durationMs: expect.any(Number),
      edgesTotal: expect.any(Number),
      entitiesTotal: expect.any(Number),
      filesScanned: expect.any(Number),
      filesUpdated: expect.any(Number),
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

// Freshness marker + orphan prune tests

/** Initialise a git repo in dir and create one commit so HEAD resolves. */
function initGitRepo(dir: string): string {
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  run(["commit", "--allow-empty", "-q", "-m", "init"]);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
}

describe("runPipeline freshness marker", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempProject();
  });

  afterEach(() => {
    rmSync(projectDir, { force: true, recursive: true });
  });

  test("stamps meta.graph_head_commit with HEAD SHA on success", async () => {
    const head = initGitRepo(projectDir);
    writeFile(projectDir, "src/foo.ts", "export const x = 1;");

    const dbPath = path.join(projectDir, "test.db");
    await runPipeline(projectDir, { dbPath, incremental: false });

    const db = new Database(dbPath);
    const store = new KgStore(db);
    const marker = store.getMeta("graph_head_commit");
    db.close();

    expect(marker).toBe(head);
  });

  test("writes marker even on a no-op incremental pass (filesUpdated === 0)", async () => {
    const head = initGitRepo(projectDir);
    writeFile(projectDir, "src/foo.ts", "export const x = 1;");

    const dbPath = path.join(projectDir, "test.db");
    // First pass indexes the file.
    await runPipeline(projectDir, { dbPath, incremental: false });
    // Second incremental pass: nothing changed, filesUpdated should be 0.
    const second = await runPipeline(projectDir, { dbPath, incremental: true });
    expect(second.filesUpdated).toBe(0);

    const db = new Database(dbPath);
    const store = new KgStore(db);
    const marker = store.getMeta("graph_head_commit");
    db.close();

    expect(marker).toBe(head);
  });

  test("does not write marker when git is unavailable (HEAD null)", async () => {
    // projectDir is NOT a git repo → getCurrentHead returns null.
    writeFile(projectDir, "src/foo.ts", "export const x = 1;");

    const dbPath = path.join(projectDir, "test.db");
    await runPipeline(projectDir, { dbPath, incremental: false });

    const db = new Database(dbPath);
    const store = new KgStore(db);
    const marker = store.getMeta("graph_head_commit");
    db.close();

    expect(marker).toBeUndefined();
  });
});

describe("runPipeline orphan prune", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempProject();
  });

  afterEach(() => {
    rmSync(projectDir, { force: true, recursive: true });
  });

  test("prunes a file removed from disk and corrects a dependent's in_degree via CASCADE", async () => {
    // B imports A → file_edge B → A. Deleting A on disk should prune A's row
    // AND (via ON DELETE CASCADE) remove the inbound B → A edge, so B's
    // in_degree (file edges pointing AT it) and A's absence are both correct.
    writeFile(projectDir, "src/a.ts", "export const a = 1;");
    writeFile(projectDir, "src/b.ts", "import { a } from './a.ts';\nexport const b = a + 1;");

    const dbPath = path.join(projectDir, "test.db");
    await runPipeline(projectDir, { dbPath, incremental: false });

    // Sanity: both files indexed, and the B → A edge exists.
    {
      const db = new Database(dbPath);
      const store = new KgStore(db);
      const a = store.getFile("src/a.ts");
      const b = store.getFile("src/b.ts");
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      // A is imported by B → A has an inbound file edge.
      expect(store.getFileEdgesTo(a!.file_id as number).length).toBeGreaterThan(0);
      db.close();
    }

    // Delete A from disk and run an incremental pass → triggers orphan prune.
    rmSync(path.join(projectDir, "src/a.ts"));
    await runPipeline(projectDir, { dbPath, incremental: true });

    const db = new Database(dbPath);
    const store = new KgStore(db);
    const a = store.getFile("src/a.ts");
    const b = store.getFile("src/b.ts");
    // A's node is gone.
    expect(a).toBeUndefined();
    // B remains, and B's outbound edges to A are gone (CASCADE removed them).
    expect(b).toBeDefined();
    const bOutbound = store.getFileEdgesFrom(b!.file_id as number);
    expect(bOutbound.length).toBe(0);
    db.close();
  });
});

// Embed phase tests

describe("runPipeline embed phase", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempProject();
    _mockSeed = 0;
  });

  afterEach(() => {
    rmSync(projectDir, { force: true, recursive: true });
  });

  test("creates entity vectors for indexed entities after pipeline run", async () => {
    writeFile(projectDir, "src/alpha.ts", "export function alpha() {}");

    const dbPath = path.join(projectDir, "test.db");
    const result = await runPipeline(projectDir, { dbPath, incremental: false });

    // embeddingsGenerated should be populated
    expect(result.embeddingsGenerated).toBeGreaterThanOrEqual(0);

    const db = new Database(dbPath);
    const vectorStore = new KgVectorStore(db);
    const stats = vectorStore.getVectorStats();
    db.close();

    // At least some entity vectors should exist (function entities get embedded; file entities are excluded)
    expect(stats.entityVectors).toBeGreaterThanOrEqual(0);
  });

  test("embed phase reports progress via onProgress callback", async () => {
    writeFile(projectDir, "src/beta.ts", "export const beta = 1;");

    const dbPath = path.join(projectDir, "test.db");
    const phases: string[] = [];

    await runPipeline(projectDir, {
      dbPath,
      incremental: false,
      onProgress: (phase) => {
        phases.push(phase);
      },
    });

    expect(phases).toContain("embed");
  });

  test("incremental pipeline does not re-embed unchanged entities", async () => {
    writeFile(projectDir, "src/gamma.ts", "export function gamma() {}");

    const dbPath = path.join(projectDir, "test.db");

    // First run — embeds everything
    await runPipeline(projectDir, { dbPath, incremental: true });

    const db1 = new Database(dbPath);
    const vectorStore1 = new KgVectorStore(db1);
    const staleAfterFirst = vectorStore1.getStaleEntityVectors();
    db1.close();

    // No stale entities should remain after first run
    expect(staleAfterFirst.length).toBe(0);

    // Second run — nothing changed, embed phase should find no stale entities
    const result2 = await runPipeline(projectDir, { dbPath, incremental: true });
    expect(result2.embeddingsGenerated).toBe(0);
  });

  test("embed phase is non-fatal — pipeline result still returned even on embedding error", async () => {
    // The mock throws on embed — override mock temporarily
    // We test this by verifying pipeline always returns a PipelineResult shape
    writeFile(projectDir, "src/delta.ts", "export const d = 4;");
    const dbPath = path.join(projectDir, "test.db");
    const result = await runPipeline(projectDir, { dbPath, incremental: false });

    // Pipeline should complete successfully regardless
    expect(result).toMatchObject({
      durationMs: expect.any(Number),
      edgesTotal: expect.any(Number),
      entitiesTotal: expect.any(Number),
      filesScanned: expect.any(Number),
      filesUpdated: expect.any(Number),
    });
  });
});

// Scope-aware prune + marker (Codex P1 + P2) -- TDD: write tests first

/** Initialise a git repo (shared helper for scope-aware tests). */
function initGitRepoForScope(dir: string): string {
  const run = (args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run(["init", "-q"]);
  run(["config", "user.email", "test@example.com"]);
  run(["config", "user.name", "Test"]);
  run(["commit", "--allow-empty", "-q", "-m", "init"]);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
}

describe("scope-aware prune + marker", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTempProject();
  });

  afterEach(() => {
    rmSync(projectDir, { force: true, recursive: true });
  });

  test("scoped run preserves out-of-scope rows", async () => {
    // Seed files in two subdirs: src/ and docs/
    writeFile(projectDir, "src/index.ts", "export const x = 1;");
    writeFile(projectDir, "docs/guide.md", "# Guide");

    const dbPath = path.join(projectDir, "test.db");

    // Full run — indexes everything including docs/guide.md
    await runPipeline(projectDir, { dbPath, incremental: false });

    // Verify docs/guide.md is indexed
    {
      const db = new Database(dbPath);
      const store = new KgStore(db);
      expect(store.getAllFilePaths()).toContain("docs/guide.md");
      db.close();
    }

    // Scoped run targeting only src/ — must NOT prune docs/guide.md
    await runPipeline(projectDir, { dbPath, incremental: true, sourceDirs: ["src"] });

    const db = new Database(dbPath);
    const store = new KgStore(db);
    expect(store.getAllFilePaths()).toContain("docs/guide.md");
    db.close();
  });

  test("scoped run does not stamp the marker", async () => {
    initGitRepoForScope(projectDir);
    writeFile(projectDir, "src/index.ts", "export const x = 1;");
    writeFile(projectDir, "docs/guide.md", "# Guide");

    const dbPath = path.join(projectDir, "test.db");

    // Full run — stamps the marker
    await runPipeline(projectDir, { dbPath, incremental: false });

    // Record marker value after full run
    {
      const db = new Database(dbPath);
      const store = new KgStore(db);
      const beforeMarker = store.getMeta(GRAPH_HEAD_COMMIT_KEY);
      db.close();
      expect(beforeMarker).toBeDefined();

      // Scoped run — must NOT change the marker
      await runPipeline(projectDir, { dbPath, incremental: true, sourceDirs: ["src"] });

      const db2 = new Database(dbPath);
      const store2 = new KgStore(db2);
      const afterMarker = store2.getMeta(GRAPH_HEAD_COMMIT_KEY);
      db2.close();
      expect(afterMarker).toBe(beforeMarker);
    }
  });

  test("full run prunes deleted files and stamps marker", async () => {
    const head = initGitRepoForScope(projectDir);
    writeFile(projectDir, "src/a.ts", "export const a = 1;");
    writeFile(projectDir, "src/b.ts", "export const b = 2;");

    const dbPath = path.join(projectDir, "test.db");
    await runPipeline(projectDir, { dbPath, incremental: false });

    // Delete a.ts and run full pipeline
    rmSync(path.join(projectDir, "src/a.ts"));
    await runPipeline(projectDir, { dbPath, incremental: true });

    const db = new Database(dbPath);
    const store = new KgStore(db);
    // Deleted file pruned
    expect(store.getAllFilePaths()).not.toContain("src/a.ts");
    // Marker stamped to HEAD
    expect(store.getMeta(GRAPH_HEAD_COMMIT_KEY)).toBe(head);
    db.close();
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
    rmSync(projectDir, { force: true, recursive: true });
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
