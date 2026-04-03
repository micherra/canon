import { rmSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board, ContextInjection } from "../orchestration/flow-schema.ts";
import { extractSection, resolveContextInjections } from "../orchestration/inject-context.ts";

// ---------------------------------------------------------------------------
// Mocks for file_context tests
// Use vi.hoisted so mock factory functions can reference these variables
// even after vi.mock() is hoisted to the top of the module by vitest.
// ---------------------------------------------------------------------------

const {
  mockGetFileMetrics,
  mockGetKgFreshnessMs,
  mockGetFile,
  mockGetSummaryByFile,
  mockStore,
  mockDb,
} = vi.hoisted(() => {
  const mockGetFileMetrics = vi.fn();
  const mockGetKgFreshnessMs = vi.fn().mockReturnValue(1000);
  const mockGetFile = vi.fn();
  const mockGetSummaryByFile = vi.fn();
  const mockStore = {
    getSession: vi.fn().mockReturnValue({ tier: "medium" }),
  };
  const mockDb = { close: vi.fn() };
  return { mockGetFileMetrics, mockGetKgFreshnessMs, mockGetFile, mockGetSummaryByFile, mockStore, mockDb };
});

vi.mock("../orchestration/execution-store.ts", () => ({
  getExecutionStore: vi.fn(() => mockStore),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
  };
});

vi.mock("../graph/kg-schema.ts", () => ({
  initDatabase: vi.fn(() => mockDb),
}));

vi.mock("../graph/kg-query.ts", () => ({
  KgQuery: class MockKgQuery {
    getFileMetrics = mockGetFileMetrics;
    getKgFreshnessMs = mockGetKgFreshnessMs;
  },
  computeFileInsightMaps: vi.fn().mockReturnValue({
    hubPaths: new Set<string>(),
    cycleMemberPaths: new Map<string, string[]>(),
    layerViolationsByPath: new Map<string, unknown[]>(),
  }),
}));

vi.mock("../graph/kg-store.ts", () => ({
  KgStore: class MockKgStore {
    getFile = mockGetFile;
    getSummaryByFile = mockGetSummaryByFile;
  },
}));

import { existsSync } from "node:fs";
import { computeFileInsightMaps, KgQuery } from "../graph/kg-query.ts";
import { getExecutionStore } from "../orchestration/execution-store.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBoard(stateOverrides: Board["states"] = {}): Board {
  return {
    flow: "test",
    task: "test task",
    entry: "start",
    current_state: "start",
    base_commit: "abc123",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: stateOverrides,
    iterations: {},
    blocked: null,
    concerns: [],
    skipped: [],
  };
}

// ---------------------------------------------------------------------------
// extractSection — pure function, no filesystem
// ---------------------------------------------------------------------------

describe("extractSection", () => {
  it("returns null for empty markdown", () => {
    expect(extractSection("", "Summary")).toBeNull();
  });

  it("returns null when section heading is not found", () => {
    const md = "# Introduction\nSome text.\n## Details\nMore text.";
    expect(extractSection(md, "Missing")).toBeNull();
  });

  it("extracts content under the matching heading", () => {
    const md = "# Summary\nThis is the summary.\n\n# Next Section\nOther content.";
    const result = extractSection(md, "Summary");
    expect(result).toBe("# Summary\nThis is the summary.");
  });

  it("extracts full section until same-level heading", () => {
    const md = "## Alpha\nAlpha text.\n## Beta\nBeta text.";
    const result = extractSection(md, "Alpha");
    expect(result).toBe("## Alpha\nAlpha text.");
  });

  it("extracts full section until higher-level heading", () => {
    const md = "### Details\nDetail content.\n## Parent\nParent content.";
    const result = extractSection(md, "Details");
    expect(result).toBe("### Details\nDetail content.");
  });

  it("includes nested subheadings within the section", () => {
    const md = "## Overview\nIntro.\n### Part A\nPart A content.\n### Part B\nPart B content.\n## Next\nDone.";
    const result = extractSection(md, "Overview");
    expect(result).toContain("### Part A");
    expect(result).toContain("### Part B");
    expect(result).not.toContain("## Next");
  });

  it("is case-insensitive for section name matching", () => {
    const md = "## MY SECTION\nContent here.";
    expect(extractSection(md, "my section")).toBe("## MY SECTION\nContent here.");
    expect(extractSection(md, "My Section")).toBe("## MY SECTION\nContent here.");
  });

  it("handles section at end of document (no following heading)", () => {
    const md = "## Last Section\nFinal content.";
    const result = extractSection(md, "Last Section");
    expect(result).toBe("## Last Section\nFinal content.");
  });

  it("returns null when heading text includes trailing punctuation that doesn't match", () => {
    const md = "## Summary!\nContent.";
    // The heading text is "Summary!" and the search is "Summary" — no match
    expect(extractSection(md, "Summary")).toBeNull();
  });

  it("handles multiple levels of nesting", () => {
    const md = "# Root\n## Child\n### Grandchild\nDeep content.\n## Sibling\nSibling content.";
    const child = extractSection(md, "Child");
    expect(child).toContain("### Grandchild");
    expect(child).toContain("Deep content.");
    expect(child).not.toContain("Sibling content.");
  });
});

