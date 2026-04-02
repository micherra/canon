/**
 * Context Enrichment Tests (strict TDD — tests written before implementation)
 *
 * Covers done criteria:
 *   dc-01: git history + drift signals + prior work sections all appear
 *   dc-02: tensions section generated when drift violations + recent commits overlap
 *   dc-03: tier cap (5 hotfix) and total char cap (6000)
 *   dc-04: graceful degradation when sources unavailable
 *   dc-05: escapeDollarBrace applied to git output
 *
 * Additional:
 *   - Tensions absent when no drift violations
 *   - Budget enforcement: output truncated with [truncated] marker
 *   - Empty scope: returns empty content with warning
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Board, ResolvedFlow } from "../flow-schema.ts";

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted to top of file
// ---------------------------------------------------------------------------

vi.mock("../../adapters/git-adapter.ts", () => ({
  gitLog: vi.fn(),
}));

vi.mock("../../drift/store.ts", () => ({
  // biome-ignore lint/complexity/useArrowFunction: constructor mock requires function() for `new` binding
  DriftStore: vi.fn(function () {
    return { getReviewsForFiles: vi.fn().mockResolvedValue([]) };
  }),
}));

vi.mock("../scope-resolver.ts", () => ({
  resolveTaskScope: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { gitLog } from "../../adapters/git-adapter.ts";
import { DriftStore } from "../../drift/store.ts";
import { assembleEnrichment, type EnrichmentInput } from "../context-enrichment.ts";
import { resolveTaskScope } from "../scope-resolver.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBoard(overrides: Partial<Board> = {}): Board {
  return {
    flow: "build",
    task: "Test task",
    entry: "implement",
    current_state: "implement",
    base_commit: "abc123",
    started: new Date().toISOString(),
    last_updated: new Date().toISOString(),
    states: {},
    iterations: {},
    blocked: null,
    concerns: [],
    skipped: [],
    ...overrides,
  };
}

function makeFlow(tier = "feature"): ResolvedFlow {
  return {
    name: "build",
    tier,
    description: "Build flow",
    entry: "implement",
    params: {},
    states: {
      implement: {
        type: "single",
        spawn: { agent: "canon-implementor", prompt: "implement" },
        transitions: { done: "terminal" },
      },
      terminal: {
        type: "terminal",
      },
    },
  } as unknown as ResolvedFlow;
}

function makeInput(overrides: Partial<EnrichmentInput> = {}): EnrichmentInput {
  return {
    workspace: "/tmp/workspace",
    stateId: "implement",
    board: makeBoard(),
    flow: makeFlow(),
    cwd: "/tmp/project",
    projectDir: "/tmp/project",
    ...overrides,
  };
}

function makeGitOk(stdout: string) {
  return { ok: true, stdout, stderr: "", exitCode: 0, timedOut: false, duration_ms: 20 };
}

function makeGitFail() {
  return { ok: false, stdout: "", stderr: "fatal: not a git repo", exitCode: 128, timedOut: false, duration_ms: 5 };
}

function makeReviewEntry(files: string[], violationCount = 0, verdict: "BLOCKING" | "WARNING" | "CLEAN" = "CLEAN") {
  return {
    review_id: "rev_test_1",
    timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(), // 2 days ago
    files,
    violations: Array.from({ length: violationCount }, (_, i) => ({
      principle_id: `principle-${i}`,
      severity: "rule",
      file_path: files[0],
      message: `Violation ${i}`,
    })),
    honored: [],
    score: { rules: { passed: 0, total: 1 }, opinions: { passed: 1, total: 1 }, conventions: { passed: 1, total: 1 } },
    verdict,
  };
}

// ---------------------------------------------------------------------------
// Tests: dc-04 — Empty scope → graceful degradation
// ---------------------------------------------------------------------------

describe("assembleEnrichment — empty scope", () => {
  beforeEach(() => {
    vi.mocked(resolveTaskScope).mockReturnValue([]);
  });

  it("returns empty content and warning when no task scope found", async () => {
    const result = await assembleEnrichment(makeInput());
    expect(result.content).toBe("");
    expect(result.warnings).toContain("enrichment: no task scope found");
  });
});

// ---------------------------------------------------------------------------
// Tests: dc-01 — All three sections present
// ---------------------------------------------------------------------------

describe("assembleEnrichment — dc-01: all sections present", () => {
  beforeEach(() => {
    vi.mocked(resolveTaskScope).mockReturnValue(["src/foo.ts", "src/bar.ts"]);

    // Git returns commit history for each file
    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Add feature\nbcd2345 Fix bug\ncde3456 Initial commit"));

    // Drift returns a review with no violations
    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([makeReviewEntry(["src/foo.ts", "src/bar.ts"])]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });
  });

  it("output contains Recent Changes section (git)", async () => {
    const result = await assembleEnrichment(makeInput());
    expect(result.content).toContain("Recent Changes");
    expect(result.content).toContain("src/foo.ts");
  });

  it("output contains Drift Signals section", async () => {
    const result = await assembleEnrichment(makeInput());
    expect(result.content).toContain("Drift Signals");
    expect(result.content).toContain("CLEAN");
  });

  it("output starts with ## Context Enrichment heading", async () => {
    const result = await assembleEnrichment(makeInput());
    expect(result.content.trim()).toMatch(/^## Context Enrichment/);
  });
});

// ---------------------------------------------------------------------------
// Tests: dc-03 — Tier cap and total char cap
// ---------------------------------------------------------------------------

describe("assembleEnrichment — dc-03: tier and char caps", () => {
  it("hotfix tier caps file entries at 5 even with 50 files", async () => {
    const fiftyFiles = Array.from({ length: 50 }, (_, i) => `src/file-${i}.ts`);
    vi.mocked(resolveTaskScope).mockReturnValue(fiftyFiles);

    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Add feature"));

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput({ flow: makeFlow("hotfix") }));

    // Count how many unique file-N entries appear — should be at most 5
    const fileMatches = result.content.match(/`src\/file-\d+\.ts`/g) ?? [];
    const uniqueFiles = new Set(fileMatches);
    expect(uniqueFiles.size).toBeLessThanOrEqual(5);
  });

  it("total output does not exceed 6000 chars", async () => {
    const files = Array.from({ length: 30 }, (_, i) => `src/file-${i}.ts`);
    vi.mocked(resolveTaskScope).mockReturnValue(files);

    // Return lots of git output per file to stress budget
    const longCommitMsg = "x".repeat(200);
    vi.mocked(gitLog).mockReturnValue(
      makeGitOk(Array.from({ length: 5 }, (_, i) => `sha${i} ${longCommitMsg}`).join("\n")),
    );

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([makeReviewEntry(files, 3)]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput({ flow: makeFlow("epic") }));

    expect(result.content.length).toBeLessThanOrEqual(6000);
  });

  it("adds [truncated] marker when content exceeds 6000 chars", async () => {
    const files = Array.from({ length: 30 }, (_, i) => `src/file-${i}.ts`);
    vi.mocked(resolveTaskScope).mockReturnValue(files);

    // Very long output per file
    vi.mocked(gitLog).mockReturnValue(
      makeGitOk(Array.from({ length: 5 }, (_, i) => `sha${i} ${"very long commit message ".repeat(20)}`).join("\n")),
    );

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([makeReviewEntry(files, 5)]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput({ flow: makeFlow("epic") }));

    // If truncated, should have the marker
    if (result.content.length >= 6000 - 15) {
      expect(result.content).toContain("[truncated]");
    }
    expect(result.content.length).toBeLessThanOrEqual(6000);
  });
});

// ---------------------------------------------------------------------------
// Tests: dc-04 — Graceful degradation when sources unavailable
// ---------------------------------------------------------------------------

describe("assembleEnrichment — dc-04: graceful degradation", () => {
  beforeEach(() => {
    vi.mocked(resolveTaskScope).mockReturnValue(["src/foo.ts"]);
  });

  it("returns empty content with warning when git fails, no drift, no workspaces", async () => {
    vi.mocked(gitLog).mockReturnValue(makeGitFail());

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput({ projectDir: undefined }));

    // Should not throw; should have warnings but no error
    expect(result.warnings.length).toBeGreaterThan(0);
    // Content should be empty string or missing sections
    // (no git, no drift, no workspaces → empty or only heading)
  });

  it("does not throw when DriftStore throws", async () => {
    vi.mocked(gitLog).mockReturnValue(makeGitFail());

    const mockStore = {
      getReviewsForFiles: vi.fn().mockRejectedValue(new Error("DB not found")),
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    await expect(assembleEnrichment(makeInput())).resolves.toBeDefined();
  });

  it("does not throw when git fails", async () => {
    vi.mocked(gitLog).mockReturnValue(makeGitFail());

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput());
    expect(result).toBeDefined();
    expect(result.warnings.some((w) => w.includes("git"))).toBe(true);
  });

  it("returns empty content when git fails and no other sources produce data", async () => {
    vi.mocked(gitLog).mockReturnValue(makeGitFail());

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput({ projectDir: undefined }));
    // All sections fail/empty → content should be empty string
    expect(result.content).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Tests: dc-05 — escapeDollarBrace applied to git output
// ---------------------------------------------------------------------------

describe("assembleEnrichment — dc-05: dollar-brace escaping", () => {
  beforeEach(() => {
    vi.mocked(resolveTaskScope).mockReturnValue(["src/foo.ts"]);
  });

  it("escapes ${foo} in git commit messages", async () => {
    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Refactor ${foo} config injection"));

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput());

    // After escaping, content should have \${foo} (backslash before ${)
    // and NOT have an unescaped ${foo} (i.e., no $ followed by { not preceded by \)
    expect(result.content).toContain("\\${foo}");
    // Unescaped ${foo} should not appear (regex: $ not preceded by \)
    expect(result.content).not.toMatch(/(?<!\\)\$\{foo\}/);
  });

  it("escapes multiple ${var} patterns in git output", async () => {
    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Replace ${bar} and ${baz} in template"));

    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput());

    expect(result.content).toContain("\\${bar}");
    expect(result.content).toContain("\\${baz}");
    // Unescaped patterns should not appear
    expect(result.content).not.toMatch(/(?<!\\)\$\{bar\}/);
    expect(result.content).not.toMatch(/(?<!\\)\$\{baz\}/);
  });
});

// ---------------------------------------------------------------------------
// Tests: dc-02 — Tensions section
// ---------------------------------------------------------------------------

describe("assembleEnrichment — dc-02: tensions section", () => {
  it("tensions section non-empty when file has drift violations AND recent commits", async () => {
    vi.mocked(resolveTaskScope).mockReturnValue(["src/foo.ts"]);

    // Git succeeds for this file (recent commits)
    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Fix bug\nbcd2345 Another fix"));

    // Drift has violations for the same file
    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([
        makeReviewEntry(["src/foo.ts"], 2), // 2 violations
      ]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput());

    expect(result.content).toContain("Tensions");
    expect(result.content).toContain("src/foo.ts");
  });

  it("tensions section absent when no drift violations", async () => {
    vi.mocked(resolveTaskScope).mockReturnValue(["src/foo.ts"]);

    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Fix bug"));

    // No violations
    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([
        makeReviewEntry(["src/foo.ts"], 0), // clean
      ]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput());

    expect(result.content).not.toContain("Tensions");
  });

  it("tensions section absent when git fails (no recent commits data)", async () => {
    vi.mocked(resolveTaskScope).mockReturnValue(["src/foo.ts"]);

    vi.mocked(gitLog).mockReturnValue(makeGitFail());

    // Has violations but git failed
    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([makeReviewEntry(["src/foo.ts"], 3)]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput());

    expect(result.content).not.toContain("Tensions");
  });

  it("caps tensions at 3 entries", async () => {
    const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"];
    vi.mocked(resolveTaskScope).mockReturnValue(files);

    // All files have recent commits
    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Fix bug"));

    // All files have violations
    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([makeReviewEntry(files, 2)]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });

    const result = await assembleEnrichment(makeInput());

    // Count tension entries (lines starting with "- **`")
    const tensionLines = result.content.split("\n").filter((line) => line.match(/^- \*\*`/));
    expect(tensionLines.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Tests: Prior Work section
// ---------------------------------------------------------------------------

describe("assembleEnrichment — prior work section", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "enr-test-"));
    vi.mocked(resolveTaskScope).mockReturnValue(["src/foo.ts"]);
    vi.mocked(gitLog).mockReturnValue(makeGitOk("abc1234 Fix bug"));
    const mockStore = {
      getReviewsForFiles: vi.fn().mockResolvedValue([]),
    };
    // biome-ignore lint/suspicious/noExplicitAny: partial mock for test
    vi.mocked(DriftStore).mockImplementation(function () {
      return mockStore as any;
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("includes prior workspace when its DESIGN.md mentions a file in scope", async () => {
    // Create sibling workspace structure:
    // tmpDir/
    //   current-ws/    ← our workspace
    //   sibling-ws/
    //     plans/
    //       some-plan/
    //         DESIGN.md   ← mentions src/foo.ts
    const branchDir = tmpDir;
    const currentWs = join(branchDir, "current-ws");
    const siblingWs = join(branchDir, "sibling-ws");
    const siblingPlansDir = join(siblingWs, "plans", "some-plan");

    mkdirSync(currentWs, { recursive: true });
    mkdirSync(siblingPlansDir, { recursive: true });
    writeFileSync(
      join(siblingPlansDir, "DESIGN.md"),
      "## Design\n\nThis design covers `src/foo.ts` and its dependencies.\n",
    );

    const result = await assembleEnrichment(makeInput({ workspace: currentWs }));

    expect(result.content).toContain("Prior Work");
    expect(result.content).toContain("sibling-ws");
  });

  it("does not include prior workspace when its DESIGN.md does not mention any scoped file", async () => {
    const branchDir = tmpDir;
    const currentWs = join(branchDir, "current-ws");
    const siblingWs = join(branchDir, "sibling-ws");
    const siblingPlansDir = join(siblingWs, "plans", "some-plan");

    mkdirSync(currentWs, { recursive: true });
    mkdirSync(siblingPlansDir, { recursive: true });
    writeFileSync(join(siblingPlansDir, "DESIGN.md"), "## Design\n\nThis is about `src/unrelated.ts`.\n");

    const result = await assembleEnrichment(makeInput({ workspace: currentWs }));

    expect(result.content).not.toContain("sibling-ws");
  });
});
