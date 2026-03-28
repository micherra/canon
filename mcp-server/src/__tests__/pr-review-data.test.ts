import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { DriftStore } from "../drift/store.ts";

// ── helpers ──

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
    // mock execFile to return empty output (no files)
    vi.doMock("child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => cb(null, "", ""),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ pr_number: 42 }, tmpDir);
    expect(result.diff_command).toContain("gh pr diff 42");
    expect(result.diff_command).toContain("--name-only");
  });

  it("constructs git diff --name-status command for branch", async () => {
    vi.doMock("child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => cb(null, "", ""),
    }));
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ branch: "feature/auth", diff_base: "main" }, tmpDir);
    expect(result.diff_command).toContain("git diff main..feature/auth");
    expect(result.diff_command).toContain("--name-status");
  });

  it("defaults to main..HEAD without branch or PR", async () => {
    vi.doMock("child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => cb(null, "", ""),
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

    vi.doMock("child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => cb(null, nameStatusOutput, ""),
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
    vi.doMock("child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => cb(null, output, ""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);
    expect(result.files).toHaveLength(2);
    expect(result.total_files).toBe(2);
  });

  it("gh pr diff mode infers all files as modified", async () => {
    const nameOnlyOutput = "src/foo.ts\nsrc/bar.ts\n";
    vi.doMock("child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => cb(null, nameOnlyOutput, ""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ pr_number: 5 }, tmpDir);
    expect(result.files).toHaveLength(2);
    for (const f of result.files) {
      expect(f.status).toBe("modified");
    }
  });

  it("handles empty diff output (no changed files)", async () => {
    vi.doMock("child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => cb(null, "", ""),
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
    const { writeFile } = await import("fs/promises");
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
    vi.doMock("child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => cb(null, output, ""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    const toolsFile = result.files.find((f) => f.path === "src/tools/pr-review-data.ts");
    const testsFile = result.files.find((f) => f.path === "src/__tests__/pr-review-data.test.ts");

    expect(toolsFile?.layer).toBe("tools");
    expect(testsFile?.layer).toBe("tests");
  });

  it("groups files by layer in layers array", async () => {
    const { writeFile } = await import("fs/promises");
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({
        layers: {
          tools: ["src/tools"],
          graph: ["src/graph"],
        },
      }),
    );

    const output = [
      "M\tsrc/tools/a.ts",
      "A\tsrc/tools/b.ts",
      "M\tsrc/graph/c.ts",
    ].join("\n");

    vi.doMock("child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => cb(null, output, ""),
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
    vi.doMock("child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => cb(null, output, ""),
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

  it("merges priority_score and priority_factors into matching file entries", async () => {
    // Write mock graph data so computeFilePriorities can run
    const { writeFile } = await import("fs/promises");
    const graphData = {
      nodes: [
        {
          id: "src/tools/pr-review-data.ts",
          layer: "tools",
          violation_count: 2,
          changed: true,
        },
        {
          id: "src/graph/scanner.ts",
          layer: "graph",
          violation_count: 0,
          changed: false,
        },
      ],
      edges: [
        { source: "src/tools/pr-review-data.ts", target: "src/graph/scanner.ts" },
      ],
    };
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify(graphData),
    );

    const output = [
      "M\tsrc/tools/pr-review-data.ts",
      "M\tsrc/graph/scanner.ts",
    ].join("\n");

    vi.doMock("child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => cb(null, output, ""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // The file with violations should appear in impact_files with priority data merged
    const prFile = result.impact_files.find((f) => f.path === "src/tools/pr-review-data.ts");
    expect(prFile).toBeDefined();
    expect(prFile?.priority_score).toBeTypeOf("number");
    expect(prFile?.priority_factors).toBeDefined();
  });

  it("files without a priority score entry are excluded from impact_files", async () => {
    const output = "M\tsrc/some/unlisted-file.ts\n";
    vi.doMock("child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => cb(null, output, ""),
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
    vi.doMock("child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => cb(new Error("not a git repository"), "", "fatal: not a git repository"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);
    expect(result.files).toHaveLength(0);
    expect(result.total_files).toBe(0);
    expect(result.error).toContain("not a git repository");
  });

  it("does not throw when git diff fails (graceful degradation)", async () => {
    vi.doMock("child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => cb(new Error("command not found: git"), "", ""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await expect(fn({}, tmpDir)).resolves.not.toThrow();
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

    vi.doMock("child_process", () => ({
      execFile: (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, stdout: string, stderr: string) => void,
      ) => cb(null, "", ""),
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
    await expect(
      fn({ branch: "feat/x; rm -rf /", diff_base: "main" }, tmpDir),
    ).rejects.toThrow("Invalid git ref");
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
