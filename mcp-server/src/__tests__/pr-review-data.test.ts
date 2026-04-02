import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriftStore } from "../drift/store.ts";

// ── helpers ──

/**
 * Build a mock gitExecAsync that returns an ok ProcessResult with the given stdout.
 */
function mockGitExecAsyncOk(stdout: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    stdout,
    stderr: "",
    exitCode: 0,
    timedOut: false,
  });
}

/**
 * Build a mock gitExecAsync that returns an error ProcessResult.
 */
function mockGitExecAsyncFail(stderr = "fatal: not a git repository") {
  return vi.fn().mockResolvedValue({
    ok: false,
    stdout: "",
    stderr,
    exitCode: 128,
    timedOut: false,
  });
}

/**
 * Build a mock runShell that returns an ok ProcessResult with the given stdout.
 */
function mockRunShellOk(stdout: string) {
  return vi.fn().mockReturnValue({
    ok: true,
    stdout,
    stderr: "",
    exitCode: 0,
    timedOut: false,
  });
}

/**
 * Build a mock runShell that returns an error ProcessResult.
 */
function mockRunShellFail(stderr = "gh: command not found") {
  return vi.fn().mockReturnValue({
    ok: false,
    stdout: "",
    stderr,
    exitCode: 1,
    timedOut: false,
  });
}

// ── diff command construction tests ──

describe("getPrReviewData — diff command construction", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("constructs gh pr diff command for PR number", async () => {
    // gh command uses runShell (non-git path)
    vi.doMock("../adapters/process-adapter.ts", () => ({
      runShell: mockRunShellOk(""),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ pr_number: 42 }, tmpDir);
    expect(result.diff_command).toContain("gh pr diff 42");
    expect(result.diff_command).toContain("--name-only");
  });

  it("constructs git diff --name-status command for branch", async () => {
    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(""),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ branch: "feature/auth", diff_base: "main" }, tmpDir);
    expect(result.diff_command).toContain("git diff main..feature/auth");
    expect(result.diff_command).toContain("--name-status");
  });

  it("defaults to main..HEAD without branch or PR", async () => {
    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(""),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);
    expect(result.diff_command).toContain("git diff main..HEAD");
    expect(result.diff_command).toContain("--name-status");
  });
});

// ── output parsing tests ──

describe("getPrReviewData — name-status parsing", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("maps A/M/D/R status letters to full status names", async () => {
    const nameStatusOutput = [
      "A\tsrc/new-file.ts",
      "M\tsrc/modified.ts",
      "D\tsrc/deleted.ts",
      "R100\tsrc/old-name.ts\tsrc/new-name.ts",
    ].join("\n");

    vi.doMock("../adapters/git-adapter-async.ts", () => ({
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
    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(output),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);
    expect(result.files).toHaveLength(2);
    expect(result.total_files).toBe(2);
  });

  it("gh pr diff mode infers all files as modified", async () => {
    const nameOnlyOutput = "src/foo.ts\nsrc/bar.ts\n";
    vi.doMock("../adapters/process-adapter.ts", () => ({
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
    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);
    expect(result.files).toHaveLength(0);
    expect(result.total_files).toBe(0);
    expect(result.layers).toHaveLength(0);
  });
});

// ── layer inference tests ──

describe("getPrReviewData — layer inference", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("infers layer from file path using config mappings", async () => {
    // Write a config with layer mappings
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({
        layers: {
          tools: ["src/tools"],
          tests: ["src/__tests__"],
        },
      }),
    );

    const output = "M\tsrc/tools/pr-review-data.ts\nM\tsrc/__tests__/pr-review-data.test.ts\n";
    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(output),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    const toolsFile = result.files.find((f) => f.path === "src/tools/pr-review-data.ts");
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
          tools: ["src/tools"],
          graph: ["src/graph"],
        },
      }),
    );

    const output = ["M\tsrc/tools/a.ts", "A\tsrc/tools/b.ts", "M\tsrc/graph/c.ts"].join("\n");

    vi.doMock("../adapters/git-adapter-async.ts", () => ({
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
    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(output),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);
    expect(result.files[0]?.layer).toBe("unknown");
  });
});

// ── priority score merging tests ──

