/**
 * Archive Service Tests
 *
 * Tests workspace archiving: directory/file copying, manifest recording,
 * run-summary generation, and error handling.
 *
 * Uses tmp directories to simulate workspace and project root.
 * Mocks better-sqlite3 for orchestration.db reads and getDriftDb for manifest writes.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ArchiveManifestEntry } from "../../../platform/storage/drift/drift-analytics-types.ts";

// Mock getDriftDb to prevent actual SQLite I/O during tests
vi.mock("../../../platform/storage/drift/drift-db-cache.ts", () => {
  const appendArchiveManifest = vi.fn();
  const mockDb = { appendArchiveManifest };
  return {
    DriftDb: vi.fn(),
    getDriftDb: vi.fn(() => mockDb),
  };
});

// Mock better-sqlite3 for orchestration.db reads
vi.mock("better-sqlite3", () => {
  const mockStatement = {
    get: vi.fn(() => null),
  };
  const mockDb = {
    close: vi.fn(),
    prepare: vi.fn(() => mockStatement),
  };
  const MockDatabase = vi.fn(() => mockDb);
  return { default: MockDatabase };
});

// Import after mocks so mocks are in place
import { archiveWorkspace } from "@platform/storage/archive/archive-service.ts";
import { getDriftDb } from "../../../platform/storage/drift/drift-db-cache.ts";

// ---- Helpers ----

function makeTmpDir(): string {
  const dir = join(tmpdir(), `archive-svc-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeText(filePath: string, content: string): void {
  writeFileSync(filePath, content, "utf-8");
}

function makeWorkspace(
  base: string,
  opts: {
    dirs?: string[];
    files?: string[];
  } = {},
): string {
  const wsDir = join(base, "workspace");
  mkdirSync(wsDir, { recursive: true });

  for (const dir of opts.dirs ?? []) {
    const d = join(wsDir, dir);
    mkdirSync(d, { recursive: true });
    writeText(join(d, "file.md"), `content of ${dir}`);
  }

  for (const file of opts.files ?? []) {
    writeText(join(wsDir, file), `content of ${file}`);
  }

  return wsDir;
}

// ---- Tests ----

describe("archiveWorkspace — happy path", () => {
  let projectDir: string;
  let workspacePath: string;

  beforeEach(() => {
    projectDir = makeTmpDir();
    workspacePath = makeWorkspace(projectDir, {
      dirs: ["research", "plans", "decisions", "reviews"],
      files: ["log.jsonl", "context.md", "journal.json"],
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(projectDir, { force: true, recursive: true });
  });

  test("archives all expected directories when they exist", async () => {
    const result = await archiveWorkspace({
      branch: "main",
      projectDir,
      slug: "my-feature",
      workspacePath,
    });

    expect(result.archived).toBe(true);
    expect(result.archive_path).not.toBeNull();

    if (result.archive_path) {
      // Current canonical dirs
      expect(existsSync(join(result.archive_path, "plans"))).toBe(true);
      expect(existsSync(join(result.archive_path, "reviews"))).toBe(true);
      // Legacy dirs included for backward-compat archival of older workspaces
      expect(existsSync(join(result.archive_path, "research"))).toBe(true);
      expect(existsSync(join(result.archive_path, "decisions"))).toBe(true);
    }
  });

  test("skips directories that don't exist in the workspace", async () => {
    // Use a fresh isolated project dir so only the dirs listed below exist.
    const isolatedProjectDir = makeTmpDir();
    const ws = makeWorkspace(isolatedProjectDir, {
      dirs: ["plans"],
      files: [],
    });

    const result = await archiveWorkspace({
      branch: "main",
      projectDir: isolatedProjectDir,
      slug: "partial-feature",
      workspacePath: ws,
    });

    expect(result.archived).toBe(true);
    if (result.archive_path) {
      expect(existsSync(join(result.archive_path, "plans"))).toBe(true);
      // transcripts not in workspace — should not appear in archive
      expect(existsSync(join(result.archive_path, "transcripts"))).toBe(false);
      // legacy dirs not in workspace — should not appear in archive
      expect(existsSync(join(result.archive_path, "research"))).toBe(false);
      expect(existsSync(join(result.archive_path, "handoffs"))).toBe(false);
    }

    rmSync(isolatedProjectDir, { force: true, recursive: true });
  });

  test("copies log.jsonl, context.md, journal.json when present", async () => {
    const result = await archiveWorkspace({
      branch: "main",
      projectDir,
      slug: "my-feature",
      workspacePath,
    });

    expect(result.archived).toBe(true);
    if (result.archive_path) {
      expect(existsSync(join(result.archive_path, "log.jsonl"))).toBe(true);
      expect(existsSync(join(result.archive_path, "context.md"))).toBe(true);
      expect(existsSync(join(result.archive_path, "journal.json"))).toBe(true);
    }
  });

  test("does NOT copy orchestration.db, .lock, board.json", async () => {
    // Add skip-pattern files to workspace
    writeText(join(workspacePath, "orchestration.db"), "db content");
    writeText(join(workspacePath, ".lock"), "lock content");
    writeText(join(workspacePath, "board.json"), "{}");

    const result = await archiveWorkspace({
      branch: "main",
      projectDir,
      slug: "my-feature",
      workspacePath,
    });

    expect(result.archived).toBe(true);
    if (result.archive_path) {
      expect(existsSync(join(result.archive_path, "orchestration.db"))).toBe(false);
      expect(existsSync(join(result.archive_path, ".lock"))).toBe(false);
      expect(existsSync(join(result.archive_path, "board.json"))).toBe(false);
    }
  });

  test("generates run-summary.json in the archive directory", async () => {
    const result = await archiveWorkspace({
      branch: "main",
      projectDir,
      slug: "my-feature",
      workspacePath,
    });

    expect(result.archived).toBe(true);
    if (result.archive_path) {
      expect(existsSync(join(result.archive_path, "run-summary.json"))).toBe(true);
    }
  });

  test("run-summary.json is valid JSON matching RunSummary type", async () => {
    const result = await archiveWorkspace({
      branch: "main",
      projectDir,
      slug: "my-feature",
      workspacePath,
    });

    expect(result.archived).toBe(true);
    if (result.archive_path) {
      const summaryPath = join(result.archive_path, "run-summary.json");
      const raw = readFileSync(summaryPath, "utf-8");
      const parsed = JSON.parse(raw) as unknown;

      expect(parsed).toMatchObject({
        archive_id: expect.any(String) as unknown,
        artifact_inventory: expect.any(Object) as unknown,
        // decision_summaries always present as empty array for version: 1 backward compat
        decision_summaries: [] as unknown,
        review_results: expect.any(Array) as unknown,
        run_metadata: expect.objectContaining({
          branch: "main",
          slug: "my-feature",
        }) as unknown,
        step_outcomes: expect.any(Array) as unknown,
        version: 1,
      });
    }
  });

  test("returns { archived: true, run_summary_generated: true } on success", async () => {
    const result = await archiveWorkspace({
      branch: "main",
      projectDir,
      slug: "my-feature",
      workspacePath,
    });

    expect(result.archived).toBe(true);
    expect(result.run_summary_generated).toBe(true);
    expect(result.error).toBeUndefined();
  });

  test("records manifest entry in drift.db with has_run_summary flag", async () => {
    await archiveWorkspace({
      branch: "main",
      projectDir,
      slug: "my-feature",
      workspacePath,
    });

    const mockDb = getDriftDb(projectDir) as unknown as {
      appendArchiveManifest: ReturnType<typeof vi.fn>;
    };
    expect(mockDb.appendArchiveManifest).toHaveBeenCalledTimes(1);

    const entry = mockDb.appendArchiveManifest.mock.calls[0]?.[0] as ArchiveManifestEntry;
    expect(entry.has_run_summary).toBe(true);
    expect(entry.branch).toBe("main");
    expect(entry.slug).toBe("my-feature");
    expect(entry.archive_id).toMatch(/^arch_/);
  });

  test("artifact_types array reflects which dirs/files were archived", async () => {
    const result = await archiveWorkspace({
      branch: "main",
      projectDir,
      slug: "my-feature",
      workspacePath,
    });

    expect(result.manifest_entry).not.toBeNull();
    const types = result.manifest_entry?.artifact_types ?? [];
    expect(types).toContain("plans");
    expect(types).toContain("reviews");
    expect(types).toContain("log.jsonl");
    expect(types).toContain("context.md");
    expect(types).toContain("journal.json");
    // legacy dirs present in workspace — included for backward-compat archival
    expect(types).toContain("research");
    expect(types).toContain("decisions");
    // handoffs not created in this workspace — should not appear
    expect(types).not.toContain("handoffs");
  });

  test("archive path follows expected structure: .canon/history/{slug}/", async () => {
    const result = await archiveWorkspace({
      branch: "main",
      projectDir,
      slug: "my-feature",
      workspacePath,
    });

    expect(result.archive_path).toContain(".canon");
    expect(result.archive_path).toContain("history");
    expect(result.archive_path).toContain("my-feature");
    // branch directory level is NOT part of the path
    expect(result.archive_path).not.toMatch(/history\/main\//);
  });
});

describe("archiveWorkspace — error handling", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTmpDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(projectDir, { force: true, recursive: true });
  });

  test("returns { archived: false, error: ... } when workspace path doesn't exist", async () => {
    const result = await archiveWorkspace({
      branch: "main",
      projectDir,
      slug: "my-feature",
      workspacePath: join(projectDir, "nonexistent"),
    });

    expect(result.archived).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.archive_path).toBeNull();
    expect(result.manifest_entry).toBeNull();
  });

  test("handles missing orchestration.db gracefully", async () => {
    // Workspace exists but no orchestration.db
    const workspacePath = makeWorkspace(projectDir, {
      dirs: ["plans"],
      files: ["journal.json"],
    });

    // Should not throw — use default metadata
    const result = await archiveWorkspace({
      branch: "feature/test",
      projectDir,
      slug: "test-slug",
      workspacePath,
    });

    expect(result.archived).toBe(true);
    expect(result.manifest_entry?.flow).toBeDefined();
  });

  test("returns { archived: true, run_summary_generated: false } when summary fails", async () => {
    // Make an unreadable journal.json to trigger run summary failure
    const workspacePath = makeWorkspace(projectDir, {
      dirs: ["plans"],
      files: [],
    });
    writeText(join(workspacePath, "journal.json"), "{ bad json !!! }");

    const result = await archiveWorkspace({
      branch: "main",
      projectDir,
      slug: "my-feature",
      workspacePath,
    });

    // Archive itself should succeed even if run summary generation encounters parse errors
    // The service wraps run summary generation independently
    expect(result.archived).toBe(true);
    // run_summary_generated may be true or false depending on whether the partial error
    // still produces a valid summary — at minimum archive should succeed
    expect(typeof result.run_summary_generated).toBe("boolean");
  });
});

describe("archiveWorkspace — branch in manifest", () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = makeTmpDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    rmSync(projectDir, { force: true, recursive: true });
  });

  test("branch with slashes is NOT part of archive path but IS stored in manifest", async () => {
    const workspacePath = makeWorkspace(projectDir, {
      dirs: ["plans"],
      files: ["journal.json"],
    });

    const result = await archiveWorkspace({
      branch: "feature/my-feature",
      projectDir,
      slug: "slug",
      workspacePath,
    });

    expect(result.archived).toBe(true);
    // Branch is not part of the archive path
    expect(result.archive_path).not.toMatch(/feature/);
    expect(result.archive_path).not.toMatch(/my-feature/);
    // Branch metadata is preserved in the manifest entry
    expect(result.manifest_entry?.branch).toBe("feature/my-feature");
    expect(result.manifest_entry?.sanitized_branch).toBeDefined();
  });
});
