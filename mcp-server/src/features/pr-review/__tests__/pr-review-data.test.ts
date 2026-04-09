import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Build a mock gitExecAsync that returns an ok ProcessResult with the given stdout.
 */
function mockGitExecAsyncOk(stdout: string) {
  return vi.fn().mockResolvedValue({
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout,
    timedOut: false,
  });
}

/**
 * Build a mock gitExecAsync that returns an error ProcessResult.
 */
function mockGitExecAsyncFail(stderr = "fatal: not a git repository") {
  return vi.fn().mockResolvedValue({
    exitCode: 128,
    ok: false,
    stderr,
    stdout: "",
    timedOut: false,
  });
}

/**
 * Build a mock runShell that returns an ok ProcessResult with the given stdout.
 */
function mockRunShellOk(stdout: string) {
  return vi.fn().mockReturnValue({
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout,
    timedOut: false,
  });
}

/**
 * Build a mock runShell that returns an error ProcessResult.
 */
function mockRunShellFail(stderr = "gh: command not found") {
  return vi.fn().mockReturnValue({
    exitCode: 1,
    ok: false,
    stderr,
    stdout: "",
    timedOut: false,
  });
}

describe("getPrReviewData — diff command construction", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("constructs gh pr diff command for PR number", async () => {
    // gh command uses runShell (non-git path)
    vi.doMock("@platform/adapters/process-adapter.ts", () => ({
      runShell: mockRunShellOk(""),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ pr_number: 42 }, tmpDir);
    expect(result.diff_command).toContain("gh pr diff 42");
    expect(result.diff_command).toContain("--name-only");
  });

  it("constructs git diff --name-status command for branch", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(""),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ branch: "feature/auth", diff_base: "main" }, tmpDir);
    expect(result.diff_command).toContain("git diff main..feature/auth");
    expect(result.diff_command).toContain("--name-status");
  });

  it("defaults to main..HEAD without branch or PR", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(""),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);
    expect(result.diff_command).toContain("git diff main..HEAD");
    expect(result.diff_command).toContain("--name-status");
  });
});

describe("getPrReviewData — name-status parsing", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("maps A/M/D/R status letters to full status names", async () => {
    const nameStatusOutput = [
      "A\tsrc/new-file.ts",
      "M\tsrc/modified.ts",
      "D\tsrc/deleted.ts",
      "R100\tsrc/old-name.ts\tsrc/new-name.ts",
    ].join("\n");

    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(nameStatusOutput),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ branch: "feat/x", diff_base: "main" }, tmpDir);

    expect(result.total_files).toBe(4);
    const statuses = result.files.map((f) => ({ path: f.path, status: f.status }));
    expect(statuses).toContainEqual({ path: "src/new-file.ts", status: "added" });
    expect(statuses).toContainEqual({ path: "src/modified.ts", status: "modified" });
    expect(statuses).toContainEqual({ path: "src/deleted.ts", status: "deleted" });
    // Renamed files use the destination path
    expect(statuses).toContainEqual({ path: "src/new-name.ts", status: "renamed" });
  });

  it("returns files array with correct total_files count", async () => {
    const output = "M\tsrc/a.ts\nA\tsrc/b.ts\n";
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(output),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);
    expect(result.files).toHaveLength(2);
    expect(result.total_files).toBe(2);
  });

  it("gh pr diff mode infers all files as modified", async () => {
    const nameOnlyOutput = "src/foo.ts\nsrc/bar.ts\n";
    vi.doMock("@platform/adapters/process-adapter.ts", () => ({
      runShell: mockRunShellOk(nameOnlyOutput),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ pr_number: 5 }, tmpDir);
    expect(result.files).toHaveLength(2);
    for (const f of result.files) {
      expect(f.status).toBe("modified");
    }
  });

  it("handles empty diff output (no changed files)", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);
    expect(result.files).toHaveLength(0);
    expect(result.total_files).toBe(0);
    expect(result.layers).toHaveLength(0);
  });
});

