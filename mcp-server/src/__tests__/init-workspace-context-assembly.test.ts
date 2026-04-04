/**
 * Tests for init-workspace.ts — project_structure and conventions context assembly.
 *
 * Covers ctx-02 task requirements:
 * - Workspace init with a mock KG DB produces cache prefix containing "Project Structure"
 * - Workspace init without KG DB still succeeds (graceful degradation)
 * - Workspace init with .canon/CONVENTIONS.md present includes conventions in cache prefix
 * - Workspace init without .canon/CONVENTIONS.md still succeeds
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock loadAndResolveFlow to avoid needing real flow files
vi.mock("../orchestration/flow-parser.ts", () => ({
  loadAndResolveFlow: vi.fn().mockResolvedValue({
    description: "test",
    entry: "build",
    name: "fast-path",
    spawn_instructions: {},
    states: {
      build: { transitions: { done: "done" }, type: "single" },
      done: { type: "terminal" },
    },
  }),
}));

import { getExecutionStore } from "../orchestration/execution-store.ts";
import { initWorkspaceFlow } from "../tools/init-workspace.ts";

let tmpDirs: string[] = [];

function makeTmpProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "init-ws-ctx-test-"));
  tmpDirs.push(dir);
  return dir;
}

function seedKgDb(projectDir: string): void {
  // Create the KG DB directory
  const canonDir = join(projectDir, ".canon");
  mkdirSync(canonDir, { recursive: true });
  const dbPath = join(canonDir, "knowledge-graph.db");

  // Import inline to avoid top-level import issues
  const { initDatabase } = require("../graph/kg-schema.ts");
  const db = initDatabase(dbPath);

  // Insert some test files with different layers
  const now = Date.now();
  const insertFile = db.prepare(`
    INSERT INTO files (path, mtime_ms, content_hash, language, layer, last_indexed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  // api layer: 2 files
  const apiFile1Id = (
    insertFile.run("src/api/index.ts", now, "h1", "typescript", "api", now) as {
      lastInsertRowid: number;
    }
  ).lastInsertRowid;
  const apiFile2Id = (
    insertFile.run("src/api/router.ts", now, "h2", "typescript", "api", now) as {
      lastInsertRowid: number;
    }
  ).lastInsertRowid;
  // domain layer: 3 files
  const domainFile1Id = (
    insertFile.run("src/domain/user.ts", now, "h3", "typescript", "domain", now) as {
      lastInsertRowid: number;
    }
  ).lastInsertRowid;
  const domainFile2Id = (
    insertFile.run("src/domain/order.ts", now, "h4", "typescript", "domain", now) as {
      lastInsertRowid: number;
    }
  ).lastInsertRowid;
  const domainFile3Id = (
    insertFile.run("src/domain/product.ts", now, "h5", "typescript", "domain", now) as {
      lastInsertRowid: number;
    }
  ).lastInsertRowid;
  // shared layer: 1 file
  const sharedFile1Id = (
    insertFile.run("src/shared/utils.ts", now, "h6", "typescript", "shared", now) as {
      lastInsertRowid: number;
    }
  ).lastInsertRowid;

  // Insert file_edges so degrees are computed
  // shared/utils.ts is imported by all other files → high in_degree (5)
  const insertEdge = db.prepare(`
    INSERT OR IGNORE INTO file_edges (source_file_id, target_file_id, edge_type, confidence)
    VALUES (?, ?, 'imports', 1.0)
  `);
  insertEdge.run(apiFile1Id, sharedFile1Id);
  insertEdge.run(apiFile2Id, sharedFile1Id);
  insertEdge.run(domainFile1Id, sharedFile1Id);
  insertEdge.run(domainFile2Id, sharedFile1Id);
  insertEdge.run(domainFile3Id, sharedFile1Id);
  // api/index.ts imports api/router.ts → router.ts has in_degree 1
  insertEdge.run(apiFile1Id, apiFile2Id);

  db.close();
}

afterEach(() => {
  for (const dir of tmpDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
  tmpDirs = [];
});

const baseInput = {
  base_commit: "abc123",
  branch: "main",
  flow_name: "fast-path",
  task: "test context assembly",
  tier: "small" as const,
};

// project_structure — KG DB present

describe("initWorkspaceFlow — project_structure in cache prefix", () => {
  it("cache prefix contains '## Project Structure' when KG DB exists", async () => {
    const projectDir = makeTmpProjectDir();
    seedKgDb(projectDir);

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");
    expect(result.created).toBe(true);

    const store = getExecutionStore(result.workspace);
    const cachePrefix = store.getCachePrefix();
    expect(cachePrefix).toContain("## Project Structure");
  });

  it("cache prefix contains layer breakdown when KG DB exists", async () => {
    const projectDir = makeTmpProjectDir();
    seedKgDb(projectDir);

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    const store = getExecutionStore(result.workspace);
    const cachePrefix = store.getCachePrefix();
    expect(cachePrefix).toContain("Layers:");
  });

  it("cache prefix lists hub files when KG DB has file_edges", async () => {
    const projectDir = makeTmpProjectDir();
    seedKgDb(projectDir);

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    const store = getExecutionStore(result.workspace);
    const cachePrefix = store.getCachePrefix();
    // shared/utils.ts has the highest in_degree (5), should appear in hub list
    expect(cachePrefix).toContain("Hub files");
    expect(cachePrefix).toContain("shared/utils.ts");
  });

  it("cache prefix contains total file count when KG DB exists", async () => {
    const projectDir = makeTmpProjectDir();
    seedKgDb(projectDir);

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    const store = getExecutionStore(result.workspace);
    const cachePrefix = store.getCachePrefix();
    expect(cachePrefix).toContain("Total files in graph: 6");
  });
});

// project_structure — graceful degradation (no KG DB)

describe("initWorkspaceFlow — project_structure graceful degradation", () => {
  it("succeeds without KG DB (no project_structure section)", async () => {
    const projectDir = makeTmpProjectDir();
    // No KG DB seeded

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");
    expect(result.created).toBe(true);

    const store = getExecutionStore(result.workspace);
    const cachePrefix = store.getCachePrefix();
    // Should succeed — cache prefix exists but doesn't need project_structure
    expect(cachePrefix).toBeTruthy();
    // project_structure section should be absent or empty when no KG DB
    // (it may be present as empty, or absent entirely — either is valid)
  });

  it("result.created is true even when KG DB is missing", async () => {
    const projectDir = makeTmpProjectDir();

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");
    expect(result.created).toBe(true);
    expect(result.workspace).toBeTruthy();
  });
});

// conventions — CONVENTIONS.md present

describe("initWorkspaceFlow — conventions in cache prefix", () => {
  it("cache prefix contains '## Conventions' when .canon/CONVENTIONS.md exists", async () => {
    const projectDir = makeTmpProjectDir();
    const canonDir = join(projectDir, ".canon");
    mkdirSync(canonDir, { recursive: true });
    writeFileSync(
      join(canonDir, "CONVENTIONS.md"),
      "# Project Conventions\n\nUse TypeScript strict mode.",
    );

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");
    expect(result.created).toBe(true);

    const store = getExecutionStore(result.workspace);
    const cachePrefix = store.getCachePrefix();
    expect(cachePrefix).toContain("## Conventions");
    expect(cachePrefix).toContain("Use TypeScript strict mode.");
  });

  it("cache prefix includes full CONVENTIONS.md content", async () => {
    const projectDir = makeTmpProjectDir();
    const canonDir = join(projectDir, ".canon");
    mkdirSync(canonDir, { recursive: true });
    const conventionsContent = "## Test Conventions\n\n- Always write tests first.\n- Use vitest.";
    writeFileSync(join(canonDir, "CONVENTIONS.md"), conventionsContent);

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    const store = getExecutionStore(result.workspace);
    const cachePrefix = store.getCachePrefix();
    expect(cachePrefix).toContain("Always write tests first.");
    expect(cachePrefix).toContain("Use vitest.");
  });
});

// conventions — graceful degradation (no CONVENTIONS.md)

describe("initWorkspaceFlow — conventions graceful degradation", () => {
  it("succeeds without CONVENTIONS.md", async () => {
    const projectDir = makeTmpProjectDir();
    // No .canon/CONVENTIONS.md

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");
    expect(result.created).toBe(true);
  });

  it("cache prefix is valid even without CONVENTIONS.md", async () => {
    const projectDir = makeTmpProjectDir();

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    const store = getExecutionStore(result.workspace);
    const cachePrefix = store.getCachePrefix();
    expect(cachePrefix).toBeTruthy();
    expect(cachePrefix).toContain("## Workspace");
  });
});

// Both KG DB and CONVENTIONS.md present

describe("initWorkspaceFlow — both project_structure and conventions present", () => {
  it("cache prefix contains both sections when both exist", async () => {
    const projectDir = makeTmpProjectDir();
    seedKgDb(projectDir);
    writeFileSync(join(projectDir, ".canon", "CONVENTIONS.md"), "## Conventions\n\nTDD always.");

    const result = await initWorkspaceFlow(baseInput, projectDir, "/fake/plugin");

    const store = getExecutionStore(result.workspace);
    const cachePrefix = store.getCachePrefix();
    expect(cachePrefix).toContain("## Project Structure");
    expect(cachePrefix).toContain("## Conventions");
    expect(cachePrefix).toContain("TDD always.");
  });
});
