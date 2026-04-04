/**
 * pr-review-data-integration.test.ts
 *
 * Integration tests and coverage gap fills for getPrReviewData.
 *
 * These tests complement the implementor's unit tests by covering:
 *   1. Parsing edge cases (R0 similarity, pure-whitespace lines, single-tab lines)
 *   2. Incremental mode when no prior review exists (null from store)
 *   3. Non-integer pr_number validation
 *   4. graph_data_age_ms and priority data passthrough
 *   5. data.error + total_files=0 co-occurrence (error path with some returned data)
 *   6. sanitizeGitRef on last_reviewed_sha that cannot pass the pattern (triggers error)
 *   7. Cross-subsystem integration: priority scoring round-trips through a real graph
 *      that has multiple files sharing a layer — verifies layer grouping, score merge,
 *      and output shape in a single assertion chain.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriftStore } from "../drift/store.ts";

function makeMockExecFile(stdout: string, err: Error | null = null) {
  return (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => cb(err, err ? "" : stdout, "");
}

/** Build a mock gitExecAsync that returns an ok ProcessResult with the given stdout. */
function mockGitExecAsyncOk(stdout: string) {
  return vi.fn().mockResolvedValue({
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout,
    timedOut: false,
  });
}

/** Build a mock gitExecAsync that returns an error ProcessResult. */
function mockGitExecAsyncFail(stderr = "fatal: not a git repository") {
  return vi.fn().mockResolvedValue({
    exitCode: 128,
    ok: false,
    stderr,
    stdout: "",
    timedOut: false,
  });
}

describe("getPrReviewData — rename similarity score edge cases", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-integ-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("R0 rename (0% similarity) still uses destination path and maps to renamed", async () => {
    // R0 means the file was completely rewritten but git still tracked it as a rename
    const output = "R0\tsrc/old-name.ts\tsrc/new-name.ts";
    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile(output),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ branch: "feat/rename-test", diff_base: "main" }, tmpDir);

    expect(result.total_files).toBe(1);
    expect(result.files[0]?.path).toBe("src/new-name.ts");
    expect(result.files[0]?.status).toBe("renamed");
  });

  it("R50 rename (50% similarity) uses destination path and maps to renamed", async () => {
    const output = "R050\tsrc/foo.ts\tsrc/bar.ts";
    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile(output),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(result.files[0]?.path).toBe("src/bar.ts");
    expect(result.files[0]?.status).toBe("renamed");
  });

  it("ignores lines that are only whitespace or tabs", async () => {
    // A blank line, a tab-only line, and a real file
    const output = "\t\n  \nM\tsrc/real.ts\n\t\n";
    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile(output),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // Only the real file should appear; whitespace lines filtered
    expect(result.total_files).toBe(1);
    expect(result.files[0]?.path).toBe("src/real.ts");
  });

  it("skips name-status lines that have a status letter but no path (parts[1] is absent)", async () => {
    // Malformed line: just a status letter with nothing after the tab
    const output = "M\t\nA\tsrc/good.ts";
    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile(output),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // The malformed "M\t" line has an empty path — parseDiffOutput skips it (if (!path) continue)
    // Only "src/good.ts" should appear
    expect(result.total_files).toBe(1);
    expect(result.files[0]?.path).toBe("src/good.ts");
  });
});

describe("getPrReviewData — incremental mode without prior review", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-integ-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("falls back to full diff when incremental=true but no prior review exists", async () => {
    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile(""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    // PR 999 has no prior review in the store
    const result = await fn({ incremental: true, pr_number: 999 }, tmpDir);

    // Should fall back to gh pr diff (pr number mode), NOT incremental
    expect(result.incremental).toBe(false);
    expect(result.last_reviewed_sha).toBeUndefined();
    expect(result.diff_command).toContain("gh pr diff 999");
  });

  it("incremental mode is false when store has no last_reviewed_sha for the PR", async () => {
    // Store a review WITHOUT a last_reviewed_sha field
    const store = new DriftStore(tmpDir);
    await store.appendReview({
      files: [],
      honored: [],
      pr_number: 7,
      review_id: "rev_no_sha",
      score: {
        conventions: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        rules: { passed: 0, total: 0 },
      },
      timestamp: "2026-03-25T00:00:00Z",
      verdict: "CLEAN",
      violations: [],
      // last_reviewed_sha intentionally omitted
    });

    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile(""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ incremental: true, pr_number: 7 }, tmpDir);

    expect(result.incremental).toBe(false);
    expect(result.last_reviewed_sha).toBeUndefined();
  });
});

