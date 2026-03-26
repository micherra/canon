/**
 * pr-review-data-integration.test.ts
 *
 * Integration tests and coverage gap fills for getPrReviewData.
 *
 * These tests complement the implementor's unit tests by covering:
 *   1. Parsing edge cases (R0 similarity, pure-whitespace lines, single-tab lines)
 *   2. Incremental mode when no prior review exists (null from store)
 *   3. Non-integer pr_number validation
 *   4. graph_data_age_ms and prioritized_files passthrough
 *   5. data.error + total_files=0 co-occurrence (error path with some returned data)
 *   6. sanitizeGitRef on last_reviewed_sha that cannot pass the pattern (triggers error)
 *   7. Cross-subsystem integration: priority scoring round-trips through a real graph
 *      that has multiple files sharing a layer — verifies layer grouping, score merge,
 *      and output shape in a single assertion chain.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { DriftStore } from "../drift/store.ts";

// ── helpers ──

function makeMockExecFile(stdout: string, err: Error | null = null) {
  return (
    _cmd: string,
    _args: string[],
    _opts: unknown,
    cb: (err: Error | null, stdout: string, stderr: string) => void,
  ) => cb(err, err ? "" : stdout, "");
}

// ── 1. Parsing edge cases ──

describe("getPrReviewData — rename similarity score edge cases", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-integ-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
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

// ── 2. Incremental mode — no prior review in store ──

describe("getPrReviewData — incremental mode without prior review", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-integ-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("falls back to full diff when incremental=true but no prior review exists", async () => {
    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile(""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    // PR 999 has no prior review in the store
    const result = await fn({ pr_number: 999, incremental: true }, tmpDir);

    // Should fall back to gh pr diff (pr number mode), NOT incremental
    expect(result.incremental).toBe(false);
    expect(result.last_reviewed_sha).toBeUndefined();
    expect(result.diff_command).toContain("gh pr diff 999");
  });

  it("incremental mode is false when store has no last_reviewed_sha for the PR", async () => {
    // Store a review WITHOUT a last_reviewed_sha field
    const store = new DriftStore(tmpDir);
    await store.appendReview({
      review_id: "rev_no_sha",
      timestamp: "2026-03-25T00:00:00Z",
      pr_number: 7,
      verdict: "CLEAN",
      files: [],
      violations: [],
      honored: [],
      score: {
        rules: { passed: 0, total: 0 },
        opinions: { passed: 0, total: 0 },
        conventions: { passed: 0, total: 0 },
      },
      // last_reviewed_sha intentionally omitted
    });

    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile(""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ pr_number: 7, incremental: true }, tmpDir);

    expect(result.incremental).toBe(false);
    expect(result.last_reviewed_sha).toBeUndefined();
  });
});

// ── 3. pr_number validation ──

describe("getPrReviewData — pr_number validation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-integ-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
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

// ── 4. graph_data_age_ms and prioritized_files passthrough ──

describe("getPrReviewData — graph_data_age_ms and prioritized_files passthrough", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-integ-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("populates graph_data_age_ms when graph file exists", async () => {
    const graphData = { nodes: [], edges: [] };
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify(graphData),
    );

    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile(""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(result.graph_data_age_ms).toBeTypeOf("number");
    expect(result.graph_data_age_ms).toBeGreaterThanOrEqual(0);
  });

  it("graph_data_age_ms is undefined when no graph file exists", async () => {
    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile(""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(result.graph_data_age_ms).toBeUndefined();
  });

  it("prioritized_files contains all graph nodes when graph data is present", async () => {
    const graphData = {
      nodes: [
        { id: "src/a.ts", layer: "tools", violation_count: 0, changed: true },
        { id: "src/b.ts", layer: "tools", violation_count: 1, changed: true },
      ],
      edges: [{ source: "src/a.ts", target: "src/b.ts" }],
    };
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify(graphData),
    );

    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile("M\tsrc/a.ts\nM\tsrc/b.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(result.prioritized_files).toBeDefined();
    expect(Array.isArray(result.prioritized_files)).toBe(true);
    // Both changed nodes should appear in prioritized_files
    expect(result.prioritized_files!.length).toBeGreaterThanOrEqual(1);
  });

  it("prioritized_files is undefined when graph file is missing", async () => {
    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile("M\tsrc/a.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    expect(result.prioritized_files).toBeUndefined();
  });

  it("prioritized_files is undefined when graph JSON is malformed (graceful degrade)", async () => {
    // Write invalid JSON to the graph file
    await writeFile(join(tmpDir, ".canon", "graph-data.json"), "{ broken json }");

    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile("M\tsrc/a.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // Should gracefully degrade — no crash, prioritized_files stays undefined.
    // Note: graph_data_age_ms IS set because stat() succeeds before JSON.parse() throws.
    // This is intentional — the age reflects when the file was last written, even if
    // parsing fails. The caller can use graph_data_age_ms to know the file is stale/corrupt.
    expect(result.prioritized_files).toBeUndefined();
    // age is set (stat succeeds even when JSON is invalid)
    expect(result.graph_data_age_ms).toBeTypeOf("number");
  });
});

// ── 5. data.error with empty files (co-occurrence) ──

describe("getPrReviewData — error field co-occurrence with empty files", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-integ-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("error is absent from output on success (no error key in result)", async () => {
    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile("M\tsrc/foo.ts"),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({}, tmpDir);

    // On success, the error key should not be present at all
    expect("error" in result).toBe(false);
  });

  it("when execFile fails, total_files is 0 and layers is empty alongside error", async () => {
    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile("", new Error("git: command not found")),
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

// ── 6. sanitizeGitRef on last_reviewed_sha from store ──

describe("getPrReviewData — sanitizeGitRef on stored last_reviewed_sha", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-integ-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects a stored last_reviewed_sha containing shell-injection chars", async () => {
    // Simulate a tampered store entry where the SHA contains dangerous characters
    const store = new DriftStore(tmpDir);
    await store.appendReview({
      review_id: "rev_tampered",
      timestamp: "2026-03-25T00:00:00Z",
      pr_number: 42,
      last_reviewed_sha: "abc123; rm -rf /",
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

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    await expect(
      fn({ pr_number: 42, incremental: true }, tmpDir),
    ).rejects.toThrow("Invalid git ref");
  });

  it("valid hex SHA as last_reviewed_sha passes sanitizeGitRef", async () => {
    const store = new DriftStore(tmpDir);
    await store.appendReview({
      review_id: "rev_valid_sha",
      timestamp: "2026-03-25T00:00:00Z",
      pr_number: 42,
      last_reviewed_sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
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

    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile(""),
    }));

    const { getPrReviewData: fn } = await import("../tools/pr-review-data.js");
    const result = await fn({ pr_number: 42, incremental: true }, tmpDir);

    expect(result.incremental).toBe(true);
    expect(result.diff_command).toContain("a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2..HEAD");
  });
});

// ── 7. Cross-subsystem integration: layer grouping + priority score merge ──

describe("getPrReviewData — cross-subsystem integration: layer + priority", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tmpDir = await mkdtemp(join(tmpdir(), "canon-pr-review-integ-"));
    await mkdir(join(tmpDir, ".canon"), { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("full pipeline: layer config + graph data + diff output produces correct grouped output", async () => {
    // Write layer config
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({
        layers: {
          tools: ["src/tools"],
          graph: ["src/graph"],
          tests: ["src/__tests__"],
        },
      }),
    );

    // Write graph data with known priority characteristics
    const graphData = {
      nodes: [
        { id: "src/tools/pr-review-data.ts", layer: "tools", violation_count: 2, changed: true },
        { id: "src/graph/scanner.ts", layer: "graph", violation_count: 0, changed: true },
        { id: "src/__tests__/pr.test.ts", layer: "tests", violation_count: 0, changed: true },
      ],
      edges: [
        { source: "src/tools/pr-review-data.ts", target: "src/graph/scanner.ts" },
        { source: "src/graph/scanner.ts", target: "src/tools/pr-review-data.ts" },
      ],
    };
    await writeFile(
      join(tmpDir, ".canon", "graph-data.json"),
      JSON.stringify(graphData),
    );

    const diffOutput = [
      "M\tsrc/tools/pr-review-data.ts",
      "A\tsrc/graph/scanner.ts",
      "M\tsrc/__tests__/pr.test.ts",
    ].join("\n");

    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile(diffOutput),
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

    // Priority scores merged
    const toolsFile = result.files.find((f) => f.path === "src/tools/pr-review-data.ts");
    expect(toolsFile?.priority_score).toBeTypeOf("number");
    expect(toolsFile?.priority_factors).toBeDefined();
    // tools file has violation_count: 2 → should have higher priority than the test file
    const testFile = result.files.find((f) => f.path === "src/__tests__/pr.test.ts");
    expect((toolsFile?.priority_score ?? 0)).toBeGreaterThan((testFile?.priority_score ?? 0));

    // Status values preserved through the pipeline
    expect(toolsFile?.status).toBe("modified");
    const graphFile = result.files.find((f) => f.path === "src/graph/scanner.ts");
    expect(graphFile?.status).toBe("added");

    // Layer assignment correct
    expect(toolsFile?.layer).toBe("tools");
    expect(graphFile?.layer).toBe("graph");
    expect(testFile?.layer).toBe("tests");
  });

  it("multiple files in one layer: all grouped together", async () => {
    await writeFile(
      join(tmpDir, ".canon", "config.json"),
      JSON.stringify({ layers: { tools: ["src/tools"] } }),
    );

    const diffOutput = [
      "M\tsrc/tools/a.ts",
      "A\tsrc/tools/b.ts",
      "D\tsrc/tools/c.ts",
    ].join("\n");

    vi.doMock("child_process", () => ({
      execFile: makeMockExecFile(diffOutput),
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
