import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriftStore } from "@platform/storage/drift/store.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockGitExecAsyncFail,
  mockGitExecAsyncOk,
  mockRunShellFail,
  mockRunShellOk,
  useTmpDir,
} from "./pr-review-data-test-utils.js";

describe("getPrReviewData — diff command construction", () => {
  const dir = useTmpDir();

  it("constructs gh pr diff command for PR number", async () => {
    vi.doMock("@platform/adapters/process-adapter.ts", () => ({
      runShell: mockRunShellOk(""),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ pr_number: 42 }, dir.get());
    expect(result.diff_command).toContain("gh pr diff 42");
    expect(result.diff_command).toContain("--name-only");
  });

  it("constructs git diff --name-status command for branch", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(""),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ branch: "feature/auth", diff_base: "main" }, dir.get());
    expect(result.diff_command).toContain("git diff main..feature/auth");
    expect(result.diff_command).toContain("--name-status");
  });

  it("defaults to main..HEAD without branch or PR", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(""),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, dir.get());
    expect(result.diff_command).toContain("git diff main..HEAD");
    expect(result.diff_command).toContain("--name-status");
  });
});

describe("getPrReviewData — name-status parsing", () => {
  const dir = useTmpDir();

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
    const result = await fn({ branch: "feat/x", diff_base: "main" }, dir.get());
    expect(result.total_files).toBe(4);
    const statuses = result.files.map((f) => ({ path: f.path, status: f.status }));
    expect(statuses).toContainEqual({ path: "src/new-file.ts", status: "added" });
    expect(statuses).toContainEqual({ path: "src/modified.ts", status: "modified" });
    expect(statuses).toContainEqual({ path: "src/deleted.ts", status: "deleted" });
    // Renamed files use the destination path
    expect(statuses).toContainEqual({ path: "src/new-name.ts", status: "renamed" });
  });

  it("returns files array with correct total_files count", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/a.ts\nA\tsrc/b.ts\n"),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, dir.get());
    expect(result.files).toHaveLength(2);
    expect(result.total_files).toBe(2);
  });

  it("gh pr diff mode infers all files as modified", async () => {
    vi.doMock("@platform/adapters/process-adapter.ts", () => ({
      runShell: mockRunShellOk("src/foo.ts\nsrc/bar.ts\n"),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ pr_number: 5 }, dir.get());
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
    const result = await fn({}, dir.get());
    expect(result.files).toHaveLength(0);
    expect(result.total_files).toBe(0);
    expect(result.layers).toHaveLength(0);
  });
});

describe("getPrReviewData — layer inference", () => {
  const dir = useTmpDir();

  it("infers layer from file path using config mappings", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(dir.get(), ".canon", "config.json"),
      JSON.stringify({
        layers: {
          tests: ["src/__tests__"],
          tools: ["src/tools", "src/features/pr-review/tools"],
        },
      }),
    );
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(
        "M\tsrc/features/pr-review/tools/pr-review-data.ts\nM\tsrc/__tests__/pr-review-data.test.ts\n",
      ),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, dir.get());
    expect(
      result.files.find((f) => f.path === "src/features/pr-review/tools/pr-review-data.ts")?.layer,
    ).toBe("tools");
    expect(result.files.find((f) => f.path === "src/__tests__/pr-review-data.test.ts")?.layer).toBe(
      "tests",
    );
  });

  it("groups files by layer in layers array", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(dir.get(), ".canon", "config.json"),
      JSON.stringify({ layers: { graph: ["src/graph"], tools: ["src/tools"] } }),
    );
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(
        ["M\tsrc/tools/a.ts", "A\tsrc/tools/b.ts", "M\tsrc/graph/c.ts"].join("\n"),
      ),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, dir.get());
    expect(result.layers.find((l) => l.name === "tools")?.file_count).toBe(2);
    expect(result.layers.find((l) => l.name === "graph")?.file_count).toBe(1);
  });

  it("assigns unknown layer when no mapping matches", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/orphan/file.ts\n"),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, dir.get());
    expect(result.files[0]?.layer).toBe("unknown");
  });
});