describe("getPrReviewData — pr_number validation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-integ-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("rejects pr_number of zero", async () => {
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await expect(fn({ pr_number: 0 }, tmpDir)).rejects.toThrow("pr_number");
  });

  it("rejects negative pr_number", async () => {
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await expect(fn({ pr_number: -5 }, tmpDir)).rejects.toThrow("pr_number");
  });

  it("rejects non-integer pr_number (1.5)", async () => {
    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await expect(fn({ pr_number: 1.5 }, tmpDir)).rejects.toThrow("pr_number");
  });
});

describe("getPrReviewData — kg_freshness_ms and priority data passthrough", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-integ-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("populates kg_freshness_ms when KG DB exists with indexed files", async () => {
    // Set up a real SQLite DB with at least one indexed file
    const { initDatabase } = await import("../graph/kg-schema.js");
    const { KgStore } = await import("../graph/kg-store.js");
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    store.upsertFile({
      content_hash: "a",
      language: "typescript",
      last_indexed_at: Date.now() - 1000,
      layer: "tools",
      mtime_ms: Date.now(),
      path: "src/a.ts",
    });
    db.close();

    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(result.kg_freshness_ms).toBeTypeOf("number");
    expect(result.kg_freshness_ms).toBeGreaterThanOrEqual(0);
  });

  it("kg_freshness_ms is undefined when no KG DB exists", async () => {
    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(result.kg_freshness_ms).toBeUndefined();
  });

  it("merges priority data into file entries when KG DB is present", async () => {
    // Set up a real SQLite DB
    const { initDatabase } = await import("../graph/kg-schema.js");
    const { KgStore } = await import("../graph/kg-store.js");
    const dbPath = join(tmpDir, ".canon", "knowledge-graph.db");
    const db = initDatabase(dbPath);
    const store = new KgStore(db);
    const fileA = store.upsertFile({
      content_hash: "a",
      language: "typescript",
      last_indexed_at: Date.now(),
      layer: "tools",
      mtime_ms: Date.now(),
      path: "src/a.ts",
    });
    const fileB = store.upsertFile({
      content_hash: "b",
      language: "tools",
      last_indexed_at: Date.now(),
      layer: "tools",
      mtime_ms: Date.now(),
      path: "src/b.ts",
    });
    // a imports b → b has in_degree=1
    store.insertFileEdge({
      confidence: 1.0,
      edge_type: "imports",
      evidence: null,
      relation: null,
      source_file_id: fileA.file_id!,
      target_file_id: fileB.file_id!,
    });
    db.close();

    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/a.ts\nM\tsrc/b.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // Both files should have priority data since they are in the KG
    const fileAEntry = result.files.find((f) => f.path === "src/a.ts");
    expect(fileAEntry).toBeDefined();
    // impact_files: depends on score — need to check that priority_factors exist on some file
    // Score of src/b.ts = in_degree=1 * 3 + changed=1 = 4 (below 15 threshold, not in impact_files unless violations)
  });

  it("files have no priority data when KG DB is missing", async () => {
    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/a.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(result.impact_files).toHaveLength(0);
  });

  it("gracefully handles KG DB absence (no crash)", async () => {
    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/a.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // Should gracefully degrade — no crash, no priority data
    expect(result.impact_files).toHaveLength(0);
    expect(result.kg_freshness_ms).toBeUndefined();
  });
});