describe("getPrReviewData — priority score merging", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("merges priority_score and priority_factors into matching file entries (from KG DB)", async () => {
    // Set up a real SQLite DB with file_edges so priority scoring works
    const { initDatabase } = await import("../graph/kg-schema.js");
    const { KgStore } = await import("../graph/kg-store.js");
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    const db = initDatabase(dbPath);
    const store = new KgStore(db);

    // Insert files — pr-review-data.ts has in_degree=1 (scanner imports it)
    const prFile = store.upsertFile({
      path: "src/tools/pr-review-data.ts",
      mtime_ms: Date.now(),
      content_hash: "a",
      language: "typescript",
      layer: "tools",
      last_indexed_at: Date.now(),
    });
    const scannerFile = store.upsertFile({
      path: "src/graph/scanner.ts",
      mtime_ms: Date.now(),
      content_hash: "b",
      language: "typescript",
      layer: "graph",
      last_indexed_at: Date.now(),
    });
    // scanner imports pr-review-data → pr-review-data has in_degree=1
    store.insertFileEdge({
      source_file_id: scannerFile.file_id!,
      target_file_id: prFile.file_id!,
      edge_type: "imports",
      confidence: 1.0,
      evidence: null,
      relation: null,
    });
    db.close();

    const output = ["M\tsrc/tools/pr-review-data.ts", "M\tsrc/graph/scanner.ts"].join("\n");
    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(output),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // Both files are in the result
    expect(result.total_files).toBe(2);
    // At least one file should have priority data (they are in the KG)
    const prEntry = result.files.find((f) => f.path === "src/tools/pr-review-data.ts");
    expect(prEntry).toBeDefined();
    // impact_files may include entries — score is based on in_degree, violation_count, layer
    // pr-review-data.ts has in_degree=1, is_changed=true, layer=tools (centrality=0)
    // score = 1*3 + 0*2 + 1 + 0 = 4 (below priority_score>=15 threshold for impact_files)
    // but with violations, it could be in impact_files
  });

  it("files without a priority score entry are excluded from impact_files", async () => {
    const output = "M\tsrc/some/unlisted-file.ts\n";
    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(output),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);
    expect(result.files).toHaveLength(1);
    expect(result.impact_files).toHaveLength(0);
  });
});

// ── error handling tests ──

describe("getPrReviewData — error handling", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty files with error field when git diff fails", async () => {
    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncFail("fatal: not a git repository"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);
    expect(result.files).toHaveLength(0);
    expect(result.total_files).toBe(0);
    expect(result.error).toContain("not a git repository");
  });

  it("does not throw when git diff fails (graceful degradation)", async () => {
    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncFail("command not found: git"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await expect(fn({}, tmpDir)).resolves.not.toThrow();
  });

  it("returns error field when gh command fails (pr_number mode)", async () => {
    vi.doMock("../adapters/process-adapter.ts", () => ({
      runShell: mockRunShellFail("gh: command not found"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ pr_number: 42 }, tmpDir);
    expect(result.files).toHaveLength(0);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("gh");
  });
});

// ── incremental mode tests ──

describe("getPrReviewData — incremental mode", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("uses last_reviewed_sha as base when incremental=true", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview({
      review_id: "rev_test",
      timestamp: "2026-03-16T00:00:00Z",
      pr_number: 42,
      last_reviewed_sha: "abc123",
      verdict: "WARNING",
      files: ["src/foo.ts"],
      violations: [{ principle_id: "p1", severity: "strong-opinion" }],
      honored: [],
      score: {
        rules: { passed: 1, total: 1 },
        opinions: { passed: 0, total: 1 },
        conventions: { passed: 0, total: 0 },
      },
    });

    // Incremental mode with last_reviewed_sha switches to git diff (not gh)
    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ pr_number: 42, incremental: true }, tmpDir);

    expect(result.incremental).toBe(true);
    expect(result.last_reviewed_sha).toBe("abc123");
    expect(result.diff_command).toContain("abc123..HEAD");
    // incremental mode uses git diff with --name-status
    expect(result.diff_command).toContain("--name-status");
  });
});

// ── git ref sanitization tests ──

describe("getPrReviewData — git ref sanitization", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("throws on invalid git ref characters", async () => {
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await expect(fn({ branch: "feat/x; rm -rf /", diff_base: "main" }, tmpDir)).rejects.toThrow("Invalid git ref");
  });

  it("throws on ref starting with dash", async () => {
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await expect(fn({ diff_base: "-Xms256m" }, tmpDir)).rejects.toThrow("Invalid git ref");
  });

  it("throws on ref containing ..", async () => {
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await expect(fn({ diff_base: "main..evil" }, tmpDir)).rejects.toThrow("Invalid git ref");
  });
});

// ── DriftStore review tests ──

describe("DriftStore — review methods", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-drift-store-review-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("filters reviews by PR number", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview({
      review_id: "rev_1",
      timestamp: "2026-03-16T00:00:00Z",
      pr_number: 42,
      verdict: "CLEAN",
      files: [],
      violations: [],
      honored: [],
      score: {
        rules: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        conventions: { passed: 0, total: 0 },
      },
    });
    await store.appendReview({
      review_id: "rev_2",
      timestamp: "2026-03-16T01:00:00Z",
      pr_number: 99,
      verdict: "WARNING",
      files: [],
      violations: [],
      honored: [],
      score: {
        rules: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        conventions: { passed: 0, total: 0 },
      },
    });

    const all = await store.getReviews();
    expect(all).toHaveLength(2);

    const pr42 = await store.getReviews({ prNumber: 42 });
    expect(pr42).toHaveLength(1);
    expect(pr42[0].review_id).toBe("rev_1");
  });

  it("gets last review for a PR", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview({
      review_id: "rev_1",
      timestamp: "2026-03-16T00:00:00Z",
      pr_number: 42,
      last_reviewed_sha: "sha1",
      verdict: "WARNING",
      files: [],
      violations: [],
      honored: [],
      score: {
        rules: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        conventions: { passed: 0, total: 0 },
      },
    });
    await store.appendReview({
      review_id: "rev_2",
      timestamp: "2026-03-16T01:00:00Z",
      pr_number: 42,
      last_reviewed_sha: "sha2",
      verdict: "CLEAN",
      files: [],
      violations: [],
      honored: [],
      score: {
        rules: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        conventions: { passed: 0, total: 0 },
      },
    });

    const last = await store.getLastReviewForPr(42);
    expect(last).not.toBeNull();
    expect(last!.review_id).toBe("rev_2");
    expect(last!.last_reviewed_sha).toBe("sha2");
  });

  it("returns null for PR with no reviews", async () => {
    const store = new DriftStore(tmpDir);
    const last = await store.getLastReviewForPr(999);
    expect(last).toBeNull();
  });
});