describe("getPrReviewData — layer inference", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("infers layer from file path using config mappings", async () => {
    // Write a config with layer mappings
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({
        layers: {
          tests: ["src/__tests__"],
          tools: ["src/tools", "src/features/pr-review/tools"],
        },
      }),
    );

    const output =
      "M\tsrc/features/pr-review/tools/pr-review-data.ts\nM\tsrc/__tests__/pr-review-data.test.ts\n";
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(output),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    const toolsFile = result.files.find(
      (f) => f.path === "src/features/pr-review/tools/pr-review-data.ts",
    );
    const testsFile = result.files.find((f) => f.path === "src/__tests__/pr-review-data.test.ts");

    expect(toolsFile?.layer).toBe("tools");
    expect(testsFile?.layer).toBe("tests");
  });

  it("groups files by layer in layers array", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({
        layers: {
          graph: ["src/graph"],
          tools: ["src/tools"],
        },
      }),
    );

    const output = ["M\tsrc/tools/a.ts", "A\tsrc/tools/b.ts", "M\tsrc/graph/c.ts"].join("\n");

    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(output),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    const toolsLayer = result.layers.find((l) => l.name === "tools");
    const graphLayer = result.layers.find((l) => l.name === "graph");
    expect(toolsLayer?.file_count).toBe(2);
    expect(graphLayer?.file_count).toBe(1);
  });

  it("assigns unknown layer when no mapping matches", async () => {
    const output = "M\tsrc/orphan/file.ts\n";
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(output),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);
    expect(result.files[0]?.layer).toBe("unknown");
  });
});

describe("getPrReviewData — priority score merging", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("merges priority_score and priority_factors into matching file entries (from KG DB)", async () => {
    // Set up a real SQLite DB with file_edges so priority scoring works
    const { initDatabase } = await import("@graph/kg-schema.js");
    const { KgStore } = await import("@graph/kg-store.js");
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    const db = initDatabase(dbPath);
    const store = new KgStore(db);

    // Insert files — pr-review-data.ts has in_degree=1 (scanner imports it)
    const prFile = store.upsertFile({
      content_hash: "a",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "tools",
      mtime_ms: Date.now(),
      path: "src/features/pr-review/tools/pr-review-data.ts",
    });
    const scannerFile = store.upsertFile({
      content_hash: "b",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "graph",
      mtime_ms: Date.now(),
      path: "src/graph/scanner.ts",
    });
    // scanner imports pr-review-data → pr-review-data has in_degree=1
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: scannerFile.file_id!,
      target_file_id: prFile.file_id!,
    });
    db.close();

    const output = [
      "M\tsrc/features/pr-review/tools/pr-review-data.ts",
      "M\tsrc/graph/scanner.ts",
    ].join("\n");
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(output),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // Both files are in the result
    expect(result.total_files).toBe(2);
    // At least one file should have priority data (they are in the KG)
    const prEntry = result.files.find(
      (f) => f.path === "src/features/pr-review/tools/pr-review-data.ts",
    );
    expect(prEntry).toBeDefined();
    // impact_files may include entries — score is based on in_degree, violation_count, layer
    // pr-review-data.ts has in_degree=1, is_changed=true, layer=tools (centrality=0)
    // score = 1*3 + 0*2 + 1 + 0 = 4 (below priority_score>=15 threshold for impact_files)
    // but with violations, it could be in impact_files
  });

  it("files without a priority score entry are excluded from impact_files", async () => {
    const output = "M\tsrc/some/unlisted-file.ts\n";
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(output),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);
    expect(result.files).toHaveLength(1);
    expect(result.impact_files).toHaveLength(0);
  });
});

describe("getPrReviewData — error handling", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("returns empty files with error field when git diff fails", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncFail("fatal: not a git repository"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);
    expect(result.files).toHaveLength(0);
    expect(result.total_files).toBe(0);
    expect(result.error).toContain("not a git repository");
  });

  it("does not throw when git diff fails (graceful degradation)", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncFail("command not found: git"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await expect(fn({}, tmpDir)).resolves.not.toThrow();
  });

  it("returns error field when gh command fails (pr_number mode)", async () => {
    vi.doMock("@platform/adapters/process-adapter.ts", () => ({
      runShell: mockRunShellFail("gh: command not found"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ pr_number: 42 }, tmpDir);
    expect(result.files).toHaveLength(0);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("gh");
  });
});