describe("getPrReviewData — priority score merging", () => {
  const dir = useTmpDir();

  it("merges priority_score and priority_factors into matching file entries (from KG DB)", async () => {
    const { initDatabase } = await import("@graph/kg-schema.js");
    const { KgStore } = await import("@graph/kg-store.js");
    const db = initDatabase(join(dir.get(), ".canon", "knowledge-graph.db"));
    const store = new KgStore(db);
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
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: scannerFile.file_id!,
      target_file_id: prFile.file_id!,
    });
    db.close();

    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(
        ["M\tsrc/features/pr-review/tools/pr-review-data.ts", "M\tsrc/graph/scanner.ts"].join("\n"),
      ),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, dir.get());
    expect(result.total_files).toBe(2);
    expect(
      result.files.find((f) => f.path === "src/features/pr-review/tools/pr-review-data.ts"),
    ).toBeDefined();
  });

  it("files without a priority score entry are excluded from impact_files", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/some/unlisted-file.ts\n"),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, dir.get());
    expect(result.files).toHaveLength(1);
    expect(result.impact_files).toHaveLength(0);
  });
});

describe("getPrReviewData — error handling", () => {
  const dir = useTmpDir();

  it("returns empty files with error field when git diff fails", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncFail("fatal: not a git repository"),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, dir.get());
    expect(result.files).toHaveLength(0);
    expect(result.total_files).toBe(0);
    expect(result.error).toContain("not a git repository");
  });

  it("does not throw when git diff fails (graceful degradation)", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncFail("command not found: git"),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await expect(fn({}, dir.get())).resolves.not.toThrow();
  });

  it("returns error field when gh command fails (pr_number mode)", async () => {
    vi.doMock("@platform/adapters/process-adapter.ts", () => ({
      runShell: mockRunShellFail("gh: command not found"),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ pr_number: 42 }, dir.get());
    expect(result.files).toHaveLength(0);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("gh");
  });
});

// ---------------------------------------------------------------------------
// Merged from pr-review-data-advanced.test.ts
// ---------------------------------------------------------------------------

describe("getPrReviewData — incremental mode", () => {
  const dir = useTmpDir();

  it("uses last_reviewed_sha as base when incremental=true", async () => {
    const store = new DriftStore(dir.get());
    await store.appendReview({
      files: ["src/foo.ts"],
      honored: [],
      last_reviewed_sha: "abc123",
      pr_number: 42,
      review_id: "rev_test",
      score: {
        conventions: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 1 },
        rules: { passed: 1, total: 1 },
      },
      timestamp: "2026-03-16T00:00:00Z",
      verdict: "WARNING",
      violations: [{ principle_id: "p1", severity: "strong-opinion" }],
    });
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(""),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ incremental: true, pr_number: 42 }, dir.get());
    expect(result.incremental).toBe(true);
    expect(result.last_reviewed_sha).toBe("abc123");
    expect(result.diff_command).toContain("abc123..HEAD");
    expect(result.diff_command).toContain("--name-status");
  });
});

describe("getPrReviewData — git ref sanitization", () => {
  const dir = useTmpDir();

  it("throws on invalid git ref characters", async () => {
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await expect(fn({ branch: "feat/x; rm -rf /", diff_base: "main" }, dir.get())).rejects.toThrow(
      "Invalid git ref",
    );
  });

  it("throws on ref starting with dash", async () => {
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await expect(fn({ diff_base: "-Xms256m" }, dir.get())).rejects.toThrow("Invalid git ref");
  });

  it("throws on ref containing ..", async () => {
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await expect(fn({ diff_base: "main..evil" }, dir.get())).rejects.toThrow("Invalid git ref");
  });
});