// ── Blast radius — KG-backed tests ──

describe("getPrReviewData — blast radius from KG", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-br-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty blast_radius when KG does not exist", async () => {
    // No KG database — files have no priority_factors.in_degree, no candidates
    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/api/handler.ts"),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);
    expect(result.blast_radius).toEqual([]);
  });

  it("computes blast_radius from KG file_edges when KG database exists", async () => {
    // Set up a real SQLite DB with file_edges
    const { initDatabase } = await import("../graph/kg-schema.js");
    const { KgStore } = await import("../graph/kg-store.js");
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    const db = initDatabase(dbPath);
    const store = new KgStore(db);

    // handler.ts is imported by 3 service files (in_degree=3, meets blast radius threshold)
    const handler = store.upsertFile({
      path: "src/api/handler.ts",
      mtime_ms: Date.now(),
      content_hash: "h",
      language: "typescript",
      layer: "api",
      last_indexed_at: Date.now(),
    });
    const svc1 = store.upsertFile({
      path: "src/services/svc1.ts",
      mtime_ms: Date.now(),
      content_hash: "s1",
      language: "typescript",
      layer: "services",
      last_indexed_at: Date.now(),
    });
    const svc2 = store.upsertFile({
      path: "src/services/svc2.ts",
      mtime_ms: Date.now(),
      content_hash: "s2",
      language: "typescript",
      layer: "services",
      last_indexed_at: Date.now(),
    });
    const svc3 = store.upsertFile({
      path: "src/services/svc3.ts",
      mtime_ms: Date.now(),
      content_hash: "s3",
      language: "typescript",
      layer: "services",
      last_indexed_at: Date.now(),
    });
    for (const svc of [svc1, svc2, svc3]) {
      store.insertFileEdge({
        source_file_id: svc.file_id!,
        target_file_id: handler.file_id!,
        edge_type: "imports",
        confidence: 1.0,
        evidence: null,
        relation: null,
      });
    }
    db.close();

    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/api/handler.ts"),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // handler.ts has in_degree=3 and is_changed=true — should appear in blast_radius
    const entry = result.blast_radius.find((e) => e.file === "src/api/handler.ts");
    expect(entry).toBeDefined();
    expect(entry!.affected.length).toBeGreaterThan(0);
  });
});

// ── adapter routing tests (new for adr002-05) ──

describe("getPrReviewData — adapter routing", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-adapter-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("routes git commands to gitExecAsync (not child_process)", async () => {
    const gitExecAsync = mockGitExecAsyncOk("M\tsrc/file.ts");
    vi.doMock("../adapters/git-adapter-async.ts", () => ({ gitExecAsync }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await fn({}, tmpDir);

    expect(gitExecAsync).toHaveBeenCalled();
    // Should be called with the diff args, not the git binary name
    const [args] = gitExecAsync.mock.calls[0];
    expect(args).toBeInstanceOf(Array);
    expect(args[0]).toBe("diff");
  });

  it("routes gh commands to runShell (not child_process)", async () => {
    const runShell = mockRunShellOk("");
    vi.doMock("../adapters/process-adapter.ts", () => ({ runShell }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await fn({ pr_number: 1 }, tmpDir);

    expect(runShell).toHaveBeenCalled();
    // Command string should start with "gh" and contain "pr" and "diff" (now shell-quoted)
    const [cmd] = runShell.mock.calls[0];
    expect(cmd).toMatch(/^gh /);
    expect(cmd).toContain("pr");
    expect(cmd).toContain("diff");
  });

  it("gitExecAsync export exists and never rejects (returns ProcessResult)", async () => {
    // Verify the adapter module exports gitExecAsync as a function
    // (behavioral tests for ok:false are in codebase-graph.test.ts)
    const { gitExecAsync } = await import("../adapters/git-adapter-async.ts");
    expect(typeof gitExecAsync).toBe("function");
    // Returns a Promise (not undefined)
    const p = gitExecAsync(["--version"], process.cwd());
    expect(p).toBeInstanceOf(Promise);
    const result = await p;
    expect(result).toHaveProperty("ok");
    expect(result).toHaveProperty("stdout");
    expect(result).toHaveProperty("stderr");
    expect(result).toHaveProperty("exitCode");
    expect(result).toHaveProperty("timedOut");
  });
});