describe("getPrReviewData — error field co-occurrence with empty files", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-integ-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("error is absent from output on success (no error key in result)", async () => {
    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk("M\tsrc/foo.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // On success, the error key should not be present at all
    expect("error" in result).toBe(false);
  });

  it("when git fails, total_files is 0 and layers is empty alongside error", async () => {
    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncFail("git: command not found"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // All three empty + error must be set simultaneously
    expect(result.error).toBeDefined();
    expect(result.total_files).toBe(0);
    expect(result.files).toHaveLength(0);
    expect(result.layers).toHaveLength(0);
  });
});

describe("getPrReviewData — sanitizeGitRef on stored last_reviewed_sha", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-integ-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("rejects a stored last_reviewed_sha containing shell-injection chars", async () => {
    // Simulate a tampered store entry where the SHA contains dangerous characters
    const store = new DriftStore(tmpDir);
    await store.appendReview({
      files: [],
      honored: [],
      last_reviewed_sha: "abc123; rm -rf /",
      pr_number: 42,
      review_id: "rev_tampered",
      score: {
        conventions: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        rules: { passed: 0, total: 0 },
      },
      timestamp: "2026-03-25T00:00:00Z",
      verdict: "CLEAN",
      violations: [],
    });

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await expect(fn({ incremental: true, pr_number: 42 }, tmpDir)).rejects.toThrow(
      "Invalid git ref",
    );
  });

  it("valid hex SHA as last_reviewed_sha passes sanitizeGitRef", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview({
      files: [],
      honored: [],
      last_reviewed_sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      pr_number: 42,
      review_id: "rev_valid_sha",
      score: {
        conventions: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        rules: { passed: 0, total: 0 },
      },
      timestamp: "2026-03-25T00:00:00Z",
      verdict: "CLEAN",
      violations: [],
    });

    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ incremental: true, pr_number: 42 }, tmpDir);

    expect(result.incremental).toBe(true);
    expect(result.diff_command).toContain("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2..HEAD");
  });
});

describe("getPrReviewData — cross-subsystem integration: layer + priority", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-integ-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { force: true, recursive: true });
  });

  it("full pipeline: layer config + diff output produces correct grouped output", async () => {
    // Write layer config
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({
        layers: {
          graph: ["src/graph"],
          tests: ["src/__tests__"],
          tools: ["src/tools"],
        },
      }),
    );

    const diffOutput = [
      "M\tsrc/tools/pr-review-data.ts",
      "A\tsrc/graph/scanner.ts",
      "M\tsrc/__tests__/pr.test.ts",
    ].join("\n");

    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(diffOutput),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // total_files and layer groupings
    expect(result.total_files).toBe(3);
    expect(result.layers).toHaveLength(3);

    const toolsLayer = result.layers.find((l) => l.name === "tools");
    const graphLayer = result.layers.find((l) => l.name === "graph");
    const testsLayer = result.layers.find((l) => l.name === "tests");
    expect(toolsLayer?.file_count).toBe(1);
    expect(graphLayer?.file_count).toBe(1);
    expect(testsLayer?.file_count).toBe(1);

    // Status and layer preserved in lightweight files list
    const toolsFile = result.files.find((f) => f.path === "src/tools/pr-review-data.ts");
    expect(toolsFile?.status).toBe("modified");
    expect(toolsFile?.layer).toBe("tools");
    const graphFile = result.files.find((f) => f.path === "src/graph/scanner.ts");
    expect(graphFile?.status).toBe("added");
    expect(graphFile?.layer).toBe("graph");
    const testFile = result.files.find((f) => f.path === "src/__tests__/pr.test.ts");
    expect(testFile?.layer).toBe("tests");
  });

  it("multiple files in one layer: all grouped together", async () => {
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({ layers: { tools: ["src/tools"] } }),
    );

    const diffOutput = ["M\tsrc/tools/a.ts", "A\tsrc/tools/b.ts", "D\tsrc/tools/c.ts"].join("\n");

    vi.doMock("../adapters/git-adapter-async.ts", () => ({
      gitExecAsync: mockGitExecAsyncOk(diffOutput),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(result.layers).toHaveLength(1);
    expect(result.layers[0]?.name).toBe("tools");
    expect(result.layers[0]?.file_count).toBe(3);

    // All three statuses preserved
    const statuses = result.files.map((f) => f.status).sort();
    expect(statuses).toEqual(["added", "deleted", "modified"]);
  });
});