describe("DriftStore — review methods", () => {
  let tmpDir = "";
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "canon-drift-store-review-test-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });
  afterEach(async () => {
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("filters reviews by PR number", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview({
      files: [],
      honored: [],
      pr_number: 42,
      review_id: "rev_1",
      score: {
        conventions: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        rules: { passed: 0, total: 0 },
      },
      timestamp: "2026-03-16T00:00:00Z",
      verdict: "CLEAN",
      violations: [],
    });
    await store.appendReview({
      files: [],
      honored: [],
      pr_number: 99,
      review_id: "rev_2",
      score: {
        conventions: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        rules: { passed: 0, total: 0 },
      },
      timestamp: "2026-03-16T01:00:00Z",
      verdict: "WARNING",
      violations: [],
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
      files: [],
      honored: [],
      last_reviewed_sha: "sha1",
      pr_number: 42,
      review_id: "rev_1",
      score: {
        conventions: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        rules: { passed: 0, total: 0 },
      },
      timestamp: "2026-03-16T00:00:00Z",
      verdict: "WARNING",
      violations: [],
    });
    await store.appendReview({
      files: [],
      honored: [],
      last_reviewed_sha: "sha2",
      pr_number: 42,
      review_id: "rev_2",
      score: {
        conventions: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        rules: { passed: 0, total: 0 },
      },
      timestamp: "2026-03-16T01:00:00Z",
      verdict: "CLEAN",
      violations: [],
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

describe("getPrReviewData — blast radius from KG", () => {
  const dir = useTmpDir("canon-pr-review-br-");

  it("returns empty blast_radius when KG does not exist", async () => {
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/api/handler.ts"),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, dir.get());
    expect(result.blast_radius).toEqual([]);
  });

  it("computes blast_radius from KG file_edges when KG database exists", async () => {
    const { initDatabase } = await import("@graph/kg-schema.js");
    const { KgStore } = await import("@graph/kg-store.js");
    const db = initDatabase(join(dir.get(), ".canon", "knowledge-graph.db"));
    const store = new KgStore(db);
    const handler = store.upsertFile({
      content_hash: "h",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "api",
      mtime_ms: Date.now(),
      path: "src/api/handler.ts",
    });
    for (const [hash, path] of [
      ["s1", "src/services/svc1.ts"],
      ["s2", "src/services/svc2.ts"],
      ["s3", "src/services/svc3.ts"],
    ]) {
      const svc = store.upsertFile({
        content_hash: hash,
        language: "typescript",
        last_indexed_at: Date.now(),
        layer: "services",
        mtime_ms: Date.now(),
        path,
      });
      store.insertFileEdge({
        confidence: 1.0,
        edge_type: "imports",
        evidence: null,
        relation: null,
        source_file_id: svc.file_id!,
        target_file_id: handler.file_id!,
      });
    }
    db.close();
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/api/handler.ts"),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, dir.get());
    const entry = result.blast_radius.find((e) => e.file === "src/api/handler.ts");
    expect(entry).toBeDefined();
    expect(entry!.affected.length).toBeGreaterThan(0);
  });
});

describe("getPrReviewData — adapter routing", () => {
  const dir = useTmpDir("canon-pr-review-adapter-");

  it("routes git commands to gitExecAsync (not child_process)", async () => {
    const gitExecAsync = mockGitExecAsyncOk("M\tsrc/file.ts");
    vi.doMock("@platform/adapters/git-adapter-async.ts", () => ({ gitExecAsync }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await fn({}, dir.get());
    expect(gitExecAsync).toHaveBeenCalled();
    const [args] = gitExecAsync.mock.calls[0];
    expect(args).toBeInstanceOf(Array);
    expect(args[0]).toBe("diff");
  });

  it("routes gh commands to runShell (not child_process)", async () => {
    const runShell = mockRunShellOk("");
    vi.doMock("@platform/adapters/process-adapter.ts", () => ({ runShell }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await fn({ pr_number: 1 }, dir.get());
    expect(runShell).toHaveBeenCalled();
    const [cmd] = runShell.mock.calls[0];
    expect(cmd).toMatch(/^gh /);
    expect(cmd).toContain("pr");
    expect(cmd).toContain("diff");
  });

  it("gitExecAsync export exists and never rejects (returns ProcessResult)", async () => {
    const { gitExecAsync } = await import("@platform/adapters/git-adapter-async.ts");
    expect(typeof gitExecAsync).toBe("function");
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
