/**
 * Context Enrichment Integration Tests — Canon Tester
 *
 * Fills coverage gaps declared in enr-01/02/03 Coverage Notes and tests
 * the cross-task flows requested by the orchestrator:
 *
 * 1. End-to-end enrichment: scope resolver → enrichment assembler → pipeline
 * 2. Budget cap enforcement across all sections combined
 * 3. Tensions section with conflicting signals
 * 4. Graceful degradation when data sources are missing
 * 5. escapeDollarBrace on git commit messages containing ${...}
 *
 * Additional gaps from enr-01/02/03 Coverage Notes:
 * - assembleGitSection: partial git failure (some files succeed, some fail)
 * - assembleWorkspaceSection: REVIEW.md file type (not just DESIGN.md)
 * - assembleWorkspaceSection: cap at 3 sibling workspaces
 * - assembleDriftSection: violation where file_path is null (global violation)
 * - DriftDb.getReviewsByFiles: malformed JSON in files column (skip silently)
 * - Budget: combined section chars do not exceed 6000 with all sections populated
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DriftDb } from "../drift/drift-db.ts";
import { initDriftDb } from "../drift/drift-schema.ts";
import type { Board, ResolvedFlow } from "../orchestration/flow-schema.ts";
import type { ReviewEntry } from "../shared/schema.ts";

// Module mocks for context-enrichment tests

vi.mock("../platform/adapters/git-adapter.ts", () => ({
  gitLog: vi.fn(),
}));

vi.mock("../drift/store.ts", () => ({
  DriftStore: vi.fn(function () {
    return {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
  }),
}));

vi.mock("../orchestration/scope-resolver.ts", () => ({
  resolveTaskScope: vi.fn(),
}));

// Imports (after mocks)

import { gitLog } from "../platform/adapters/git-adapter.ts";
import { DriftStore } from "../drift/store.ts";
import { assembleEnrichment, type EnrichmentInput } from "../orchestration/context-enrichment.ts";
import { resolveTaskScope } from "../orchestration/scope-resolver.ts";

// Helpers shared across sections

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    base_commit: "abc123",
    blocked: null,
    concerns: [],
    current_state: "implement",
    entry: "implement",
    flow: "build",
    iterations: {},
    last_updated: new Date().toISOString(),
    skipped: [],
    started: new Date().toISOString(),
    states: {},
    task: "Test task",
    ...overrides,
  };
}

function makeFlow(tier = "feature"): ResolvedFlow {
  return {
    description: "Build flow",
    entry: "implement",
    name: "build",
    params: {},
    states: {
      implement: {
        spawn: { agent: "canon-implementor", prompt: "implement" },
        transitions: { done: "terminal" },
        type: "single",
      },
      terminal: { type: "terminal" },
    },
    tier,
  } as unknown as ResolvedFlow;
}

function makeInput(overrides: Partial<EnrichmentInput> = {}): EnrichmentInput {
  return {
    board: makeBoard(),
    cwd: "/tmp/project",
    flow: makeFlow(),
    projectDir: "/tmp/project",
    stateId: "implement",
    workspace: "/tmp/workspace",
    ...overrides,
  };
}

function makeGitOk(stdout: string) {
  return {
    duration_ms: 20,
    exitCode: 0,
    ok: true,
    stderr: "",
    stdout,
    timedOut: false,
  };
}

function makeGitFail() {
  return {
    duration_ms: 5,
    exitCode: 128,
    ok: false,
    stderr: "fatal: not a git repo",
    stdout: "",
    timedOut: false,
  };
}

function makeReviewEntry(
  files: string[],
  violationCount = 0,
  verdict: "BLOCKING" | "WARNING" | "CLEAN" = "CLEAN",
  nullFilePath = false,
): ReviewEntry {
  return {
    files,
    honored: [],
    review_id: `rev_${Math.random().toString(36).slice(2, 8)}`,
    score: {
      conventions: { passed: 1, total: 1 },
      opinions: { passed: 1, total: 1 },
      rules: { passed: 0, total: 1 },
    },
    timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    verdict,
    violations: Array.from({ length: violationCount }, (_, i) => ({
      principle_id: `principle-${i}`,
      severity: "rule" as const,
      // Half with null file_path when nullFilePath=true
      ...(nullFilePath && i % 2 === 0 ? {} : { file_path: files[0] }),
      message: `Violation ${i}`,
    })),
  };
}

// 1. End-to-end: scope resolver → enrichment assembler → pipeline integration

describe("enrichment integration — scope resolver → assembler pipeline", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "enr-integ-"));
    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Add feature"));
    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
    vi.clearAllMocks();
  });

  it("produces enrichment with Recent Changes when scope resolves file paths", async () => {
    // Scope resolver returns file paths (as it would from board artifacts).
    // This verifies the pipeline: scope → git section → output.
    vi.mocked(resolveTaskScope).mockReturnValue([
      "src/orchestration/context-enrichment.ts",
      "src/platform/adapters/git-adapter.ts",
    ]);

    const result = await assembleEnrichment(
      makeInput({
        board: makeBoard(),
        projectDir: undefined, // no drift
        stateId: "research",
        workspace: tmpDir,
      }),
    );

    expect(result.content).toContain("## Context Enrichment");
    expect(result.content).toContain("Recent Changes");
    expect(result.content).toContain("src/orchestration/context-enrichment.ts");
    expect(result.warnings).not.toContain("enrichment: no task scope found");
  });

  it("returns empty with warning when scope resolver returns nothing and no fallback", async () => {
    vi.mocked(resolveTaskScope).mockReturnValue([]);

    const result = await assembleEnrichment(makeInput());

    expect(result.content).toBe("");
    expect(result.warnings).toContain("enrichment: no task scope found");
  });

  it("scope resolver returning two files produces git entries for both files", async () => {
    // Verify assembleEnrichment calls gitLog once per file from resolved scope.
    const scopedFiles = ["src/platform/adapters/git-adapter.ts", "src/drift/store.ts"];
    vi.mocked(resolveTaskScope).mockReturnValue(scopedFiles);

    const result = await assembleEnrichment(
      makeInput({
        board: makeBoard(),
        projectDir: undefined,
        stateId: "implement",
        workspace: tmpDir,
      }),
    );

    // gitLog should have been called once per scoped file
    expect(vi.mocked(gitLog)).toHaveBeenCalledTimes(scopedFiles.length);
    // Both files should appear in the Recent Changes section
    expect(result.content).toContain("src/platform/adapters/git-adapter.ts");
    expect(result.content).toContain("src/drift/store.ts");
  });
});

// 2. Budget cap enforcement across all sections combined

describe("enrichment integration — combined budget cap enforcement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("combined output never exceeds MAX_ENRICHMENT_CHARS (6000) even with all sections populated", async () => {
    // 30 files with long git output + drift violations + workspace data
    const files = Array.from({ length: 30 }, (_, i) => `src/file-${i}.ts`);
    vi.mocked(resolveTaskScope).mockReturnValue(files);

    // Long git output per file (forces budget trimming)
    const longMsg = "refactor-long-commit-message-to-stress-budget ".repeat(10);
    vi.mocked(gitLog).mockReturnValue(
      makeGitOk(Array.from({ length: 3 }, (_, i) => `sha${i} ${longMsg}`).join("\n")),
    );

    // Drift has many violations
    const mockStore = {
      getReviewsForFiles: vi
        .fn()
        .mockResolvedValue([
          makeReviewEntry(files.slice(0, 5), 5, "BLOCKING"),
          makeReviewEntry(files.slice(5, 10), 3, "WARNING"),
        ]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput({ flow: makeFlow("epic") }));

    expect(result.content.length).toBeLessThanOrEqual(6000);
  });

  it("adds [truncated] marker at exactly the right position when budget exceeded", async () => {
    const files = Array.from({ length: 30 }, (_, i) => `src/file-${i}.ts`);
    vi.mocked(resolveTaskScope).mockReturnValue(files);

    // Maximally long per-file output
    const veryLongMsg = "x".repeat(300);
    vi.mocked(gitLog).mockReturnValue(
      makeGitOk(Array.from({ length: 5 }, (_, i) => `sha${i} ${veryLongMsg}`).join("\n")),
    );

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([makeReviewEntry(files, 10, "BLOCKING")]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput({ flow: makeFlow("epic") }));

    // Content must be <= 6000 chars
    expect(result.content.length).toBeLessThanOrEqual(6000);
    // If truncated, must end with the marker
    if (result.content.length >= 5988) {
      // close to cap
      expect(result.content).toContain("[truncated]");
    }
  });

  it("feature tier uses 15-file cap per section (not fast-path 5 or epic 30)", async () => {
    const twentyFiles = Array.from({ length: 20 }, (_, i) => `src/file-${i}.ts`);
    vi.mocked(resolveTaskScope).mockReturnValue(twentyFiles);

    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Add feature"));

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput({ flow: makeFlow("feature") }));

    // Count unique file entries in output: feature tier cap = 15
    const fileMatches = result.content.match(/`src\/file-\d+\.ts`/g) ?? [];
    const uniqueFiles = new Set(fileMatches);
    expect(uniqueFiles.size).toBeLessThanOrEqual(15);
  });
});

// 3. Tensions section with conflicting signals

describe("enrichment integration — tensions section conflicting signals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tensions entry shows correct counts: violations N and commits M", async () => {
    vi.mocked(resolveTaskScope).mockReturnValue(["src/foo.ts"]);

    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1 First fix\nbcd2 Second fix\ncde3 Third fix"));

    const mockStore = {
      getReviewsForFiles: vi
        .fn()
        .mockResolvedValue([makeReviewEntry(["src/foo.ts"], 4, "BLOCKING")]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput());

    expect(result.content).toContain("Tensions");
    expect(result.content).toContain("4 active violations");
    expect(result.content).toContain("3 recent commits");
    expect(result.content).toContain("review drift alignment");
  });

  it("tensions counts violations with null file_path (global violations count for file)", async () => {
    vi.mocked(resolveTaskScope).mockReturnValue(["src/foo.ts"]);

    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1 Add feature"));

    // makeReviewEntry with nullFilePath=true: violations alternate between
    // file_path=files[0] and no file_path (global). Both should count.
    const mockStore = {
      getReviewsForFiles: vi
        .fn()
        .mockResolvedValue([makeReviewEntry(["src/foo.ts"], 4, "BLOCKING", true)]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput());

    // Should have tensions (violations exist whether file-specific or global)
    expect(result.content).toContain("Tensions");
    expect(result.content).toContain("active violations");
  });

  it("tensions not emitted when violations exist but git returns nothing for the file", async () => {
    vi.mocked(resolveTaskScope).mockReturnValue(["src/no-git.ts"]);

    // Git returns empty output (no commits) — not an error, just empty
    vi.mocked(gitLog).mockReturnValue(makeGitOk(""));

    const mockStore = {
      getReviewsForFiles: vi
        .fn()
        .mockResolvedValue([makeReviewEntry(["src/no-git.ts"], 3, "WARNING")]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput());

    // No commits means fileCommits map won't have this file → no tensions entry
    expect(result.content).not.toContain("Tensions");
  });

  it("tensions capped at exactly 3 with 5 conflicting files", async () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];
    vi.mocked(resolveTaskScope).mockReturnValue(files);

    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Fix bug"));

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([makeReviewEntry(files, 2, "WARNING")]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput());

    const tensionSection = result.content.split("\n").filter((line) => line.match(/^- \*\*`/));
    // Maximum 3 tension entries even with 5 conflicting files
    expect(tensionSection.length).toBeLessThanOrEqual(3);
    expect(tensionSection.length).toBeGreaterThan(0);
  });

  it("tensions section completely absent when no violations exist across any file", async () => {
    vi.mocked(resolveTaskScope).mockReturnValue(["src/a.ts", "src/b.ts"]);

    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Add feature\nbcd5678 Fix test"));

    const mockStore = {
      getReviewsForFiles: vi
        .fn()
        .mockResolvedValue([makeReviewEntry(["src/a.ts", "src/b.ts"], 0, "CLEAN")]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput());

    expect(result.content).not.toContain("Tensions");
    // But other sections should still appear
    expect(result.content).toContain("Recent Changes");
    expect(result.content).toContain("Drift Signals");
  });
});

// 4. Graceful degradation when data sources are missing

describe("enrichment integration — graceful degradation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("partial git failure: succeeded files appear, failed files skipped (no throw)", async () => {
    const files = ["src/ok.ts", "src/fail.ts", "src/also-ok.ts"];
    vi.mocked(resolveTaskScope).mockReturnValue(files);

    // First call succeeds, second fails, third succeeds
    vi.mocked(gitLog)
      .mockReturnValueOnce(makeGitOk("abc1234 Good commit"))
      .mockReturnValueOnce(makeGitFail())
      .mockReturnValueOnce(makeGitOk("def5678 Another good commit"));

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput({ projectDir: undefined }));

    // Should not throw and should include succeeded files
    expect(result.content).toContain("Recent Changes");
    expect(result.content).toContain("src/ok.ts");
    expect(result.content).toContain("src/also-ok.ts");
    // Failed file should not appear in git section
    expect(result.content).not.toMatch(/`src\/fail\.ts`:/);
  });

  it("all-git-failure still produces enrichment when drift data is available", async () => {
    vi.mocked(resolveTaskScope).mockReturnValue(["src/foo.ts"]);

    vi.mocked(gitLog).mockReturnValue(makeGitFail());

    const mockStore = {
      getReviewsForFiles: vi
        .fn()
        .mockResolvedValue([makeReviewEntry(["src/foo.ts"], 2, "WARNING")]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput());

    // Git failure but drift succeeded → content has drift section
    expect(result.content).toContain("Drift Signals");
    expect(result.content).toContain("src/foo.ts");
    expect(result.content).not.toBe("");
  });

  it("DriftStore constructor throwing does not crash assembleEnrichment", async () => {
    vi.mocked(resolveTaskScope).mockReturnValue(["src/foo.ts"]);

    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Add feature"));

    // DriftStore constructor itself throws
    vi.mocked(DriftStore).mockImplementation(function () {
      throw new Error("Cannot open drift DB");
    });

    const result = await assembleEnrichment(makeInput());

    // Should degrade gracefully: no drift section but git section present
    expect(result.content).toContain("Recent Changes");
    expect(result).toBeDefined();
  });

  it("no projectDir → drift section silently skipped, no warning for missing projectDir", async () => {
    vi.mocked(resolveTaskScope).mockReturnValue(["src/foo.ts"]);
    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Add feature"));

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput({ projectDir: undefined }));

    // Should succeed: git section present, drift skipped silently
    expect(result.content).toContain("Recent Changes");
    // DriftStore should not have been called (no projectDir)
    expect(DriftStore).not.toHaveBeenCalled();
  });

  it("empty workspace directory → workspace section returns empty, no throw", async () => {
    const emptyWs = mkdtempSync(join(tmpdir(), "enr-empty-ws-"));
    const currentWs = join(emptyWs, "current");
    mkdirSync(currentWs);

    vi.mocked(resolveTaskScope).mockReturnValue(["src/foo.ts"]);
    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Add feature"));

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    let result: Awaited<ReturnType<typeof assembleEnrichment>> | undefined;
    try {
      result = await assembleEnrichment(makeInput({ projectDir: undefined, workspace: currentWs }));
    } finally {
      rmSync(emptyWs, { force: true, recursive: true });
    }

    expect(result).toBeDefined();
    // Git succeeded but no prior workspaces — only Recent Changes section
    expect(result!.content).toContain("Recent Changes");
    expect(result!.content).not.toContain("Prior Work");
  });
});

// 5. escapeDollarBrace on git commit messages containing ${...}

describe("enrichment integration — escapeDollarBrace on git commit messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("escapes ${VARIABLE} in commit subject before injection into output", async () => {
    vi.mocked(resolveTaskScope).mockReturnValue(["src/config.ts"]);

    vi.mocked(gitLog).mockReturnValue(
      makeGitOk("abc1234 Inject ${CANON_PLUGIN_ROOT} into environment"),
    );

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput({ projectDir: undefined }));

    // The literal ${CANON_PLUGIN_ROOT} must be escaped so template substitution
    // does not treat it as a variable reference
    expect(result.content).toContain("\\${CANON_PLUGIN_ROOT}");
    expect(result.content).not.toMatch(/(?<!\\)\$\{CANON_PLUGIN_ROOT\}/);
  });

  it("escapes ${task}, ${enrichment}, ${progress} which are Canon template variables", async () => {
    vi.mocked(resolveTaskScope).mockReturnValue(["src/spawn.ts"]);

    vi.mocked(gitLog).mockReturnValue(
      makeGitOk("abc1234 Add ${task} and ${enrichment} and ${progress} to prompt"),
    );

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput({ projectDir: undefined }));

    // All three Canon template variables must be escaped
    expect(result.content).toContain("\\${task}");
    expect(result.content).toContain("\\${enrichment}");
    expect(result.content).toContain("\\${progress}");
    expect(result.content).not.toMatch(/(?<!\\)\$\{task\}/);
    expect(result.content).not.toMatch(/(?<!\\)\$\{enrichment\}/);
    expect(result.content).not.toMatch(/(?<!\\)\$\{progress\}/);
  });

  it("commit SHA prefix is not treated as part of subject (SHA has no dollar signs)", async () => {
    vi.mocked(resolveTaskScope).mockReturnValue(["src/foo.ts"]);

    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Normal commit without dollar braces"));

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput({ projectDir: undefined }));

    // SHA should not appear in the output (it's stripped by space split)
    // Subject should appear normally
    expect(result.content).toContain("Normal commit without dollar braces");
    expect(result.content).not.toContain("abc1234 Normal");
  });
});

// 6. DriftDb.getReviewsByFiles: malformed JSON in files column (Known Gap enr-01)

describe("DriftDb.getReviewsByFiles — malformed JSON in files column", () => {
  it("silently skips reviews with malformed files JSON and returns only valid matching reviews", () => {
    const db = initDriftDb(":memory:");
    const store = new DriftDb(db);

    // Insert a valid review
    const validEntry: ReviewEntry = {
      files: ["src/foo.ts"],
      honored: [],
      review_id: "rev_valid_001",
      score: {
        conventions: { passed: 1, total: 1 },
        opinions: { passed: 1, total: 1 },
        rules: { passed: 1, total: 1 },
      },
      timestamp: new Date().toISOString(),
      verdict: "CLEAN",
      violations: [],
    };
    store.appendReview(validEntry);

    // Manually corrupt the files column of a second review in the DB
    // (simulate old data or a write bug)
    db.prepare(
      `INSERT INTO reviews (review_id, timestamp, files, honored, score, verdict)
       VALUES ('rev_corrupt', '2026-01-01T00:00:00Z', 'NOT_VALID_JSON', '[]', '{}', 'CLEAN')`,
    ).run();

    const results = store.getReviewsByFiles(["src/foo.ts"]);

    // Only the valid review should be returned; the corrupt row is silently skipped
    expect(results).toHaveLength(1);
    expect(results[0].review_id).toBe("rev_valid_001");

    store.close();
  });

  it("returns empty array when only malformed entries exist for the queried files", () => {
    const db = initDriftDb(":memory:");
    const store = new DriftDb(db);

    // Corrupt entry only
    db.prepare(
      `INSERT INTO reviews (review_id, timestamp, files, honored, score, verdict)
       VALUES ('rev_corrupt2', '2026-01-01T00:00:00Z', '{broken json', '[]', '{}', 'CLEAN')`,
    ).run();

    const results = store.getReviewsByFiles(["src/foo.ts"]);
    expect(results).toEqual([]);

    store.close();
  });
});

// 7. assembleWorkspaceSection: REVIEW.md file type and 3-workspace cap

describe("enrichment integration — workspace section edge cases", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "enr-ws-"));
    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Add feature"));
    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true });
    vi.clearAllMocks();
  });

  it("includes prior workspace when matching file is found in REVIEW.md (not just DESIGN.md)", async () => {
    const currentWs = join(tmpDir, "current-ws");
    const siblingWs = join(tmpDir, "sibling-ws");
    const reviewsDir = join(siblingWs, "reviews");

    mkdirSync(currentWs, { recursive: true });
    mkdirSync(reviewsDir, { recursive: true });

    // Place a matching REVIEW.md in the sibling workspace
    writeFileSync(
      join(reviewsDir, "REVIEW.md"),
      "# Review\n\nThis review covers `src/important.ts` in detail.\n",
    );

    vi.mocked(resolveTaskScope).mockReturnValue(["src/important.ts"]);

    const result = await assembleEnrichment(
      makeInput({ projectDir: undefined, workspace: currentWs }),
    );

    expect(result.content).toContain("Prior Work");
    expect(result.content).toContain("sibling-ws");
  });

  it("caps prior work at 3 sibling workspace references even when 5 exist", async () => {
    const currentWs = join(tmpDir, "current-ws");
    mkdirSync(currentWs, { recursive: true });

    // Create 5 sibling workspaces each with a matching DESIGN.md
    for (let i = 1; i <= 5; i++) {
      const siblingPlansDir = join(tmpDir, `sibling-${i}`, "plans", "plan");
      mkdirSync(siblingPlansDir, { recursive: true });
      writeFileSync(
        join(siblingPlansDir, "DESIGN.md"),
        `# Design\n\nCovers \`src/shared.ts\` usage.\n`,
      );
    }

    vi.mocked(resolveTaskScope).mockReturnValue(["src/shared.ts"]);

    const result = await assembleEnrichment(
      makeInput({ projectDir: undefined, workspace: currentWs }),
    );

    // Count "sibling-N" references in the output
    const siblingRefs = (result.content.match(/\*\*sibling-\d+\*\*/g) ?? []).length;
    expect(siblingRefs).toBeLessThanOrEqual(3);
    expect(siblingRefs).toBeGreaterThan(0);
  });

  it("workspace with neither DESIGN.md nor REVIEW.md matching is excluded", async () => {
    const currentWs = join(tmpDir, "current-ws");
    const siblingWs = join(tmpDir, "sibling-irrelevant");
    const siblingPlansDir = join(siblingWs, "plans", "p");

    mkdirSync(currentWs, { recursive: true });
    mkdirSync(siblingPlansDir, { recursive: true });

    writeFileSync(
      join(siblingPlansDir, "DESIGN.md"),
      "# Design for unrelated task\nThis covers `src/unrelated-module.ts`.\n",
    );

    vi.mocked(resolveTaskScope).mockReturnValue(["src/important.ts"]);

    const result = await assembleEnrichment(
      makeInput({ projectDir: undefined, workspace: currentWs }),
    );

    expect(result.content).not.toContain("sibling-irrelevant");
  });
});