// ---------------------------------------------------------------------------
// resolveContextInjections — filesystem interactions
// ---------------------------------------------------------------------------

describe("resolveContextInjections", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "inject-context-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads artifact from a state and assigns to variable", async () => {
    const artifactPath = join(tmpDir, "output.md");
    await writeFile(artifactPath, "# Summary\nThis is important output.");

    const board = makeBoard({
      research: { status: "done", entries: 1, artifacts: [artifactPath] },
    });
    const injections: ContextInjection[] = [{ from: "research", as: "RESEARCH_OUTPUT" }];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings).toHaveLength(0);
    expect(result.hitl).toBeUndefined();
    expect(result.variables["RESEARCH_OUTPUT"]).toContain("This is important output.");
  });

  it("extracts a named section from artifact content", async () => {
    const artifactPath = join(tmpDir, "report.md");
    const content = "# Introduction\nIntro text.\n\n# Findings\nKey findings here.\n\n# Conclusion\nDone.";
    await writeFile(artifactPath, content);

    const board = makeBoard({
      analysis: { status: "done", entries: 1, artifacts: [artifactPath] },
    });
    const injections: ContextInjection[] = [{ from: "analysis", section: "Findings", as: "FINDINGS" }];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings).toHaveLength(0);
    expect(result.variables["FINDINGS"]).toContain("Key findings here.");
    expect(result.variables["FINDINGS"]).not.toContain("Intro text.");
    expect(result.variables["FINDINGS"]).not.toContain("Done.");
  });

  it("injects full content with warning when section is not found", async () => {
    const artifactPath = join(tmpDir, "report.md");
    await writeFile(artifactPath, "# Introduction\nIntro only.");

    const board = makeBoard({
      analysis: { status: "done", entries: 1, artifacts: [artifactPath] },
    });
    const injections: ContextInjection[] = [{ from: "analysis", section: "Missing Section", as: "OUTPUT" }];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Missing Section");
    expect(result.warnings[0]).toContain("injecting full content");
    // Still injects full content
    expect(result.variables["OUTPUT"]).toContain("Intro only.");
  });

  it("produces warning when source state is not found in board", async () => {
    const board = makeBoard({});
    const injections: ContextInjection[] = [{ from: "nonexistent-state", as: "OUTPUT" }];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("nonexistent-state");
    expect(result.warnings[0]).toContain("not found in board");
    expect(result.variables).not.toHaveProperty("OUTPUT");
  });

  it("produces warning when source state has no artifacts", async () => {
    const board = makeBoard({
      empty_state: { status: "done", entries: 1 },
    });
    const injections: ContextInjection[] = [{ from: "empty_state", as: "OUTPUT" }];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("empty_state");
    expect(result.warnings[0]).toContain("no artifacts");
    expect(result.variables).not.toHaveProperty("OUTPUT");
  });

  it("produces warning when artifact file does not exist on disk", async () => {
    const board = makeBoard({
      research: { status: "done", entries: 1, artifacts: ["nonexistent/path.md"] },
    });
    const injections: ContextInjection[] = [{ from: "research", as: "OUTPUT" }];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings.some((w) => w.includes("nonexistent/path.md"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("not found on disk"))).toBe(true);
  });

  it("produces warning when all artifacts are missing, variable not set", async () => {
    const board = makeBoard({
      research: {
        status: "done",
        entries: 1,
        artifacts: ["missing1.md", "missing2.md"],
      },
    });
    const injections: ContextInjection[] = [{ from: "research", as: "OUTPUT" }];

    const result = await resolveContextInjections(injections, board, tmpDir);
    // Expect warnings for each missing file plus the "all artifacts missing" warning
    expect(result.warnings.some((w) => w.includes("all artifacts"))).toBe(true);
    expect(result.variables).not.toHaveProperty("OUTPUT");
  });

  it("injects partial content when some artifacts exist and others are missing", async () => {
    const existingPath = join(tmpDir, "existing.md");
    await writeFile(existingPath, "Found content.");

    const board = makeBoard({
      research: {
        status: "done",
        entries: 1,
        artifacts: [existingPath, "missing.md"],
      },
    });
    const injections: ContextInjection[] = [{ from: "research", as: "OUTPUT" }];

    const result = await resolveContextInjections(injections, board, tmpDir);
    // Warning for missing file, but variable IS set with existing content
    expect(result.warnings.some((w) => w.includes("missing.md"))).toBe(true);
    expect(result.variables["OUTPUT"]).toContain("Found content.");
  });

  it("concatenates multiple artifacts with double newline separator", async () => {
    const path1 = join(tmpDir, "part1.md");
    const path2 = join(tmpDir, "part2.md");
    await writeFile(path1, "First part.");
    await writeFile(path2, "Second part.");

    const board = makeBoard({
      research: { status: "done", entries: 1, artifacts: [path1, path2] },
    });
    const injections: ContextInjection[] = [{ from: "research", as: "OUTPUT" }];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings).toHaveLength(0);
    expect(result.variables["OUTPUT"]).toContain("First part.");
    expect(result.variables["OUTPUT"]).toContain("Second part.");
  });

  it("returns hitl with prompt for from:user injection", async () => {
    const board = makeBoard({});
    const injections: ContextInjection[] = [
      { from: "user", as: "USER_INPUT", prompt: "Please provide the task scope" },
    ];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.hitl).toBeDefined();
    expect(result.hitl?.prompt).toBe("Please provide the task scope");
    expect(result.hitl?.as).toBe("USER_INPUT");
    expect(result.variables).not.toHaveProperty("USER_INPUT");
  });

  it("uses default prompt text for from:user injection with no prompt field", async () => {
    const board = makeBoard({});
    const injections: ContextInjection[] = [{ from: "user", as: "USER_INPUT" }];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.hitl).toBeDefined();
    expect(result.hitl?.prompt).toBe("Please provide input");
  });

  it("handles absolute artifact paths within the workspace", async () => {
    const artifactPath = join(tmpDir, "absolute.md");
    await writeFile(artifactPath, "Absolute path content.");

    const board = makeBoard({
      research: { status: "done", entries: 1, artifacts: [artifactPath] },
    });
    const injections: ContextInjection[] = [{ from: "research", as: "OUTPUT" }];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings).toHaveLength(0);
    expect(result.variables["OUTPUT"]).toContain("Absolute path content.");
  });

  it("blocks absolute path traversal outside workspace (e.g. /etc/passwd)", async () => {
    const board = makeBoard({
      research: { status: "done", entries: 1, artifacts: ["/etc/passwd"] },
    });
    const injections: ContextInjection[] = [{ from: "research", as: "OUTPUT" }];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings.some((w) => w.includes("/etc/passwd") && w.includes("escapes workspace"))).toBe(true);
    expect(result.variables).not.toHaveProperty("OUTPUT");
  });

  it("blocks relative path traversal that escapes workspace (e.g. ../../etc/passwd)", async () => {
    const board = makeBoard({
      research: { status: "done", entries: 1, artifacts: ["../../etc/passwd"] },
    });
    const injections: ContextInjection[] = [{ from: "research", as: "OUTPUT" }];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings.some((w) => w.includes("../../etc/passwd") && w.includes("escapes workspace"))).toBe(true);
    expect(result.variables).not.toHaveProperty("OUTPUT");
  });

  it("handles relative artifact paths by joining with workspace", async () => {
    const subdir = join(tmpDir, "artifacts");
    await mkdir(subdir);
    await writeFile(join(subdir, "relative.md"), "Relative path content.");

    const board = makeBoard({
      research: { status: "done", entries: 1, artifacts: ["artifacts/relative.md"] },
    });
    const injections: ContextInjection[] = [{ from: "research", as: "OUTPUT" }];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.warnings).toHaveLength(0);
    expect(result.variables["OUTPUT"]).toContain("Relative path content.");
  });

  it("processes multiple injections independently, collecting all warnings", async () => {
    const artifactPath = join(tmpDir, "good.md");
    await writeFile(artifactPath, "Good content.");

    const board = makeBoard({
      good_state: { status: "done", entries: 1, artifacts: [artifactPath] },
    });
    const injections: ContextInjection[] = [
      { from: "good_state", as: "GOOD" },
      { from: "missing_state", as: "MISSING" },
    ];

    const result = await resolveContextInjections(injections, board, tmpDir);
    expect(result.variables["GOOD"]).toContain("Good content.");
    expect(result.variables).not.toHaveProperty("MISSING");
    expect(result.warnings.some((w) => w.includes("missing_state"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// file_context injection source
// ---------------------------------------------------------------------------

function makeBoardWithMetadata(metadata?: Record<string, string | number | boolean>): Board {
  return {
    flow: "test",
    task: "test task",
    entry: "start",
    current_state: "start",
    base_commit: "abc123",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: {},
    iterations: {},
    blocked: null,
    concerns: [],
    skipped: [],
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

describe("resolveContextInjections — file_context source", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "inject-ctx-kg-test-"));
    // Reset mocks to clean state
    vi.mocked(existsSync).mockImplementation((p) => {
      // Default: KG DB exists
      const strPath = String(p);
      if (strPath.endsWith("knowledge-graph.db")) return true;
      return false;
    });
    mockStore.getSession.mockReturnValue({ tier: "medium" });
    mockGetFileMetrics.mockReturnValue(null);
    mockGetSummaryByFile.mockReturnValue(undefined);
    mockGetFile.mockReturnValue(undefined);
    mockGetKgFreshnessMs.mockReturnValue(1000); // fresh by default
    vi.mocked(computeFileInsightMaps).mockReturnValue({
      hubPaths: new Set<string>(),
      cycleMemberPaths: new Map<string, string[]>(),
      layerViolationsByPath: new Map<string, unknown[]>(),
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("resolves file summaries from KG for valid affected_files in board metadata", async () => {
    const board = makeBoardWithMetadata({
      affected_files: JSON.stringify(["src/api/handler.ts", "src/domain/service.ts"]),
    });
    const injections: ContextInjection[] = [{ from: "file_context", as: "FILE_CONTEXT" }];

    // Set up KG mocks: metrics and summaries for both files
    mockGetFileMetrics
      .mockReturnValueOnce({
        in_degree: 5,
        out_degree: 3,
        is_hub: false,
        in_cycle: false,
        cycle_peers: [],
        layer: "api",
        layer_violation_count: 0,
        layer_violations: [],
        impact_score: 16,
      })
      .mockReturnValueOnce({
        in_degree: 2,
        out_degree: 8,
        is_hub: false,
        in_cycle: false,
        cycle_peers: [],
        layer: "domain",
        layer_violation_count: 0,
        layer_violations: [],
        impact_score: 8,
      });

    mockGetFile
      .mockReturnValueOnce({ file_id: 1, path: "src/api/handler.ts" })
      .mockReturnValueOnce({ file_id: 2, path: "src/domain/service.ts" });

    mockGetSummaryByFile
      .mockReturnValueOnce({ summary: "Handles HTTP API requests" })
      .mockReturnValueOnce({ summary: "Domain service layer" });

    const result = await resolveContextInjections(injections, board, tmpDir);

    expect(result.warnings).toHaveLength(0);
    expect(result.variables["FILE_CONTEXT"]).toBeDefined();
    const value = result.variables["FILE_CONTEXT"]!;
    expect(value).toContain("### File Context");
    expect(value).toContain("src/api/handler.ts");
    expect(value).toContain("src/domain/service.ts");
    expect(value).toContain("in_degree: 5");
    expect(value).toContain("in_degree: 2");
    expect(value).toContain("Handles HTTP API requests");
    expect(value).toContain("Domain service layer");
  });

  it("produces warning and no value when affected_files is missing from board metadata", async () => {
    const board = makeBoardWithMetadata(); // no metadata
    const injections: ContextInjection[] = [{ from: "file_context", as: "FILE_CONTEXT" }];

    const result = await resolveContextInjections(injections, board, tmpDir);

    expect(result.warnings.some((w) => w.includes("affected_files"))).toBe(true);
    expect(result.variables).not.toHaveProperty("FILE_CONTEXT");
  });

  it("produces warning and no value when affected_files is empty array", async () => {
    const board = makeBoardWithMetadata({
      affected_files: JSON.stringify([]),
    });
    const injections: ContextInjection[] = [{ from: "file_context", as: "FILE_CONTEXT" }];

    const result = await resolveContextInjections(injections, board, tmpDir);

    expect(result.warnings.some((w) => w.includes("affected_files"))).toBe(true);
    expect(result.variables).not.toHaveProperty("FILE_CONTEXT");
  });

  it("produces warning and no value when affected_files contains malformed JSON", async () => {
    const board = makeBoardWithMetadata({
      affected_files: "not-valid-json[",
    });
    const injections: ContextInjection[] = [{ from: "file_context", as: "FILE_CONTEXT" }];

    const result = await resolveContextInjections(injections, board, tmpDir);

    expect(result.warnings.some((w) => w.includes("affected_files"))).toBe(true);
    expect(result.variables).not.toHaveProperty("FILE_CONTEXT");
  });

  it("respects item count cap: small tier with 10 files only processes 5", async () => {
    mockStore.getSession.mockReturnValue({ tier: "small" }); // cap = 5

    const tenFiles = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`);
    const board = makeBoardWithMetadata({
      affected_files: JSON.stringify(tenFiles),
    });
    const injections: ContextInjection[] = [{ from: "file_context", as: "FILE_CONTEXT" }];

    // All files return null metrics (no KG entry)
    mockGetFileMetrics.mockReturnValue(null);

    const result = await resolveContextInjections(injections, board, tmpDir);

    // computeFileInsightMaps called once
    expect(computeFileInsightMaps).toHaveBeenCalledTimes(1);
    // KgQuery.getFileMetrics called at most 5 times (capped)
    expect(mockGetFileMetrics).toHaveBeenCalledTimes(5);
    // Result should reference only the first 5 files
    const value = result.variables["FILE_CONTEXT"];
    expect(value).toContain("src/file0.ts");
    expect(value).not.toContain("src/file5.ts");
  });

  it("produces warning and no value when KG DB is unavailable", async () => {
    vi.mocked(existsSync).mockReturnValue(false); // KG DB missing

    const board = makeBoardWithMetadata({
      affected_files: JSON.stringify(["src/api/handler.ts"]),
    });
    const injections: ContextInjection[] = [{ from: "file_context", as: "FILE_CONTEXT" }];

    const result = await resolveContextInjections(injections, board, tmpDir);

    expect(result.warnings.some((w) => w.includes("KG") || w.includes("knowledge") || w.includes("database") || w.includes("unavailable"))).toBe(true);
    expect(result.variables).not.toHaveProperty("FILE_CONTEXT");
  });

  it("emits staleness warning but still returns value when KG is stale (>1h)", async () => {
    mockGetKgFreshnessMs.mockReturnValue(4_000_000); // ~1.1 hours — stale

    const board = makeBoardWithMetadata({
      affected_files: JSON.stringify(["src/api/handler.ts"]),
    });
    const injections: ContextInjection[] = [{ from: "file_context", as: "FILE_CONTEXT" }];

    mockGetFileMetrics.mockReturnValue({
      in_degree: 1,
      out_degree: 1,
      is_hub: false,
      in_cycle: false,
      cycle_peers: [],
      layer: "api",
      layer_violation_count: 0,
      layer_violations: [],
      impact_score: 4,
    });
    mockGetFile.mockReturnValue({ file_id: 1, path: "src/api/handler.ts" });
    mockGetSummaryByFile.mockReturnValue(undefined); // no summary

    const result = await resolveContextInjections(injections, board, tmpDir);

    // Should have a staleness warning
    expect(result.warnings.some((w) => w.includes("stale") || w.includes("KG") || w.includes("hour"))).toBe(true);
    // But still returns a value
    expect(result.variables["FILE_CONTEXT"]).toBeDefined();
    expect(result.variables["FILE_CONTEXT"]).toContain("src/api/handler.ts");
  });
});
